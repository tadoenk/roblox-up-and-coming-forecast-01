# Calibrated ensemble forecast for Roblox's Up-and-Coming chart

**Owner:** Tadoenk
**Referral code:** pn0h53j2
**Repository:** tadoenk/roblox-up-and-coming-forecast-01
**Bounty:** https://make.fun/bounty/roblox-up-and-coming-forecast-01

## What it does

A program that forecasts Roblox's Up-and-Coming chart, place by place, for the
72 hours after entries close. It reads `/input/history.ndjson` (every read of
the chart, oldest first) and `/input/task.json`, and writes one forecast to
`/output/forecast.json`: for each of the top 10 places, a probability for each
game it names being at that place, plus its top 10 in order. That one forecast
is scored against every hourly read of the 72-hour window, by log score, so it
has to be honest about how much the chart moves.

## The model: a calibrated two-model ensemble

The chart is the sort "up-and-coming": the top experiences published in the
last 28 days, sorted by user growth. It moves fast: in the history's pairs of
consecutive reads the top 10 changed in almost all of them. Two models with
different views of that movement are fitted and blended 50/50:

- **Component A — rank momentum (mass 0.75).** For each game, its rank
  velocity: the change in its rank per hour over the last 48 hours of history,
  shrunk by 0.6 toward zero (the endpoint estimate uses only the first and
  last reads of the window, so it is noisy and overshoots). A game's predicted
  rank at horizon h is its current rank plus the shrunk velocity times h,
  clamped to 1..100; the forecast averages a Gaussian kernel (sigma 5 places)
  around that prediction over horizons 0, 12, 24, 48 and 72 hours, weighted
  short-heavy (2.0, 1.5, 1.0, 0.5, 0.25). Candidates are the current top 40
  plus any game improving faster than 0.3 ranks an hour.
- **Component B — ridge-regression feature model (mass 0.90).** Fitted on the
  history itself at run time. For every ordered pair of reads (lag up to
  96 hours) and every game present at the start read, five features — current
  rank, rank velocity (least-squares over 48 hours), log player count,
  log-player-count slope, and rank standard deviation — predict the end rank,
  with lag interaction terms and recency weights (half-life 120 hours). The
  predictive spread grows with horizon, sigma(h) = (c0 + c1 * sqrt(h)) * 0.55,
  with c0 and c1 fitted from the model's own binned residuals. Each game's
  kernel weight is discounted by an empirical exit rate: how often games at
  its rank are absent from the chart altogether at that lag. Marginals are a
  Gaussian kernel around the predicted rank, mixed uniformly over horizons
  1 to 72 hours. The feature study behind this component: over all history
  pairs, rank now correlates with rank at +24 h at Spearman +0.76, player
  level -0.34 and player slope -0.26 — signals the momentum model ignores.

The blend averages the two models' probabilities per game and place and
drops rows below 0.0001, so each place names about 0.825 of its mass and
leaves the rest unnamed — the hedge for the games nobody can name (in the
practice window, three of the eventual top-10 games, including the #1 for
the last three reads, appear nowhere in the preceding history at all).

One more rule is applied when the data supports it: the chart only lists
games published within the last 28 days, so when the last read's details
give a game's creation date and it ages past 28 days inside the window,
that game's weight is zeroed for the horizons after its exit. On inputs
without details (the practice history) this is a no-op.

The top 10 is ranked by summed blended probability — each game's overall
chance of holding a top-10 place — filled out from the closing chart order.

## Backtest

Scored with the competition's own scorer on the practice instance (the
34-read kit history, scored on the practice window after it) and on
walk-forward cutoffs inside the archive (history truncated at 20–32 reads,
scored on the reads that follow):

| model | walk-forward mean | practice window |
|-------|-------------------|-----------------|
| house persistence baseline | -50.58 | -43.51 |
| previous version (momentum only) | -39.59 | -36.01 |
| this ensemble | **-38.99** | **-35.08** |

The ensemble beats the previous version on 7 of the 8 fixtures and the
house baseline on all of them; on the practice window its top 10 scores
7.3 hits and 52.3 agreement points against the previous version's 5.9
and 44.1. Full diagnosis: V3_NOTES.md.

## Run

```bash
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only. Deterministic: no clock, no environment
beyond the input/output dir variables, no randomness.
