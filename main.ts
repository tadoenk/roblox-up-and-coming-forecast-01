// roblox-up-and-coming-forecast-01 entry: a momentum forecaster for Roblox's
// Up-and-Coming chart. It reads /input/history.ndjson (every read of the
// chart, oldest first) and /input/task.json, and writes one forecast to
// /output/forecast.json: for each of the top 10 places, a probability for
// each game it names being at that place, and its top 10 in order. That one
// forecast is scored against every hourly read of the 72-hour window after
// entries close, by log score, so it has to be honest about how much the
// chart moves.
//
// The chart is the sort "up-and-coming": the top experiences published in
// the last 28 days, sorted by user growth. It moves fast: in the history's
// 44 pairs of consecutive reads the top 10 changed in 42 of them, a median
// of 6 places, so the house baseline's persistence forecast (the chart will
// not move) scores badly. The model here is rank momentum:
//
//   - For each game, its rank velocity: the change in its rank per hour
//     over the last 48 hours of history (a negative velocity is improving).
//     Rank momentum is a weak but real signal (correlation 0.147 between
//     one interval's improvement and the next's), while the change in the
//     playing count barely predicts anything (correlation 0.025), so the
//     rank itself is the signal, not the player count.
//   - The endpoint velocity is noisy — it uses only the first and last
//     reads of the window — so it is shrunk by 0.6 toward zero (mean
//     reversion): the raw velocity overstates how far a game will travel.
//   - A game's predicted rank at horizon h hours is its current rank plus
//     the shrunk velocity times h, clamped to 1..100. The forecast averages
//     a Gaussian kernel (sigma 5 places) around that predicted rank over
//     the horizons 0, 12, 24, 48 and 72 hours, so a game near a place gets
//     most of that place's probability and the spread grows with the
//     horizon. The horizons are weighted short-heavy (2.0, 1.5, 1.0, 0.5,
//     0.25): the reads nearest the history's end are the ones the forecast
//     predicts best, and the long horizons mostly add noise.
//   - Each place's probabilities are normalised to sum to 0.75, leaving
//     0.25 unnamed (shared by the games it does not name there). Naming
//     everything (mass 1.0) scores far worse: a missed place then costs the
//     full floor, while the unnamed share hedges it.
//   - Candidates are the current top 40 plus any game improving faster than
//     0.3 ranks an hour, so a climber from outside the top 10 can enter it.
//     Widening the candidates hurts: top 60 and top 100 score far worse,
//     because the mass spreads over games that never reach the top 10.
//
// Tuned on the practice history (walk-forward cutoffs of 20/24/28 reads of
// history, scored on the reads after; the harness reproduces the submitted
// entry's scores -42.10/-40.18/-36.98 exactly). This version scores
// -41.04/-39.33/-35.48 at those cutoffs, and also improves at two holdout
// cutoffs never used for selection (22: -38.87 vs -40.27; 26: -36.77 vs
// -37.90), so the gain is not fitted to the three cutoffs. Mean over five
// cutoffs: -38.30 vs -39.49 for the submitted entry (+1.19 nats).
//
// Deterministic: no clock, no environment, no randomness. Node 22 standard
// library only.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const SIGMA = 5.0;
const VELOCITY_HOURS = 48;
const HORIZONS = [0, 12, 24, 48, 72];
const HORIZON_WEIGHTS = [2.0, 1.5, 1.0, 0.5, 0.25];
const VEL_SHRINK = 0.6;
const TOTAL_MASS = 0.75;
const CANDIDATE_TOP = 40;
const FAST_IMPROVE = -0.3;

interface ChartGame {
  rank: number;
  universe_id: number;
}
interface Read {
  at: string;
  up_and_coming: ChartGame[];
}

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places: number;
  output: string;
};
const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l !== '');
const reads = lines.map((l) => JSON.parse(l) as Read);
const last = reads[reads.length - 1]!;
const chart = [...last.up_and_coming].sort((a, b) => a.rank - b.rank);
const chartIds = chart.map((g) => g.universe_id);

// The last read's time, in milliseconds, for the velocity window.
const tEnd = Date.parse(last.at);

// Each game's rank history: (time, rank) pairs.
const rankHistory = new Map<number, [number, number][]>();
for (const read of reads) {
  const t = Date.parse(read.at);
  for (const game of read.up_and_coming) {
    const list = rankHistory.get(game.universe_id) ?? [];
    list.push([t, game.rank]);
    rankHistory.set(game.universe_id, list);
  }
}

/**
 * A game's rank change per hour over the last VELOCITY_HOURS, shrunk by
 * VEL_SHRINK toward zero: the endpoint estimate is noisy, and unshrunk
 * velocities overshoot the rank a game actually reaches.
 */
function velocity(uid: number): number {
  const pts = [...(rankHistory.get(uid) ?? [])].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return 0;
  const recent = pts.filter(([t]) => t >= tEnd - VELOCITY_HOURS * 3600 * 1000);
  const use = recent.length >= 2 ? recent : pts.slice(-2);
  const [t0, r0] = use[0]!;
  const [t1, r1] = use[use.length - 1]!;
  const dt = (t1 - t0) / 3600000;
  return dt > 0 ? ((r1 - r0) / dt) * VEL_SHRINK : 0;
}

const currentRank = new Map<number, number>();
for (const game of chart) currentRank.set(game.universe_id, game.rank);

const candidates = new Set<number>(chartIds.slice(0, CANDIDATE_TOP));
for (const uid of rankHistory.keys()) {
  if (velocity(uid) < FAST_IMPROVE) candidates.add(uid);
}

interface ProbRow {
  universe_id: number;
  place: number;
  p: number;
}
const probabilities: ProbRow[] = [];
const perPlace = new Map<number, Map<number, number>>();
for (let place = 1; place <= task.places; place++) {
  perPlace.set(place, new Map());
}
const horizonWeightSum = HORIZON_WEIGHTS.reduce((a, b) => a + b, 0);
for (const uid of candidates) {
  const r0 = currentRank.get(uid);
  if (r0 === undefined) continue;
  const v = velocity(uid);
  for (let hi = 0; hi < HORIZONS.length; hi++) {
    const h = HORIZONS[hi]!;
    const pred = Math.max(1, Math.min(100, r0 + v * h));
    for (let place = 1; place <= task.places; place++) {
      const w = Math.exp(-((pred - place) ** 2) / (2 * SIGMA * SIGMA));
      const map = perPlace.get(place)!;
      map.set(uid, (map.get(uid) ?? 0) + (w * HORIZON_WEIGHTS[hi]!) / horizonWeightSum);
    }
  }
}
for (let place = 1; place <= task.places; place++) {
  const map = perPlace.get(place)!;
  const sum = [...map.values()].reduce((a, b) => a + b, 0);
  if (sum <= 0) continue;
  const scale = TOTAL_MASS / sum;
  for (const [uid, p] of map) {
    probabilities.push({ universe_id: uid, place, p: p * scale });
  }
}

// The top 10, in order: the games with the best predicted rank at 24 hours
// (the middle of the scored window, so the order is neither the chart as it
// stood nor its far end).
const predicted24 = [...candidates]
  .map((uid) => {
    const r0 = currentRank.get(uid);
    if (r0 === undefined) return null;
    return { uid, pred: Math.max(1, Math.min(100, r0 + velocity(uid) * 24)) };
  })
  .filter((x): x is { uid: number; pred: number } => x !== null)
  .sort((a, b) => a.pred - b.pred);
const top10 = predicted24.slice(0, task.places).map((x) => x.uid);
// Fill any shortfall from the current chart's order (should not happen).
for (const uid of chartIds) {
  if (top10.length >= task.places) break;
  if (!top10.includes(uid)) top10.push(uid);
}

writeFileSync(
  join(OUTPUT_DIR, task.output),
  `${JSON.stringify({ probabilities, top10 })}\n`,
);
