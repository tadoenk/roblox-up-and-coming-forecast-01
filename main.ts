/**
 * Roblox Up-and-Coming Forecast - V3 Ensemble Model
 * 
 * Design & Evidence (from V3_NOTES.md):
 * - Ensemble of Component A (momentum kernel, weight 0.5, mass 0.75) and
 *   Component B (ridge-regression feature model, weight 0.5, mass 0.90).
 * - Measured performance:
 *   - Practice window score: -35.08 (vs v2 -36.01, house baseline -43.51)
 *   - Walk-forward mean score: -38.99 (vs v2 -39.59)
 *   - Practice hits: 7.3 (vs 5.9); Agreement: 52.3 (vs 44.1)
 * - Deterministic, standard library only, Node 22.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ReadRecord {
  at: string;
  t: number;
  up_and_coming: Array<{
    rank: number;
    universe_id: number;
    playing: number;
  }>;
  details: Record<string, { created?: string }> | null;
}

interface TaskJson {
  history_until: string;
  window: {
    from?: string;
    until: string;
    slots: number;
  };
  places: number;
  output: string;
}

// Helpers
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function olsSlope(ts: number[], ys: number[]): number {
  const n = ts.length;
  if (n < 2) return 0;
  let sumT = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumT += ts[i];
    sumY += ys[i];
  }
  const meanT = sumT / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - meanT;
    num += dt * (ys[i] - meanY);
    den += dt * dt;
  }
  if (den === 0) return 0;
  return num / den;
}

function popSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += xs[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const diff = xs[i] - mean;
    varSum += diff * diff;
  }
  return Math.sqrt(varSum / n);
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = r;
      }
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    for (let c = col; c <= n; c++) {
      M[col][c] /= pivot;
    }

    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const factor = M[r][col];
        if (factor !== 0) {
          for (let c = col; c <= n; c++) {
            M[r][c] -= factor * M[col][c];
          }
        }
      }
    }
  }

  const x = new Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = M[i][n];
  }
  return x;
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  const taskRaw = fs.readFileSync(path.join(inputDir, 'task.json'), 'utf-8');
  const task: TaskJson = JSON.parse(taskRaw);

  const historyRaw = fs.readFileSync(path.join(inputDir, 'history.ndjson'), 'utf-8');
  const lines = historyRaw.split('\n').filter(l => l.trim().length > 0);

  const reads: ReadRecord[] = lines.map(line => {
    const obj = JSON.parse(line);
    const t = Date.parse(obj.at);
    // Sort up_and_coming by rank
    const uac = (obj.up_and_coming || []).slice().sort((a: any, b: any) => a.rank - b.rank);
    return {
      at: obj.at,
      t,
      up_and_coming: uac,
      details: obj.details || null,
    };
  });

  reads.sort((a, b) => a.t - b.t);

  const nReads = reads.length;
  const lastRead = reads[nReads - 1];
  const tEnd = lastRead.t;
  const windowStart = task.window.from ? Date.parse(task.window.from) : tEnd;
  const PLACES = task.places || 10;

  // Closing chart map (universe_id -> rank)
  const closingChart = lastRead.up_and_coming;
  const closingRankMap = new Map<number, number>();
  closingChart.forEach(item => closingRankMap.set(item.universe_id, item.rank));

  // Age-out exitMs(uid)
  function exitMs(uid: number): number {
    if (lastRead.details && lastRead.details[String(uid)]) {
      const createdStr = lastRead.details[String(uid)].created;
      if (createdStr) {
        const c = Date.parse(createdStr);
        if (!isNaN(c)) {
          return c + 28 * 86400e3;
        }
      }
    }
    return Infinity;
  }

  function isKilled(uid: number, h: number): boolean {
    return windowStart + h * 3600e3 >= exitMs(uid);
  }

  // Rank history Map uid -> array of {t, r}
  const rankHistory = new Map<number, Array<{ t: number; r: number }>>();
  reads.forEach(r => {
    r.up_and_coming.forEach(item => {
      let arr = rankHistory.get(item.universe_id);
      if (!arr) {
        arr = [];
        rankHistory.set(item.universe_id, arr);
      }
      arr.push({ t: r.t, r: item.rank });
    });
  });

  // FEATURES AT (i, uid)
  const featureCache = new Map<string, number[] | null>();

  function featuresAt(i: number, uid: number): number[] | null {
    const cacheKey = `${i}_${uid}`;
    if (featureCache.has(cacheKey)) {
      return featureCache.get(cacheKey)!;
    }

    const ri = reads[i];
    const ti = ri.t;
    // Check if uid present in read i
    let rankInI = -1;
    let logpInI = 0;
    let presentInI = false;
    for (const item of ri.up_and_coming) {
      if (item.universe_id === uid) {
        rankInI = item.rank;
        logpInI = item.playing > 0 ? Math.log(item.playing) : 0;
        presentInI = true;
        break;
      }
    }

    if (!presentInI) {
      featureCache.set(cacheKey, null);
      return null;
    }

    // Collect reads j <= i with t_j >= ti - 48*3600e3 where uid present
    const ts: number[] = [];
    const ranks: number[] = [];
    const logps: number[] = [];

    for (let j = 0; j <= i; j++) {
      const rj = reads[j];
      if (rj.t >= ti - 48 * 3600e3) {
        for (const item of rj.up_and_coming) {
          if (item.universe_id === uid) {
            ts.push(rj.t / 3600e3);
            ranks.push(item.rank);
            logps.push(item.playing > 0 ? Math.log(item.playing) : 0);
            break;
          }
        }
      }
    }

    const slopeRank = olsSlope(ts, ranks);
    const slopeLogp = olsSlope(ts, logps);
    const sdRank = popSd(ranks);

    const feats = [rankInI, slopeRank, logpInI, slopeLogp, sdRank];
    featureCache.set(cacheKey, feats);
    return feats;
  }

  // ==========================================
  // COMPONENT A (Momentum Kernel) — mass 0.75
  // ==========================================
  function velocityA(uid: number): number {
    const arr = rankHistory.get(uid);
    if (!arr || arr.length === 0) return 0;
    const cutoff = tEnd - 48 * 3600e3;
    const recent = arr.filter(p => p.t >= cutoff);
    let pts = recent;
    if (pts.length < 2) {
      pts = arr.slice(-2);
    }
    if (pts.length < 2) return 0;
    const pFirst = pts[0];
    const pLast = pts[pts.length - 1];
    const dt = (pLast.t - pFirst.t) / 3600e3;
    if (dt <= 0) return 0;
    const vel = ((pLast.r - pFirst.r) / dt) * 0.6;
    return vel;
  }

  const closingTop40 = closingChart.slice(0, 40).map(i => i.universe_id);
  const climberSet = new Set<number>();
  closingTop40.forEach(id => climberSet.add(id));
  rankHistory.forEach((_, uid) => {
    if (velocityA(uid) < -0.3) {
      climberSet.add(uid);
    }
  });

  const horizonsA = [0, 12, 24, 48, 72];
  const weightsA = [2.0, 1.5, 1.0, 0.5, 0.25];
  const sumW = 5.25;

  const accA = Array.from({ length: PLACES + 1 }, () => new Map<number, number>());

  climberSet.forEach(uid => {
    const r0 = closingRankMap.get(uid);
    if (r0 === undefined) return; // skip if not on closing chart

    const vel = velocityA(uid);
    for (let hi = 0; hi < horizonsA.length; hi++) {
      const h = horizonsA[hi];
      if (isKilled(uid, h)) continue;
      const pred = clamp(r0 + vel * h, 1, 100);
      const w = weightsA[hi] / sumW;

      for (let place = 1; place <= PLACES; place++) {
        const kVal = Math.exp(-((pred - place) ** 2) / 50) * w; // sigmaA = 5 => 2 * sigma^2 = 50
        const map = accA[place];
        map.set(uid, (map.get(uid) || 0) + kVal);
      }
    }
  });

  const rowsA: Array<{ universe_id: number; place: number; p: number }> = [];
  for (let place = 1; place <= PLACES; place++) {
    const map = accA[place];
    let sum = 0;
    map.forEach(val => sum += val);
    if (sum > 0) {
      map.forEach((val, uid) => {
        const p = (val / sum) * 0.75;
        rowsA.push({ universe_id: uid, place, p });
      });
    }
  }

  // ==========================================
  // COMPONENT B (Ridge Feature Kernel) — mass 0.90
  // ==========================================
  // Collect pairs i < j with lag in (0, 96]
  interface PairInfo {
    X: number[];
    lag: number;
    present: boolean;
    y: number;
    pairWeight: number;
    r0: number;
  }

  const pairs: PairInfo[] = [];
  const flatPairStartRank: number[] = [];
  const flatPairLag: number[] = [];
  const flatPairPresent: boolean[] = [];

  for (let i = 0; i < nReads; i++) {
    const ri = reads[i];
    for (let j = i + 1; j < nReads; j++) {
      const rj = reads[j];
      const lag = (rj.t - ri.t) / 3600e3;
      if (lag <= 0 || lag > 96) continue;

      const presentMap = new Map<number, number>(); // uid -> rank in j
      rj.up_and_coming.forEach(item => presentMap.set(item.universe_id, item.rank));

      const pairWeight = Math.pow(0.5, (tEnd - ri.t) / 3600e3 / 120);

      for (const item of ri.up_and_coming) {
        const uid = item.universe_id;
        const X = featuresAt(i, uid);
        if (!X) continue;

        const rJ = presentMap.get(uid);
        const present = rJ !== undefined;
        const y = present ? Math.min(rJ, 115) : 115;

        pairs.push({
          X,
          lag,
          present,
          y,
          pairWeight,
          r0: X[0],
        });

        flatPairStartRank.push(X[0]);
        flatPairLag.push(lag);
        flatPairPresent.push(present);
      }
    }
  }

  // Standardise X over all pairs
  const nPairs = pairs.length;
  const mu = [0, 0, 0, 0, 0];
  const sd = [1, 1, 1, 1, 1];

  if (nPairs > 0) {
    for (let k = 0; k < 5; k++) {
      let sum = 0;
      for (let p = 0; p < nPairs; p++) sum += pairs[p].X[k];
      mu[k] = sum / nPairs;
    }
    for (let k = 0; k < 5; k++) {
      let varSum = 0;
      for (let p = 0; p < nPairs; p++) {
        const diff = pairs[p].X[k] - mu[k];
        varSum += diff * diff;
      }
      const s = Math.sqrt(varSum / nPairs);
      sd[k] = s === 0 ? 1 : s;
    }
  }

  function designRow(X: number[], lag: number): number[] {
    const xs0 = (X[0] - mu[0]) / sd[0];
    const xs1 = (X[1] - mu[1]) / sd[1];
    const xs2 = (X[2] - mu[2]) / sd[2];
    const xs3 = (X[3] - mu[3]) / sd[3];
    const xs4 = (X[4] - mu[4]) / sd[4];
    const lagC = (lag - 36) / 36;
    return [
      1,
      xs0,
      xs1,
      xs2,
      xs3,
      xs4,
      lagC,
      lagC * lagC,
      xs0 * lagC,
      xs2 * lagC,
    ];
  }

  // Fit on PRESENT pairs only, weighted
  // (D^T W D + 30 * I') beta = D^T W y
  const dim = 10;
  const ATA = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const ATy = new Array(dim).fill(0);

  for (let p = 0; p < nPairs; p++) {
    const pair = pairs[p];
    if (!pair.present) continue; // present pairs only for beta fit
    const d = designRow(pair.X, pair.lag);
    const w = pair.pairWeight;
    const wy = w * pair.y;

    for (let r = 0; r < dim; r++) {
      ATy[r] += d[r] * wy;
      const rowR = ATA[r];
      const drW = d[r] * w;
      for (let c = 0; c < dim; c++) {
        rowR[c] += drW * d[c];
      }
    }
  }

  // Add ridge penalty 30 * I' (I'[0][0] = 0)
  for (let r = 0; r < dim; r++) {
    if (r > 0) {
      ATA[r][r] += 30;
    }
  }

  const beta = solveLinear(ATA, ATy);

  // Residuals & Residual standard error fit vs sqrt(centre)
  const residsByBin = new Map<number, number[]>(); // bin -> residuals

  for (let p = 0; p < nPairs; p++) {
    const pair = pairs[p];
    if (!pair.present) continue;
    const d = designRow(pair.X, pair.lag);
    let pred = 0;
    for (let r = 0; r < dim; r++) pred += d[r] * beta[r];
    const resid = pair.y - pred;
    const bin = Math.min(7, Math.floor(pair.lag / 12));
    let arr = residsByBin.get(bin);
    if (!arr) {
      arr = [];
      residsByBin.set(bin, arr);
    }
    arr.push(resid);
  }

  const binCentres: number[] = [];
  const binStds: number[] = [];
  const allResids: number[] = [];

  for (let p = 0; p < nPairs; p++) {
    const pair = pairs[p];
    if (!pair.present) continue;
    const d = designRow(pair.X, pair.lag);
    let pred = 0;
    for (let r = 0; r < dim; r++) pred += d[r] * beta[r];
    allResids.push(pair.y - pred);
  }

  residsByBin.forEach((resids, bin) => {
    if (resids.length > 30) {
      binCentres.push(bin * 12 + 6);
      binStds.push(popSd(resids));
    }
  });

  let c0 = 2;
  let c1 = 0;

  if (binCentres.length >= 2) {
    const sqrtCentres = binCentres.map(c => Math.sqrt(c));
    c1 = olsSlope(sqrtCentres, binStds);
    const meanSqrt = sqrtCentres.reduce((a, b) => a + b, 0) / sqrtCentres.length;
    const meanStd = binStds.reduce((a, b) => a + b, 0) / binStds.length;
    c0 = meanStd - c1 * meanSqrt;
  } else {
    c0 = popSd(allResids);
  }

  c0 = Math.max(c0, 2);
  c1 = Math.max(c1, 0);

  function sigmaB(h: number): number {
    return (c0 + c1 * Math.sqrt(h)) * 0.55;
  }

  // exitRate(r0)
  function exitRate(r0: number): number {
    // 1st pass: |lag - 36| <= 14 and |r0_pair - r0| <= 7
    let matchedPresent = 0;
    let matchedTotal = 0;

    for (let p = 0; p < nPairs; p++) {
      if (Math.abs(flatPairLag[p] - 36) <= 14 && Math.abs(flatPairStartRank[p] - r0) <= 7) {
        matchedTotal++;
        if (flatPairPresent[p]) matchedPresent++;
      }
    }

    if (matchedTotal < 40) {
      matchedPresent = 0;
      matchedTotal = 0;
      for (let p = 0; p < nPairs; p++) {
        if (Math.abs(flatPairLag[p] - 36) <= 24 && Math.abs(flatPairStartRank[p] - r0) <= 12) {
          matchedTotal++;
          if (flatPairPresent[p]) matchedPresent++;
        }
      }
    }

    if (matchedTotal < 20) {
      matchedPresent = 0;
      matchedTotal = 0;
      for (let p = 0; p < nPairs; p++) {
        if (Math.abs(flatPairLag[p] - 36) <= 24) {
          matchedTotal++;
          if (flatPairPresent[p]) matchedPresent++;
        }
      }
    }

    if (matchedTotal === 0) return 0;
    const fracPresent = matchedPresent / matchedTotal;
    return 1 - fracPresent;
  }

  const horizonsB: number[] = [];
  for (let h = 1; h <= 72; h += 3) horizonsB.push(h); // 24 values

  const accB = Array.from({ length: PLACES + 1 }, () => new Map<number, number>());
  const lastIndex = nReads - 1;

  closingChart.forEach(item => {
    const uid = item.universe_id;
    const f = featuresAt(lastIndex, uid);
    if (!f) return;
    const pe = exitRate(f[0]);

    for (const h of horizonsB) {
      if (isKilled(uid, h)) continue;
      const d = designRow(f, h);
      let muVal = 0;
      for (let r = 0; r < dim; r++) muVal += d[r] * beta[r];
      const sig = sigmaB(h);
      const wH = (1 - pe) / horizonsB.length;

      for (let place = 1; place <= PLACES; place++) {
        const kVal = Math.exp(-((muVal - place) ** 2) / (2 * sig * sig)) * wH;
        const map = accB[place];
        map.set(uid, (map.get(uid) || 0) + kVal);
      }
    }
  });

  const rowsB: Array<{ universe_id: number; place: number; p: number }> = [];
  for (let place = 1; place <= PLACES; place++) {
    const map = accB[place];
    let sum = 0;
    map.forEach(val => sum += val);
    if (sum > 0) {
      map.forEach((val, uid) => {
        const p = (val / sum) * 0.90;
        if (p >= 0.0001) {
          rowsB.push({ universe_id: uid, place, p: Math.round(p * 1e6) / 1e6 });
        }
      });
    }
  }

  // ==========================================
  // BLEND AND OUTPUT
  // ==========================================
  const pAByMap = new Map<string, number>();
  rowsA.forEach(r => pAByMap.set(`${r.universe_id}|${r.place}`, r.p));

  const pBByMap = new Map<string, number>();
  rowsB.forEach(r => pBByMap.set(`${r.universe_id}|${r.place}`, r.p));

  const allKeys = new Set<string>();
  pAByMap.forEach((_, k) => allKeys.add(k));
  pBByMap.forEach((_, k) => allKeys.add(k));

  const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
  const uidTotalBlend = new Map<number, number>();

  allKeys.forEach(key => {
    const [uidStr, placeStr] = key.split('|');
    const uid = Number(uidStr);
    const place = Number(placeStr);
    const pA = pAByMap.get(key) || 0;
    const pB = pBByMap.get(key) || 0;
    const pBlend = 0.5 * pA + 0.5 * pB;

    if (pBlend >= 0.0001) {
      const pRounded = Math.round(pBlend * 1e6) / 1e6;
      probabilities.push({ universe_id: uid, place, p: pRounded });
      uidTotalBlend.set(uid, (uidTotalBlend.get(uid) || 0) + pRounded);
    }
  });

  probabilities.sort((a, b) => {
    if (a.place !== b.place) return a.place - b.place;
    return a.universe_id - b.universe_id;
  });

  // top10 selection
  const sortedUids = Array.from(uidTotalBlend.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const rA = closingRankMap.get(a[0]) ?? 999;
    const rB = closingRankMap.get(b[0]) ?? 999;
    return rA - rB;
  });

  const top10: number[] = [];
  sortedUids.forEach(([uid]) => {
    if (top10.length < 10 && !top10.includes(uid)) {
      top10.push(uid);
    }
  });

  // If fewer than 10, append closing-chart ids in rank order skipping ones already present
  for (const item of closingChart) {
    if (top10.length >= 10) break;
    if (!top10.includes(item.universe_id)) {
      top10.push(item.universe_id);
    }
  }

  const outputObj = {
    probabilities,
    top10,
  };

  const outPath = path.join(outputDir, task.output);
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outPath, JSON.stringify(outputObj) + '\n', 'utf-8');
}

main();
