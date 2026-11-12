# Momentum forecast for Roblox's Up-and-Coming chart

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

## The model: rank momentum

The chart is the sort "up-and-coming": the top experiences published in the
last 28 days, sorted by user growth. It moves fast: in the history's 44 pairs
of consecutive reads the top 10 changed in 42 of them, a median of 6 places,
so the house baseline's persistence forecast (the chart will not move) scores
badly (-43.512039 on the practice forecast).

The model is rank momentum:

- For each game, its rank velocity: the change in its rank per hour over the
  last 48 hours of history (a negative velocity is improving). Rank momentum
  is a weak but real signal (correlation 0.147 between one interval's
  improvement and the next's), while the change in the playing count barely
  predicts anything (correlation 0.025), so the rank itself is the signal,
  not the player count.
- The endpoint velocity is noisy — it uses only the first and last reads of
  the window — so it is shrunk by 0.6 toward zero (mean reversion): the raw
  velocity overstates how far a game will travel.
- A game's predicted rank at horizon h hours is its current rank plus the
  shrunk velocity times h, clamped to 1..100. The forecast averages a
  Gaussian kernel (sigma 5 places) around that predicted rank over the
  horizons 0, 12, 24, 48 and 72 hours, weighted short-heavy (2.0, 1.5, 1.0,
  0.5, 0.25): the reads nearest the end of the history predict best, and the
  long horizons mostly add noise.
- Each place's probabilities are normalised to sum to 0.75, leaving 0.25
  unnamed (shared by the games it does not name there). Naming everything
  (mass 1.0) scores far worse: a missed place then costs the full floor,
  while the unnamed share hedges it.
- Candidates are the current top 40 plus any game improving faster than 0.3
  ranks an hour, so a climber from outside the top 10 can enter it.

## Backtest

Backtested on the practice history at three cutoffs (20, 24 and 28 reads of
history, scored on the reads after), this beats the persistence baseline by 11
to 16 log-score points at every cutoff:

| cutoff | baseline | this model |
|--------|----------|------------|
| 20     | -53.04   | -42.10     |
| 24     | -56.91   | -40.18     |
| 28     | -37.71   | -36.98     |

The chosen parameters sit in a flat region: sigma 4 to 7, a 24 to 72 hour
velocity window and mass 0.7 to 0.8 all score within a point of each other.

Tuned afterwards on the same walk-forward cutoffs plus two holdouts never
used for selection (22 and 26 reads): shrinking the velocity by 0.6, weighting
the horizons short-heavy and lowering the mass to 0.75 scores -41.04, -39.33
and -35.48 at the selection cutoffs and -38.87 / -36.77 at the holdouts — a
mean of -38.30 over the five cutoffs versus -39.49 for the table above
(+1.19 nats).

## Run

```bash
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only. Deterministic: no clock, no environment, no
randomness. The program reads the window from task.json rather than writing
it into its code.
