// GTA VI trophy rarity forecaster — make.fun gta6-trophy-rarity-forecast-01.
// Node 22, standard library only. Run once per case: reads every *.in file in
// $MAKEFUN_INPUT_DIR (else /input) and writes one /output/<id>.out per case.
//
// Model, per trophy (all work on the logit scale, rates clamped to [0.01, 99.99]
// before the logit, null reads skipped):
//   1. Fit logit(rate) against log-time by least squares over the case history
//      (x = ln(1 + hours since the first read)). Fewer than 3 usable reads, or
//      no spread in x, falls back to the last observed rate.
//   2. Project the fitted line to the target, but damp the slope over the
//      horizon: only a fraction 1 / (1 + horizon_days / 1.5) of the log-time gap
//      beyond the last read is travelled, so a short-run slope is never
//      extrapolated linearly for 4.5 days. The total median move is capped at
//      2.5 logit units from the last rate.
//   3. Spread: a random-walk term 0.5 * sqrt(days) combined (in quadrature)
//      with the fit's residual volatility, the standard error of the fitted
//      value at the projected point (slope uncertainty, growing with the
//      projection's leverage), a 0.35 logit floor, and a wide
//      1.15 logit term when the whole history is flat. A flat history must NOT
//      mean a narrow band: Exophase refreshes its counts on its own schedule,
//      so a page that has not moved all night can jump at the next refresh
//      (the practice cases straddle exactly such a refresh).
//   4. Quantiles from the normal z-scores (-1.645, -0.674, 0, 0.674, 1.645).
// Deterministic: least squares only, no randomness anywhere.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z_SCORES = [-1.645, -0.674, 0, 0.674, 1.645];
const RW_SIGMA_PER_SQRT_DAY = 0.5; // random-walk spread, logit units / sqrt(day)
const SPREAD_FLOOR = 0.35; // logit units: minimum honest uncertainty
const FLAT_HISTORY_SIGMA = 1.15; // extra spread when the history never moved
const DAMP_HALF_LIFE_DAYS = 1.5; // slope damping scale over the horizon
const MAX_MEDIAN_MOVE = 2.5; // logit units from the last rate, at most
const MIN_SIGMA = 0.45;
const MAX_SIGMA = 3.0;

interface TrophyMeta {
  id: number;
}
interface HistoryRead {
  at: string;
  slot?: string;
  rates: Array<number | null>;
}
interface CaseFile {
  id: string;
  at: string;
  target?: string;
  horizon_minutes: number;
  levels: number[];
  trophies: TrophyMeta[];
  history: HistoryRead[];
}

const clampRate = (pct: number): number =>
  Math.min(99.99, Math.max(0.01, pct));
const toLogit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const minutesBetween = (a: string, b: string): number =>
  (Date.parse(b) - Date.parse(a)) / 60000;

/** Least-squares line y = a + b*x. Returns null when x has no spread. */
function fitLine(
  xs: number[],
  ys: number[],
): {
  a: number;
  b: number;
  residSd: number;
  xMean: number;
  sxx: number;
} | null {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    sse += r * r;
  }
  const residSd = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  const xMean = sx / n;
  let dev = 0;
  for (let i = 0; i < n; i++) dev += (xs[i] - xMean) * (xs[i] - xMean);
  return { a, b, residSd, xMean, sxx: dev };
}

/** Forecast one trophy's five quantiles (percent) at the case target. */
function forecastTrophy(
  caseFile: CaseFile,
  trophyIndex: number,
  firstReadAt: string,
  targetAt: string,
): number[] {
  const days = caseFile.horizon_minutes / 1440;
  const points: Array<{ x: number; y: number }> = [];
  let lastLogit: number | null = null;
  for (const read of caseFile.history) {
    const rate = read.rates[trophyIndex];
    if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
    const mins = minutesBetween(firstReadAt, read.at);
    if (!Number.isFinite(mins) || mins < 0) continue;
    const y = toLogit(rate);
    points.push({ x: Math.log1p(mins / 60), y });
    lastLogit = y;
  }
  if (points.length === 0 || lastLogit === null) {
    // No usable read at all: a neutral 50% median with the widest spread.
    return Z_SCORES.map((z) => round4(fromLogit(z * MAX_SIGMA)));
  }

  const flat =
    points.reduce((m, p) => Math.max(m, p.y), -Infinity) -
      points.reduce((m, p) => Math.min(m, p.y), Infinity) <
    0.02;

  let medianLogit = lastLogit;
  let residSd = 0;
  let slopeUncertainty = 0;
  const targetX = Math.log1p(
    Math.max(0, minutesBetween(firstReadAt, targetAt)) / 60,
  );
  if (points.length >= 3) {
    const fit = fitLine(
      points.map((p) => p.x),
      points.map((p) => p.y),
    );
    if (fit !== null) {
      residSd = Math.min(fit.residSd, 2.5);
      const lastX = points[points.length - 1].x;
      const damp = 1 / (1 + days / DAMP_HALF_LIFE_DAYS);
      const projectedX = lastX + Math.max(0, targetX - lastX) * damp;
      // Anchor the projection on the last observed rate and apply only the
      // fitted slope from there: the line's absolute level can sit away
      // from the freshest read when the trend curves in log-time, and the
      // last read is the best-known state of the page.
      const projected = lastLogit + fit.b * (projectedX - lastX);
      const move = Math.max(
        -MAX_MEDIAN_MOVE,
        Math.min(MAX_MEDIAN_MOVE, projected - lastLogit),
      );
      medianLogit = lastLogit + move;
      // Standard error of the fitted value at the projected point: the
      // further the projection travels from the data's centre, the less
      // the line itself can be trusted.
      if (fit.sxx > 1e-12) {
        const lever =
          1 / points.length +
          ((projectedX - fit.xMean) * (projectedX - fit.xMean)) / fit.sxx;
        slopeUncertainty = Math.min(2.5, residSd * Math.sqrt(lever));
      }
    }
  }

  const randomWalk = RW_SIGMA_PER_SQRT_DAY * Math.sqrt(days);
  const flatTerm = flat ? FLAT_HISTORY_SIGMA : 0;
  let sigma = Math.sqrt(
    randomWalk * randomWalk +
      residSd * residSd +
      slopeUncertainty * slopeUncertainty +
      SPREAD_FLOOR * SPREAD_FLOOR +
      flatTerm * flatTerm,
  );
  sigma = Math.min(MAX_SIGMA, Math.max(MIN_SIGMA, sigma));

  const qs = Z_SCORES.map((z) =>
    round4(Math.min(100, Math.max(0, fromLogit(medianLogit + z * sigma)))),
  );
  // Keep the row non-decreasing after rounding (equal values are allowed).
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
}

function runCase(file: string): void {
  const caseFile = JSON.parse(
    readFileSync(join(INPUT_DIR, file), "utf8"),
  ) as CaseFile;
  if (
    caseFile.levels.length !== LEVELS.length ||
    caseFile.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(
      `${file} asks for levels ${JSON.stringify(caseFile.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  if (caseFile.history.length === 0) {
    throw new Error(`${file} has no history`);
  }
  const firstReadAt = caseFile.history[0].at;
  const targetAt =
    caseFile.target ??
    new Date(
      Date.parse(caseFile.at) + caseFile.horizon_minutes * 60000,
    ).toISOString();
  const trophies = caseFile.trophies.map((t, i) => ({
    id: t.id,
    q: forecastTrophy(caseFile, i, firstReadAt, targetAt),
  }));
  const id = file.slice(0, -".in".length);
  writeFileSync(
    join(OUTPUT_DIR, `${id}.out`),
    `${JSON.stringify({ trophies })}\n`,
  );
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith(".in"))
  .sort();
for (const file of inputs) runCase(file);
