# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mioand88-collab/gta6-trophy-rarity-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mioand88-collab/gta6-trophy-rarity-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

<sub>Entered on [make.fun](https://make.fun/?ref=r2sxe3g2&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>

Forecasts every Grand Theft Auto VI PlayStation 5 trophy's earn rate on
[Exophase](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/)
at 2026-11-26T00:00:00Z, as five quantiles (5%, 25%, 50%, 75%, 95%) per
trophy, for make.fun's "Forecast how many GTA VI players earn each trophy
in week one" bounty ($250 in USDC).

## The model

`main.ts` (Node 22, standard library only) works entirely on the logit
scale, with rates clamped to [0.01, 99.99] before the logit and null reads
skipped. For each trophy it:

1. **Fits a trend.** Least squares of logit(earn rate) against log-time
   (x = ln(1 + hours since the first read)) over the case history, falling
   back to the last observed rate with fewer than 3 usable reads.
2. **Projects it, damped.** The fitted slope is applied from the last
   observed rate (never the line's absolute level, so a curving trend can't
   jump the forecast away from the freshest read), and only a fraction
   `1 / (1 + horizon_days / 1.5)` of the log-time gap beyond the last read
   is travelled — a short-run slope is never extrapolated linearly for
   4.5 days. The total median move is capped at 2.5 logit units.
3. **Spreads honestly.** The spread combines, in quadrature, a random-walk
   term `0.5 * sqrt(days)`, the fit's residual volatility, the standard
   error of the fitted value at the projected point (slope uncertainty,
   growing with projection leverage), a 0.35 logit floor, and a wide
   1.15 logit term when the whole history is flat. That last term matters:
   Exophase refreshes its counts on its own schedule, so a page that has
   not moved all night can jump at the next refresh — the practice cases
   straddle exactly such a refresh, and a flat history must not mean a
   narrow band. Quantiles come from the normal z-scores
   (-1.645, -0.674, 0, 0.674, 1.645).

The house baseline (persistence plus a `0.5 * sqrt(days)` random-walk band)
scores about 1.51 on the practice cases because the refresh takes every
rate outside its narrow 90-minute band. This entry keeps the same medians
on the flat practice histories but widens the 90% band roughly tenfold on
the logit scale (about 3.9 vs 0.4), so a refresh of the size Exophase
showed on launch night lands inside it.

The program is fully deterministic (least squares only, no randomness) and
runs in ~0.2 s per case, well inside the 8-second cap.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` case file in the input directory and writes one
`<id>.out` JSON file per case (`{"trophies": [{"id": n, "q": [q05, q25,
q50, q75, q95]}, ...]}`) to the output directory. In the grader's
container it reads `/input` and writes `/output` instead.
