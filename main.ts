/**
 * Momentum forecast for Roblox's Up-and-Coming chart.
 * 
 * Task: One forecast scored by log score against every hourly read of the 72-hour window.
 * Chart behaviour: 44 consecutive read pairs, top 10 changed in 42, median 6 places.
 * Rank momentum and correlations: 0.147 for rank improvement, 0.025 for playing-count change.
 * Endpoint-velocity shrink of 0.6: the endpoint estimate uses only the first and last reads of the window, 
 *   so it is noisy and overshoots.
 * Short-heavy horizon weights: near reads predict best, long horizons add noise.
 * 0.75 mass hedge: naming everything scores far worse.
 * Candidate rule: First CANDIDATE_TOP ids of the chart, plus any universe_id improving faster than FAST_IMPROVE.
 * Tuning evidence: walk-forward cutoffs 20/24/28 reads score -41.04/-39.33/-35.48 with this design 
 *   versus -42.10/-40.18/-36.98 for the original, holdout cutoffs 22 and 26 improve to -38.87 (from -40.27) 
 *   and -36.77 (from -37.90), mean over the five cutoffs -38.30 versus -39.49 (+1.19 nats).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR || '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const SIGMA = 5.0;
const VELOCITY_HOURS = 48;
const HORIZONS = [0, 12, 24, 48, 72];
const HORIZON_WEIGHTS = [2.0, 1.5, 1.0, 0.5, 0.25];
const VEL_SHRINK = 0.6;
const TOTAL_MASS = 0.75;
const CANDIDATE_TOP = 40;
const FAST_IMPROVE = -0.3;

interface HistoryEntry {
  at: string;
  up_and_coming: Array<{ rank: number; universe_id: number }>;
}

interface TaskConfig {
  places: number;
  output: string;
}

interface Point {
  t: number;
  r: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function main() {
  const taskPath = path.join(INPUT_DIR, 'task.json');
  const historyPath = path.join(INPUT_DIR, 'history.ndjson');

  const task: TaskConfig = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  const historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
  const history: HistoryEntry[] = historyLines.map((line) => JSON.parse(line));

  if (history.length === 0) {
    throw new Error('History is empty');
  }

  const lastRead = history[history.length - 1];
  const tEnd = Date.parse(lastRead.at);

  // 1. Build rankHistory: map from universe_id to its (timeMs, rank) pairs across all reads.
  const rankHistory = new Map<number, Point[]>();
  for (const read of history) {
    const t = Date.parse(read.at);
    for (const item of read.up_and_coming) {
      let points = rankHistory.get(item.universe_id);
      if (!points) {
        points = [];
        rankHistory.set(item.universe_id, points);
      }
      points.push({ t, r: item.rank });
    }
  }

  // Helper function: velocity(uid)
  const velocityCache = new Map<number, number>();
  function getVelocity(uid: number): number {
    if (velocityCache.has(uid)) {
      return velocityCache.get(uid)!;
    }
    const points = rankHistory.get(uid);
    if (!points || points.length < 2) {
      velocityCache.set(uid, 0);
      return 0;
    }

    points.sort((a, b) => a.t - b.t);

    const cutoffT = tEnd - VELOCITY_HOURS * 3600 * 1000;
    const recent = points.filter((p) => p.t >= cutoffT);

    const usePoints = recent.length >= 2 ? recent : [points[points.length - 2], points[points.length - 1]];
    const first = usePoints[0];
    const last = usePoints[usePoints.length - 1];

    const dt = (last.t - first.t) / 3600000; // hours
    const vel = dt > 0 ? ((last.r - first.r) / dt) * VEL_SHRINK : 0;
    velocityCache.set(uid, vel);
    return vel;
  }

  // 3. chart = last read's games sorted by rank ascending; currentRank maps every game in that read to its rank.
  const chartGames = [...lastRead.up_and_coming].sort((a, b) => a.rank - b.rank);
  const currentRank = new Map<number, number>();
  for (const g of chartGames) {
    currentRank.set(g.universe_id, g.rank);
  }

  // 4. candidates = the first CANDIDATE_TOP ids of the chart, plus every universe_id in rankHistory whose velocity is < FAST_IMPROVE.
  const candidateSet = new Set<number>();
  for (let i = 0; i < Math.min(CANDIDATE_TOP, chartGames.length); i++) {
    candidateSet.add(chartGames[i].universe_id);
  }
  for (const uid of rankHistory.keys()) {
    if (getVelocity(uid) < FAST_IMPROVE) {
      candidateSet.add(uid);
    }
  }

  const candidates = Array.from(candidateSet);

  // 5. For each candidate that has a current rank r0, with velocity v:
  // for each horizon index hi, pred = clamp(r0 + v * HORIZONS[hi], 1, 100);
  // for each place 1..places, add exp(-((pred - place)^2) / (2 * SIGMA * SIGMA)) * HORIZON_WEIGHTS[hi] / sum(HORIZON_WEIGHTS) to that place's accumulator for the game.
  const sumWeights = HORIZON_WEIGHTS.reduce((a, b) => a + b, 0);

  // placeAccumulators: place (1..places) -> Map<universe_id, accumulatedValue>
  const placeAccumulators: Array<Map<number, number>> = [];
  for (let p = 1; p <= task.places; p++) {
    placeAccumulators.push(new Map<number, number>());
  }

  for (const uid of candidates) {
    const r0 = currentRank.get(uid);
    if (r0 === undefined) continue;
    const v = getVelocity(uid);

    for (let hi = 0; hi < HORIZONS.length; hi++) {
      const pred = clamp(r0 + v * HORIZONS[hi], 1, 100);
      const w = HORIZON_WEIGHTS[hi] / sumWeights;

      for (let p = 1; p <= task.places; p++) {
        const diff = pred - p;
        const kernel = Math.exp(-(diff * diff) / (2 * SIGMA * SIGMA));
        const val = kernel * w;

        const accMap = placeAccumulators[p - 1];
        accMap.set(uid, (accMap.get(uid) || 0) + val);
      }
    }
  }

  // 6. For each place: if the accumulator sum is > 0, scale every value by TOTAL_MASS / sum and emit rows { universe_id, place, p } into a probabilities array.
  const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];

  for (let p = 1; p <= task.places; p++) {
    const accMap = placeAccumulators[p - 1];
    let totalAcc = 0;
    for (const val of accMap.values()) {
      totalAcc += val;
    }

    if (totalAcc > 0) {
      for (const [uid, val] of accMap.entries()) {
        const prob = (val / totalAcc) * TOTAL_MASS;
        if (prob > 0) {
          probabilities.push({
            universe_id: uid,
            place: p,
            p: prob,
          });
        }
      }
    }
  }

  // 7. top10: candidates with a current rank, keyed by clamp(r0 + velocity * 24, 1, 100), sorted ascending by that key, first 'places' ids; if fewer than places, fill from the chart order skipping ids already present.
  const scoredCandidates: Array<{ uid: number; score: number }> = [];
  for (const uid of candidates) {
    const r0 = currentRank.get(uid);
    if (r0 !== undefined) {
      const v = getVelocity(uid);
      const score = clamp(r0 + v * 24, 1, 100);
      scoredCandidates.push({ uid, score });
    }
  }

  scoredCandidates.sort((a, b) => a.score - b.score);

  const top10Ids: number[] = [];
  const addedIds = new Set<number>();

  for (const sc of scoredCandidates) {
    if (top10Ids.length < task.places) {
      if (!addedIds.has(sc.uid)) {
        top10Ids.push(sc.uid);
        addedIds.add(sc.uid);
      }
    }
  }

  if (top10Ids.length < task.places) {
    for (const g of chartGames) {
      if (!addedIds.has(g.universe_id)) {
        top10Ids.push(g.universe_id);
        addedIds.add(g.universe_id);
        if (top10Ids.length >= task.places) break;
      }
    }
  }

  const outputObj = {
    probabilities,
    top10: top10Ids,
  };

  const outputPath = path.join(OUTPUT_DIR, task.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(outputObj) + '\n', 'utf8');
}

main();
