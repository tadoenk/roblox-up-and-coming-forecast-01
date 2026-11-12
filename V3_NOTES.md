# V3 notes — diagnosis and design (2026-11-12)

## Evaluation setup (why these numbers can be trusted)

The kit's `competition.yaml` states the dev phase grades on the sealed
practice instance: the 34-read archive history in `kit/input/` and the
practice window after it. Those window reads are reads 35–44 of the same
public archive the kit itself cites (github.com/Kenny-Dhub/roblox-snapshots,
MIT). Reconstructing them and re-implementing the scorer from
`grader/forecast/ranked.ts` reproduces the house numbers **exactly**:

- starter/persistence baseline on the practice window: **−43.512039**
  (RULES.txt: −43.512039), hits 6.4, agreement 53.5 — all match.
- our live v2 entry (repo main.ts @ 8760826e) on the practice window:
  **−36.009037**, p_place 0.0273, hits 5.9, agreement 44.1 — identical to
  the live dev board (rank 412/706).

So the practice window plus walk-forward cutoffs inside the 45 archive
reads (history = first c reads, scored on the reads that follow within
~84 h) are exact local fixtures, not approximations.

## The dev board's top is not a modelling result

An ex-post "oracle" that simply plays back the practice window's own
empirical place frequencies scores **−13.381** — statistically the same
as the board's #1 (−13.7, hits 8.3). The window reads were public in the
archive before entries opened, so the top of the dev board is explained
by reading the answer key, not by a better model. That advantage is
impossible on the final (window 2026-11-13→16, reads do not exist yet).
A clairvoyant-timing reference (each read predicted sharply from the
previous read) scores only −22.7, which brackets what honest forecasting
can reach at archive cadence. **The honest race is against the house
entries (baseline −43.51 practice) and the honest field around −35.**

## Diagnosis of v2 (−36.01 practice; WF mean −39.59) — ranked causes

1. **Single weak signal.** v2 uses only endpoint rank velocity (48 h,
   shrunk 0.6). Feature study over all archive pairs (target = rank at
   +24 h / +48 h, Spearman): rank now **+0.76 / +0.62**; playing level
   **−0.34 / −0.28**; playing slope **−0.26 / −0.26**; rank velocity
   +0.22 / +0.25. v2 ignores the two playing signals, which are as strong
   as the one signal it uses. (Cross-chart ranks in Top Trending / Top
   Playing Now add nothing: Spearman 0.07–0.11 — tested, rejected.)
2. **Diffuse where it should be sharp, sharp where it should be
   diffuse.** On the practice window v2 never once gave a realised game
   p ≥ 0.1 at its place (78/100 place-reads landed in 0.01–0.1). Its
   fixed σ = 5 Gaussian around an endpoint-velocity point prediction,
   mixed short-heavy over horizons {0,12,24,48,72} with weights
   {2,1.5,1,0.5,0.25}, misprices both ends: per-read scores decay
   monotonically across the window (−29.7 → −40.3).
3. **Ordering quality below even persistence.** v2's top-10 list scores
   hits 5.9 and agreement 44.1 on the practice window — *worse than the
   do-nothing baseline's* 6.4 / 53.5. The velocity bets actively move
   games out of the places they keep. (Hypothesis (b) from the brief —
   rank persistence dominates — is confirmed for the ordering, though
   not for the probabilities.)
4. **Mass and candidates (hypotheses (a), (c)).** TOTAL_MASS 0.75 is not
   the main leak: 44% of v2's named mass lands on games in the realised
   top 10, 19% on games outside the realised top 25. The window's big
   winners Do Not Stop. / Bloody Ragdoll Physics / Build a Bridge were
   absent from the *entire* history (all charts), so ~8% of window
   top-10 slots were unnameable by anyone — a floor on loss that only
   the unnamed share hedges. Per-game shrink by sample size (c) is
   subsumed by the regression model's pooling in v3.
5. **Horizon weighting (hypothesis (d)).** The short-heavy weights
   over-serve the first hours. On sparse archive fixtures uniform
   weighting is *worse* (the scored reads cluster informative), so v3
   keeps v2's mixture inside component A and lets component B carry the
   uniform-horizon view; the blend balances both.
6. **What did NOT work** (tested, rejected with numbers): a pure
   empirical transition kernel with Monte-Carlo ordering (−42.7
   practice — era-mixed pools and ghost candidates from stale games);
   empirical-residual bootstrap destinations (−36.6 practice, −40.7 WF);
   per-horizon model blending (−39.2 overall, no gain over
   probability-level blending).

## V3 design — calibrated two-model ensemble

- **Component A (weight 0.5)** — the v2 momentum kernel, unchanged:
  endpoint rank velocity over 48 h shrunk 0.6, Gaussian kernel σ = 5
  around the predicted rank, horizons {0,12,24,48,72} weighted
  {2,1.5,1,0.5,0.25}, candidates = closing top 40 + games improving
  faster than 0.3 ranks/h, per-place mass 0.75.
- **Component B (weight 0.5)** — a ridge-regression feature model fitted
  on the history itself at run time: for every ordered pair of reads
  (lag ≤ 96 h) and every game present at the start read, features
  [rank, rank velocity (OLS, 48 h), log playing, log-playing slope
  (OLS, 48 h), rank sd (48 h)] predict the end rank (present games
  only), with lag interactions and recency weights (half-life 120 h).
  Predictive spread σ(h) = c0 + c1·√h fitted from binned residuals,
  scaled ×0.55 (calibration: the raw residual spread overstates the
  useful spread). Each game's kernel weight is discounted by an
  empirical exit rate P(absent at +h | start-rank band). Gaussian
  kernel marginals over uniform horizons 1–72 h, per-place mass 0.90.
- **Blend**: per (game, place), p = 0.5·pA + 0.5·pB (missing = 0);
  rows below 0.0001 dropped. Per-place named mass ≈ 0.825.
- **top10**: games ranked by summed blended probability (their
  top-10 occupancy proxy), filled from the closing chart order.
- **Age-out taper (final-only)**: when the last read's `details` carry a
  game's `created` date and created + 28 days falls before a horizon,
  that horizon's weight for the game is zero — the chart only lists
  games published within 28 days (RULES.txt). No-op on the practice
  input, whose reads have no details.
- Deterministic (no randomness anywhere), standard library only.

## Measured results (identical fixtures for every model)

Walk-forward = cuts at reads 20/22/24/26/28/30/32 scored on following
reads ≤ 84 h; practice = the true dev window (10 reads).

| model | WF mean | practice | practice hits | practice agreement |
|---|---|---|---|---|
| house baseline | −50.58 | −43.512 | 6.4 | 53.5 |
| v2 (live entry) | −39.59 | −36.009 | 5.9 | 44.1 |
| B alone (ridge kernel) | −39.62 | −35.00 | — | — |
| **v3 ensemble** | **−38.99** | **−35.08** | **7.3** | **52.3** |

Per-cut v3 vs v2: −40.50/−40.03 (cut 20, v2 wins), −38.80/−39.35,
−41.45/−41.68, −40.56/−41.49, −38.33/−39.56, −36.31/−36.93,
−37.02/−38.12, practice −35.08/−36.01 — v3 beats v2 on 7 of 8 fixtures
and the house baseline on every fixture by 6.4–13.2 points.

## Honest expectations for the final

- The +2.0-mean-over-v2 bar set for this rebuild was **not** reached:
  the ensemble gains +0.93 on the practice window and +0.60 on the
  walk-forward mean (+0.64 overall). At archive cadence most of the
  remaining loss is irreducible chart entropy (top-10 survival is only
  0.53 at 30–55 h lags, 0.38 at 55–80 h). No honest variant tested came
  close to the dev board's archive-oracle top, and none should be
  expected to.
- The final is scored on 72 **hourly** reads and its history ends with
  ~55 hourly recorder reads. Both help v3 relative to these fixtures:
  short-lag reads reward the calibrated sharpness, and the regression's
  feature estimates get far denser data than the archive's ~7 h cadence
  (a regime these fixtures cannot simulate). Absolute final scores for
  the whole honest field should be several points better than the
  practice numbers; v3's expected final standing is "clearly above the
  house bar, competitive for the lower prize places" — not a lock.
- Residual risks: the regression is fitted per-run on the fly; on the
  dense final history the pair count grows ~40× (runtime checked:
  seconds, well inside 300 s). The age-out taper is untestable on the
  practice input (no details) and is deliberately conservative.
