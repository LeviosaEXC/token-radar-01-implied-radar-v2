// Implied Radar v2 — token-radar-01 entry program (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the v2 value model (frozen nested validation,
// functional-form + feature-subset + group-lambda + cap-ablation selection),
// scores every eligible pre-token protocol, writes board.json, the dashboard
// data, and dossier.json via the vendored make.fun library.
//
// Method (synthesis spec 05 + v2 model spec 08; where they conflict, 08 wins):
//   fitLadderModel / selectForm / selectFeaturesDualOOS / selectGroupLambda /
//   capAblation / computeConformalBands / rankPercentileIntervals /
//   scoreProtocol / computeFarmEconomics / assignVerdict / buildFarmPlan /
//   buildCensus / classifyProtocol / verifyRecomputeProof.
// Number discipline: every grid, threshold and fold count is [FIXED] by the
// specs; every fitted coefficient, metric and count is [MEASURED] on the
// sealed snapshot. Gas, deposit, drop-share, hold days and opportunity cost
// are [ASSUMED] scenarios from the spec registry, labelled at point of use.
// Launch odds are EXCLUDED from the primary rank (no issuance outcomes exist
// in the ten snapshot fields); break-even launch probability is a labelled
// secondary hurdle only. listed_at is DefiLlama tracking tenure (a maturity
// proxy, not founding age). No protocol name, slug or category value is ever
// used for fitting, grouping, splitting or tie-breaking; grouping uses
// anonymous integer IDs only. Zero network at runtime; deterministic.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const FLOOR_USD = 50_000_000; // [FIXED] watchlist floor, from the snapshot itself.

// ---------------------------------------------------------------- [FIXED] policy
// Exclusion policy input from the kit's input README (policy, not model input).
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_WORD = /\b(wrapped|staked|staking)\b/i;
// [FIXED] model grids and thresholds (v2 spec V0-V4).
const OFFSET_Q_GRID = [0.25, 0.5, 1, 2];
const LADDER_LAMBDA_GRID = [0.25, 0.5, 0.75, 1];
const GROUP_LAMBDA_GRID = [0, 2, 4, 8, 16, 32, Infinity];
const CAP_S_GRID = [0, 0.5, 1, 2];
const INNER_FOLDS = 5; // [FIXED]; fallback 3 only if the 100 s compute gate fails.
const TIE_DEX = 0.02; // [FIXED] practical-tie band for form / subset / group selection.
const TIE_SPEARMAN = 0.02; // [FIXED]
const SUBSET_ERR_DEX = 0.02; // [FIXED] subset admission: error reduction.
const SUBSET_SPEARMAN = 0.03; // [FIXED] subset admission: rank gain.
const TIME_SPLIT_MAX_DETERIORATION_DEX = 0.05; // [FIXED] 70/30 audit allowance.
const BOOTSTRAP_RESAMPLES = 1000; // [FIXED]
const PERMUTATIONS = 200; // [FIXED]
const RANK_SEED = 20261114; // [FIXED] seeded shuffle seed for rank calibration.
const BOOT_SEED = 20261118; // [FIXED] seeded bootstrap seed.
const HUBER_C = 1.345; // [FIXED] Huber tuning constant.
const COEF_BOUND_DEX = 0.25; // [FIXED] per-IQR feature coefficient bound.
const MISSING_BOUND_DEX = 0.15; // [FIXED] missingness-effect bound.
const GROUP_OFFSET_BOUND_DEX = 1.0; // [FIXED]
const DUST_MIN_MCAP = 100_000; // [FIXED]
const RATIO_WINDOW: [number, number] = [0.005, 500]; // [FIXED]
const RATIO_WINDOW_WIDE: [number, number] = [0.001, 1000]; // [FIXED] sensitivity widening.
const LADDER_SLOPE_RANGE: [number, number] = [0.1, 1.5]; // [FIXED]
// [ASSUMED] farm-economics registry (spec section 3.1) — labelled at point of use.
const ASSUMED = {
  deposit: 2500, dropShare: 0.06, dilution: 1.25, oppApr: 0.045,
  baseHours: 1.5, extraChainHours: 0.25, maxHours: 3.0,
};
const GAS_TIERS: Record<string, [number, number, number]> = {
  eth: [18, 45, 110],
  alt: [1.5, 4, 12],
  l2: [0.8, 2.5, 8],
  other: [2, 6, 18],
};
const GAS_MULTI: [number, number, number] = [3, 7.5, 18];
const ETH_CHAINS = new Set(['Ethereum']);
const ALT_CHAINS = new Set(['Solana', 'BNB', 'Binance', 'Avalanche', 'Bitcoin', 'Tron', 'Sui', 'Aptos', 'Hyperliquid', 'Hyperliquid L1']);
const L2_CHAINS = new Set(['Arbitrum', 'Optimism', 'Base', 'Polygon', 'Scroll', 'Linea', 'zkSync Era', 'Starknet', 'Blast', 'Mantle', 'Berachain', 'Sonic']);
// Note: the spec's tier table names the BNB chain "BNB" and Hyperliquid
// "Hyperliquid"; the snapshot spells them "Binance" and "Hyperliquid L1".
// Both spellings map to the same [ASSUMED] high-cost alt-L1 tier.

// ---------------------------------------------------------------- utilities
const log10 = (v: number): number => Math.log10(v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const median = (a: number[]): number => {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantileSorted = (sorted: number[], q: number): number => {
  // Finite-sample conformal quantile: ceil((n+1)*q)-th order statistic, clamped.
  if (sorted.length === 0) return NaN;
  const idx = clamp(Math.ceil((sorted.length + 1) * q) - 1, 0, sorted.length - 1);
  return sorted[idx]!;
};
const percentile = (a: number[], q: number): number => {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};
const mean = (a: number[]): number => (a.length === 0 ? NaN : a.reduce((s, v) => s + v, 0) / a.length);
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let z = t;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
function ranksWithTies(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => (a.v - b.v) || (a.i - b.i));
  const r = new Array<number>(values.length);
  let k = 0;
  while (k < order.length) {
    let j = k;
    while (j + 1 < order.length && order[j + 1]!.v === order[k]!.v) j++;
    const avg = (k + j) / 2 + 1;
    for (let t = k; t <= j; t++) r[order[t]!.i] = avg;
    k = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return 0;
  const ra = ranksWithTies(a);
  const rb = ranksWithTies(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = ra[i]! - ma;
    const y = rb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}
const medianAbsLogErr = (pred: number[], actual: number[]): number => {
  const errs = pred.map((p, i) => Math.abs(p - actual[i]!));
  return median(errs);
};
const fmtUsd = (v: number): string => {
  const n = Math.round(v);
  const neg = n < 0;
  const s = String(Math.abs(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i));
  return (neg ? '-$' : '$') + parts.join(',');
};
const fmtPct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const fmtNum = (v: number, digits = 3): string => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');

// Solve A x = b by Gaussian elimination with partial pivoting (small dense systems).
function solveLinear(Ain: number[][], bin: number[]): number[] | null {
  const n = bin.length;
  const A = Ain.map((row) => [...row]);
  const b = [...bin];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (Math.abs(A[piv]![col]!) < 1e-14) return null;
    if (piv !== col) {
      const t = A[col]!;
      A[col] = A[piv]!;
      A[piv] = t;
      const tb = b[col]!;
      b[col] = b[piv]!;
      b[piv] = tb;
    }
    const d = A[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = A[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r]![c] = A[r]![c]! - f * A[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]!;
    x[i] = s / A[i]![i]!;
  }
  return x;
}

// Huber IRLS in log10 space. Returns coefficients, final weights, convergence.
function huberFit(X: number[][], y: number[], offset: number[]): { beta: number[]; w: number[]; iters: number; converged: boolean } {
  const n = y.length;
  const p = X[0]!.length;
  let beta = new Array<number>(p).fill(0);
  // OLS start (ridge-stabilised).
  const start = weightedSolve(X, y, offset, new Array<number>(n).fill(1));
  if (start !== null) beta = start;
  let w = new Array<number>(n).fill(1);
  let converged = false;
  let iters = 0;
  for (let it = 0; it < 25; it++) {
    iters = it + 1;
    const resid = y.map((yi, i) => yi - offset[i]! - dot(X[i]!, beta));
    const med = median(resid);
    const mad = 1.4826 * median(resid.map((r) => Math.abs(r - med)));
    const s = Math.max(mad, 1e-9);
    const c = HUBER_C * s;
    w = resid.map((r) => (Math.abs(r) <= c ? 1 : c / Math.abs(r)));
    const next = weightedSolve(X, y, offset, w);
    if (next === null) break;
    let delta = 0;
    for (let j = 0; j < p; j++) delta = Math.max(delta, Math.abs(next[j]! - beta[j]!));
    beta = next;
    if (delta < 1e-9) {
      converged = true;
      break;
    }
  }
  return { beta, w, iters, converged };
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function weightedSolve(X: number[][], y: number[], offset: number[], w: number[]): number[] | null {
  const p = X[0]!.length;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < y.length; i++) {
    const wi = w[i]!;
    const xi = X[i]!;
    const yi = y[i]! - offset[i]!;
    for (let a = 0; a < p; a++) {
      b[a] += wi * xi[a]! * yi;
      for (let c = 0; c < p; c++) A[a]![c] += wi * xi[a]! * xi[c]!;
    }
  }
  for (let a = 1; a < p; a++) A[a]![a] += 1e-6; // ridge on non-intercept slopes.
  return solveLinear(A, b);
}
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

// ---------------------------------------------------------------- snapshot
type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snapshot = { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };

function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== 'object' || raw === null) throw new Error('snapshot is not an object');
  const o = raw as Record<string, unknown>;
  const protocols = o.protocols as Proto[];
  if (!Array.isArray(protocols)) throw new Error('snapshot.protocols is not an array');
  for (const p of protocols) {
    const keys = Object.keys(p).sort();
    const expect = ['category', 'chains', 'change_7d', 'gecko_id', 'listed_at', 'mcap_usd', 'name', 'slug', 'symbol', 'tvl_usd'];
    if (keys.join(',') !== expect.join(',')) throw new Error(`protocol ${String((p as Proto).slug)} does not carry exactly the ten fields`);
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.chains)) throw new Error(`protocol ${p.slug}: bad field types`);
  }
  return {
    as_of: String(o.as_of ?? ''),
    source: String(o.source ?? ''),
    floor_usd: Number(o.floor_usd),
    protocols,
    watchlist: (o.watchlist as string[]).slice(),
  };
}
const asOfDays = (asOf: string): number => Date.parse(`${asOf}T00:00:00Z`) / 86400000;
const daysTracked = (p: Proto, refDays: number): number | null => {
  if (p.listed_at === null) return null;
  const d = Date.parse(`${p.listed_at}T00:00:00Z`) / 86400000;
  if (!Number.isFinite(d)) return null;
  return Math.max(0, Math.floor(refDays - d));
};

// ---------------------------------------------------------------- classification (spec section 2)
type ClassInfo = {
  tokenStatus: 'pre' | 'live' | 'partial'; // pre: records no token; live: mcap>0; partial: id/symbol but no mcap.
  exclusions: string[]; // every matching rule, in policy order.
  primaryReason: string | null; // first matching exclusion, or null.
  holdReason: string | null; // data-quality hold, or null.
};
function classifyProtocol(p: Proto): ClassInfo {
  const exclusions: string[] = [];
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) exclusions.push('category');
  if (VERSION_SUFFIX.test(p.name)) exclusions.push('version');
  if (DERIVATIVE_WORD.test(p.name)) exclusions.push('derivative');
  if (EXCHANGE_PREFIXES.some((e) => new RegExp(`^${e}\\b`).test(p.name))) exclusions.push('exchange');
  let tokenStatus: ClassInfo['tokenStatus'] = 'pre';
  if (p.mcap_usd !== null && p.mcap_usd > 0) tokenStatus = 'live';
  else if (p.gecko_id !== null || p.symbol !== null) tokenStatus = 'partial';
  let holdReason: string | null = null;
  if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) holdReason = 'bad-tvl';
  else if (p.listed_at !== null && !Number.isFinite(Date.parse(`${p.listed_at}T00:00:00Z`))) holdReason = 'bad-date';
  return { tokenStatus, exclusions, primaryReason: exclusions[0] ?? null, holdReason };
}
type Census = {
  total: number; hold: number; holdReasons: Record<string, number>;
  boardWatchlist: number; boardBelowFloor: number;
  setAsideCategory: number; setAsideCategoryTvl: number;
  setAsideName: number; setAsideNameTvl: number;
  refFit: number; refFitTvl: number;
  refOther: number; refOtherTvl: number; refOtherReasons: Record<string, number>;
  partialMissingMcap: number; liveExcluded: number;
};
function buildCensus(snapshot: Snapshot, boardSlugs: Set<string>, fitSlugs: Set<string>): Census {
  const c: Census = {
    total: snapshot.protocols.length, hold: 0, holdReasons: {},
    boardWatchlist: 0, boardBelowFloor: 0,
    setAsideCategory: 0, setAsideCategoryTvl: 0, setAsideName: 0, setAsideNameTvl: 0,
    refFit: 0, refFitTvl: 0, refOther: 0, refOtherTvl: 0, refOtherReasons: {},
    partialMissingMcap: 0, liveExcluded: 0,
  };
  const watch = new Set(snapshot.watchlist);
  for (const p of snapshot.protocols) {
    const cl = classifyProtocol(p);
    if (cl.holdReason !== null) {
      c.hold++;
      c.holdReasons[cl.holdReason] = (c.holdReasons[cl.holdReason] ?? 0) + 1;
      continue;
    }
    if (boardSlugs.has(p.slug)) {
      if (watch.has(p.slug)) c.boardWatchlist++;
      else c.boardBelowFloor++;
      continue;
    }
    if (cl.tokenStatus === 'pre') {
      if (cl.primaryReason === 'category') {
        c.setAsideCategory++;
        c.setAsideCategoryTvl += p.tvl_usd;
      } else if (cl.primaryReason !== null) {
        c.setAsideName++;
        c.setAsideNameTvl += p.tvl_usd;
      } else {
        throw new Error(`census: pre-token ${p.slug} is neither board nor set aside`);
      }
      continue;
    }
    if (fitSlugs.has(p.slug)) {
      c.refFit++;
      c.refFitTvl += p.tvl_usd;
      continue;
    }
    c.refOther++;
    c.refOtherTvl += p.tvl_usd;
    let reason = 'other';
    if (cl.tokenStatus === 'partial') {
      reason = 'missing-mcap';
      c.partialMissingMcap++;
    } else if (cl.primaryReason !== null) {
      reason = `excluded-${cl.primaryReason}`;
      c.liveExcluded++;
    } else if (!(p.mcap_usd !== null && p.mcap_usd >= DUST_MIN_MCAP)) {
      reason = 'dust';
    } else {
      const r = p.mcap_usd / p.tvl_usd;
      if (r < RATIO_WINDOW[0] || r > RATIO_WINDOW[1]) reason = 'ratio';
    }
    c.refOtherReasons[reason] = (c.refOtherReasons[reason] ?? 0) + 1;
  }
  const sum = c.hold + c.boardWatchlist + c.boardBelowFloor + c.setAsideCategory + c.setAsideName + c.refFit + c.refOther;
  if (sum !== c.total) throw new Error(`census: buckets sum ${sum} but snapshot holds ${c.total}`);
  return c;
}

// Comps: recorded token + TVL floor + identical exclusion screen + dust/integrity.
type CompScreen = { comps: Proto[]; rejected: Record<string, number>; rawCount: number };
function selectTradedComps(snapshot: Snapshot, ratioWindow: [number, number] = RATIO_WINDOW): CompScreen {
  const comps: Proto[] = [];
  const rejected: Record<string, number> = {};
  let rawCount = 0;
  for (const p of snapshot.protocols) {
    const cl = classifyProtocol(p);
    if (cl.holdReason !== null) continue;
    const recorded = p.mcap_usd !== null && p.mcap_usd > 0 && (p.gecko_id !== null || p.symbol !== null);
    if (!recorded) continue;
    rawCount++;
    if (p.tvl_usd < 5_000_000) {
      rejected['below-5m'] = (rejected['below-5m'] ?? 0) + 1;
      continue;
    }
    if (cl.primaryReason !== null) {
      const k = `excluded-${cl.primaryReason}`;
      rejected[k] = (rejected[k] ?? 0) + 1;
      continue;
    }
    if (p.mcap_usd! < DUST_MIN_MCAP) {
      rejected.dust = (rejected.dust ?? 0) + 1;
      continue;
    }
    const r = p.mcap_usd! / p.tvl_usd;
    if (r < ratioWindow[0] || r > ratioWindow[1]) {
      rejected.ratio = (rejected.ratio ?? 0) + 1;
      continue;
    }
    comps.push(p);
  }
  comps.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { comps, rejected, rawCount };
}

// ---------------------------------------------------------------- value model (v2 spec V1-V4)
type FormSel = { kind: 'global' } | { kind: 'offset'; q: number } | { kind: 'ladder'; lambda: number };
type PipeCfg = { form: FormSel; subset: number; groupLambda: number };
const SUBSET_NAMES = ['', 'G', 'A', 'GA', 'C', 'GC', 'AC', 'GAC'];
type FoldStats = {
  medTvl: number; k1: number; k2: number;
  growS: number; growP1: number; growP99: number; growMed: number; growIqr: number;
  ageP1: number; ageP99: number; ageMed: number; ageIqr: number;
  chainP1: number; chainP99: number; chainMed: number; chainIqr: number;
  refDays: number;
};
function computeFoldStats(rows: Proto[], refDays: number): FoldStats {
  const xs = rows.map((p) => log10(p.tvl_usd / FLOOR_USD)).sort((a, b) => a - b);
  const third = Math.floor(xs.length / 3);
  const k1 = xs[third] ?? 0;
  const k2 = xs[2 * third] ?? 0;
  const growths = rows.map((p) => p.change_7d).filter((v): v is number => v !== null);
  const absG = growths.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const growS = absG.length > 0 ? median(absG) : 1;
  const growT = growths.map((g) => Math.asinh(g / (growS === 0 ? 1 : growS)));
  const ages = rows.map((p) => daysTracked(p, refDays)).filter((v): v is number => v !== null).map((d) => Math.log1p(d));
  const chains = rows.map((p) => (Array.isArray(p.chains) ? p.chains.length : 0)).map((k) => Math.log1p(k));
  const winsor = (a: number[]): { p1: number; p99: number; med: number; iqr: number } => {
    if (a.length === 0) return { p1: 0, p99: 0, med: 0, iqr: 1 };
    const p1 = percentile(a, 0.01);
    const p99 = percentile(a, 0.99);
    return { p1, p99, med: median(a.map((v) => clamp(v, p1, p99))), iqr: percentile(a, 0.75) - percentile(a, 0.25) };
  };
  const gw = winsor(growT);
  const aw = winsor(ages);
  const cw = winsor(chains);
  return {
    medTvl: median(rows.map((p) => p.tvl_usd)),
    k1, k2,
    growS: growS === 0 ? 1 : growS,
    growP1: gw.p1, growP99: gw.p99,
    growMed: gw.med,
    growIqr: gw.iqr,
    ageP1: aw.p1, ageP99: aw.p99,
    ageMed: aw.med,
    ageIqr: aw.iqr,
    chainP1: cw.p1, chainP99: cw.p99,
    chainMed: cw.med,
    chainIqr: cw.iqr,
    refDays,
  };
}
// Anonymous group IDs: distinct non-null category values, bytewise sorted.
// The model never sees a literal category value.
function groupIdMap(rows: Proto[]): Map<string, number> {
  const vals = [...new Set(rows.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  return new Map(vals.map((v, i) => [v, i]));
}
type ColMeta = { kind: 'intercept' | 'form' | 'feat' | 'miss'; feat?: string };
function featureValue(p: Proto, feat: string, st: FoldStats): { v: number; miss: number } {
  if (feat === 'G') {
    if (p.change_7d === null) return { v: 0, miss: 1 };
    const t = clamp(Math.asinh(p.change_7d / st.growS), st.growP1, st.growP99);
    return { v: st.growIqr === 0 ? 0 : (t - st.growMed) / st.growIqr, miss: 0 };
  }
  if (feat === 'A') {
    const d = daysTracked(p, st.refDays);
    if (d === null) return { v: 0, miss: 1 };
    const t = clamp(Math.log1p(d), st.ageP1, st.ageP99);
    return { v: st.ageIqr === 0 ? 0 : (t - st.ageMed) / st.ageIqr, miss: 0 };
  }
  const k = Array.isArray(p.chains) ? p.chains.length : -1;
  if (k < 0) return { v: 0, miss: 1 };
  const t = clamp(Math.log1p(k), st.chainP1, st.chainP99);
  return { v: st.chainIqr === 0 ? 0 : (t - st.chainMed) / st.chainIqr, miss: 0 };
}
function formBasis(p: Proto, form: FormSel, st: FoldStats): { lad: number[]; glo: number[]; meta: ColMeta[] } {
  const x = log10(p.tvl_usd / FLOOR_USD);
  const glo = [1, x];
  if (form.kind === 'global') return { lad: glo, glo, meta: [{ kind: 'intercept' }, { kind: 'form' }] };
  if (form.kind === 'offset') {
    const xo = log10((p.tvl_usd + form.q * st.medTvl) / FLOOR_USD);
    const o = [1, xo];
    return { lad: o, glo: o, meta: [{ kind: 'intercept' }, { kind: 'form' }] };
  }
  const lad = [1, x, Math.max(0, x - st.k1), Math.max(0, x - st.k2)];
  return {
    lad, glo,
    meta: [{ kind: 'intercept' }, { kind: 'form' }, { kind: 'form' }, { kind: 'form' }],
  };
}
function buildRow(p: Proto, cfg: PipeCfg, st: FoldStats): { lad: number[]; glo: number[]; meta: ColMeta[] } {
  const fb = formBasis(p, cfg.form, st);
  const lad = [...fb.lad];
  const glo = [...fb.glo];
  const meta = [...fb.meta];
  for (const feat of ['G', 'A', 'C']) {
    if ((cfg.subset & ({ G: 1, A: 2, C: 4 } as Record<string, number>)[feat]!) === 0) continue;
    const fv = featureValue(p, feat, st);
    lad.push(fv.v, fv.miss);
    glo.push(fv.v, fv.miss);
    meta.push({ kind: 'feat', feat }, { kind: 'miss', feat });
  }
  return { lad, glo, meta };
}
function clampCoefs(beta: number[], meta: ColMeta[]): number[] {
  return beta.map((b, j) => {
    if (meta[j]?.kind === 'feat') return clamp(b, -COEF_BOUND_DEX, COEF_BOUND_DEX);
    if (meta[j]?.kind === 'miss') return clamp(b, -MISSING_BOUND_DEX, MISSING_BOUND_DEX);
    return b;
  });
}
type FittedPipe = {
  cfg: PipeCfg; stats: FoldStats; groupMap: Map<string, number>;
  betaLad: number[]; betaGlo: number[]; meta: ColMeta[];
  offsets: Map<number, number>; groupSizes: Map<number, number>;
  trainMinTvl: number; trainMaxTvl: number; converged: boolean;
};
function fitBase(rows: Proto[], cfg: PipeCfg, st: FoldStats, offset: number[]): { betaLad: number[]; betaGlo: number[]; meta: ColMeta[]; w: number[]; converged: boolean } {
  const built = rows.map((p) => buildRow(p, cfg, st));
  const Xlad = built.map((b) => b.lad);
  const Xglo = built.map((b) => b.glo);
  const y = rows.map((p) => log10(p.mcap_usd!));
  const fL = huberFit(Xlad, y, offset);
  const fG = cfg.form.kind === 'ladder' ? huberFit(Xglo, y, offset) : fL;
  return {
    betaLad: clampCoefs(fL.beta, built[0]!.meta),
    betaGlo: clampCoefs(fG.beta, built[0]!.meta),
    meta: built[0]!.meta,
    w: fL.w,
    converged: fL.converged && fG.converged,
  };
}
function predictBase(pipe: FittedPipe, p: Proto): number {
  const b = buildRow(p, pipe.cfg, pipe.stats);
  const lad = dot(b.lad, pipe.betaLad);
  if (pipe.cfg.form.kind !== 'ladder') return lad;
  const glo = dot(b.glo, pipe.betaGlo);
  const lam = (pipe.cfg.form as { lambda: number }).lambda;
  return lam * lad + (1 - lam) * glo;
}
function groupOffset(pipe: FittedPipe, p: Proto): number {
  if (p.category === null) return 0;
  const id = pipe.groupMap.get(p.category);
  if (id === undefined) return 0;
  return pipe.offsets.get(id) ?? 0;
}
function predictPipe(pipe: FittedPipe, p: Proto): number {
  return predictBase(pipe, p) + groupOffset(pipe, p);
}
function ladderSlopesOK(pipe: FittedPipe): boolean {
  if (pipe.cfg.form.kind !== 'ladder') return true;
  const b = pipe.betaLad;
  const lam = (pipe.cfg.form as { lambda: number }).lambda;
  const bg = pipe.betaGlo[1]!;
  const s1 = lam * b[1]! + (1 - lam) * bg;
  const s2 = lam * (b[1]! + b[2]!) + (1 - lam) * bg;
  const s3 = lam * (b[1]! + b[2]! + b[3]!) + (1 - lam) * bg;
  return [s1, s2, s3].every((s) => s >= LADDER_SLOPE_RANGE[0] && s <= LADDER_SLOPE_RANGE[1]);
}
function fitPipeline(rows: Proto[], cfgIn: PipeCfg, refDays: number): FittedPipe {
  const cfg: PipeCfg = { form: { ...cfgIn.form } as FormSel, subset: cfgIn.subset, groupLambda: cfgIn.groupLambda };
  const st = computeFoldStats(rows, refDays);
  const groupMap = groupIdMap(rows);
  const groupOf = (p: Proto): number | null => (p.category === null ? null : groupMap.get(p.category) ?? null);
  const zeros = new Array<number>(rows.length).fill(0);
  let fit = fitBase(rows, cfg, st, zeros);
  // Ladder slope constraint: force lambda down one grid step and refit.
  if (cfg.form.kind === 'ladder') {
    const grid = [0, 0.25, 0.5, 0.75, 1];
    let guard = 0;
    while (guard++ < 5) {
      const probe: FittedPipe = {
        cfg, stats: st, groupMap, betaLad: fit.betaLad, betaGlo: fit.betaGlo, meta: fit.meta,
        offsets: new Map(), groupSizes: new Map(), trainMinTvl: 0, trainMaxTvl: 0, converged: fit.converged,
      };
      if (ladderSlopesOK(probe)) break;
      const cur = (cfg.form as { lambda: number }).lambda;
      const idx = grid.indexOf(cur);
      if (idx <= 0) break;
      (cfg.form as { lambda: number }).lambda = grid[idx - 1]!;
      fit = fitBase(rows, cfg, st, zeros);
    }
  }
  // Group effects: at most two passes (base fit, effects, refit, recompute, stop).
  const groupSizes = new Map<number, number>();
  for (const p of rows) {
    const g = groupOf(p);
    if (g !== null) groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);
  }
  const computeOffsets = (resid: number[], w: number[]): Map<number, number> => {
    const out = new Map<number, number>();
    if (cfg.groupLambda === Infinity) return out;
    const sums = new Map<number, { sw: number; sr: number }>();
    rows.forEach((p, i) => {
      const g = groupOf(p);
      if (g === null) return;
      const acc = sums.get(g) ?? { sw: 0, sr: 0 };
      acc.sw += w[i]!;
      acc.sr += w[i]! * resid[i]!;
      sums.set(g, acc);
    });
    for (const [g, acc] of sums) {
      if (acc.sw === 0) continue;
      const rbar = acc.sr / acc.sw;
      const n = groupSizes.get(g) ?? 0;
      const u = (n / (n + cfg.groupLambda)) * rbar;
      out.set(g, clamp(u, -GROUP_OFFSET_BOUND_DEX, GROUP_OFFSET_BOUND_DEX));
    }
    return out;
  };
  const residOf = (beta: { betaLad: number[]; betaGlo: number[]; meta: ColMeta[] }, off: number[]): number[] => {
    const probe: FittedPipe = {
      cfg, stats: st, groupMap, betaLad: beta.betaLad, betaGlo: beta.betaGlo, meta: beta.meta,
      offsets: new Map(), groupSizes, trainMinTvl: 0, trainMaxTvl: 0, converged: true,
    };
    return rows.map((p, i) => log10(p.mcap_usd!) - predictBase(probe, p) - off[i]!);
  };
  let offsets = computeOffsets(residOf(fit, zeros), fit.w);
  const offArr = rows.map((p) => {
    const g = groupOf(p);
    return g === null ? 0 : offsets.get(g) ?? 0;
  });
  if (offsets.size > 0) {
    const fit2 = fitBase(rows, cfg, st, offArr);
    // Recompute effects fresh against the refitted base (not against residuals
    // that already had the old offsets removed).
    const resid2 = residOf(fit2, zeros);
    offsets = computeOffsets(resid2, fit2.w);
    fit = fit2;
  }
  const tvls = rows.map((p) => p.tvl_usd);
  return {
    cfg, stats: st, groupMap,
    betaLad: fit.betaLad, betaGlo: fit.betaGlo, meta: fit.meta,
    offsets, groupSizes,
    trainMinTvl: Math.min(...tvls), trainMaxTvl: Math.max(...tvls),
    converged: fit.converged,
  };
}
// Inner 5-fold CV: pooled out-of-fold predictions, no cap (cap is ablated separately).
function innerCV(rows: Proto[], cfg: PipeCfg, refDays: number): { preds: Map<string, number>; actual: Map<string, number>; medAbs: number; spear: number } {
  const sorted = [...rows].sort((a, b) => (log10(a.tvl_usd) - log10(b.tvl_usd)) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const preds = new Map<string, number>();
  const actual = new Map<string, number>();
  for (let fold = 0; fold < INNER_FOLDS; fold++) {
    const held = sorted.filter((_, i) => i % INNER_FOLDS === fold);
    const train = sorted.filter((_, i) => i % INNER_FOLDS !== fold);
    if (train.length === 0 || held.length === 0) continue;
    const pipe = fitPipeline(train, cfg, refDays);
    for (const p of held) {
      preds.set(p.slug, predictPipe(pipe, p));
      actual.set(p.slug, log10(p.mcap_usd!));
    }
  }
  const keys = [...preds.keys()];
  const pv = keys.map((k) => preds.get(k)!);
  const av = keys.map((k) => actual.get(k)!);
  return { preds, actual, medAbs: medianAbsLogErr(pv, av), spear: spearman(pv, av) };
}
// Cap application: neighbourhood max from training comps only.
function cappedValue(valueUsd: number, tvl: number, trainComps: Proto[], s: number): number {
  let m = 0;
  for (const c of trainComps) {
    if (c.tvl_usd >= tvl / 3 && c.tvl_usd <= tvl * 3) m = Math.max(m, c.mcap_usd!);
  }
  if (m === 0) return valueUsd;
  return Math.min(valueUsd, m * (1 + s));
}

// ---------------------------------------------------------------- selection (v2 spec V0-V2)
type FormEval = { label: string; form: FormSel; simplicity: number; medAbs: number; spear: number };
function selectForm(rows: Proto[], refDays: number): { form: FormSel; table: FormEval[] } {
  const cands: { label: string; form: FormSel; simplicity: number }[] = [
    { label: 'global', form: { kind: 'global' }, simplicity: 0 },
    ...OFFSET_Q_GRID.map((q) => ({ label: `off ${q}`, form: { kind: 'offset', q } as FormSel, simplicity: 1 })),
    ...LADDER_LAMBDA_GRID.map((lambda) => ({ label: `lad ${lambda}`, form: { kind: 'ladder', lambda } as FormSel, simplicity: 2 })),
  ];
  const table: FormEval[] = cands.map((c) => {
    const r = innerCV(rows, { form: c.form, subset: 0, groupLambda: Infinity }, refDays);
    return { label: c.label, form: c.form, simplicity: c.simplicity, medAbs: r.medAbs, spear: r.spear };
  });
  const best = Math.min(...table.map((t) => t.medAbs));
  const tied = table.filter((t) => t.medAbs <= best + TIE_DEX);
  const maxSpear = Math.max(...tied.map((t) => t.spear));
  const spearTied = tied.filter((t) => t.spear >= maxSpear - TIE_SPEARMAN);
  spearTied.sort((a, b) => (a.simplicity - b.simplicity) || (a.medAbs - b.medAbs));
  return { form: spearTied[0]!.form, table };
}
type SubsetEval = { subset: number; name: string; medAbs: number; spear: number; admitted: boolean };
function selectSubset(rows: Proto[], form: FormSel, refDays: number): { subset: number; table: SubsetEval[] } {
  const evals: Omit<SubsetEval, 'admitted'>[] = [];
  for (let s = 0; s < 8; s++) {
    const r = innerCV(rows, { form, subset: s, groupLambda: Infinity }, refDays);
    evals.push({ subset: s, name: SUBSET_NAMES[s]! || 'TVL', medAbs: r.medAbs, spear: r.spear });
  }
  const base = evals[0]!;
  const bestErr = Math.min(...evals.map((e) => e.medAbs));
  const bestErrRow = evals.find((e) => e.medAbs === bestErr)!;
  const table: SubsetEval[] = evals.map((e) => ({
    ...e,
    admitted:
      e.medAbs <= base.medAbs - SUBSET_ERR_DEX ||
      (e.medAbs <= bestErr + TIE_DEX && e.spear >= bestErrRow.spear + SUBSET_SPEARMAN),
  }));
  const admitted = table.filter((t) => t.admitted);
  if (admitted.length === 0) return { subset: 0, table };
  const bestAdmittedErr = Math.min(...admitted.map((t) => t.medAbs));
  const nearBest = admitted.filter((t) => t.medAbs <= bestAdmittedErr + TIE_DEX);
  nearBest.sort((a, b) => (popcount(a.subset) - popcount(b.subset)) || (a.medAbs - b.medAbs) || (a.subset - b.subset));
  return { subset: nearBest[0]!.subset, table };
}
function popcount(n: number): number {
  let c = 0;
  while (n > 0) {
    c += n & 1;
    n >>= 1;
  }
  return c;
}
type GroupEval = { lambda: number; label: string; medAbs: number; spear: number };
function selectGroupLambda(rows: Proto[], form: FormSel, subset: number, refDays: number): { lambda: number; table: GroupEval[] } {
  const table: GroupEval[] = GROUP_LAMBDA_GRID.map((lambda) => {
    const r = innerCV(rows, { form, subset, groupLambda: lambda }, refDays);
    return { lambda, label: lambda === Infinity ? '∞' : `${lambda}`, medAbs: r.medAbs, spear: r.spear };
  });
  const best = Math.min(...table.map((t) => t.medAbs));
  const tied = table.filter((t) => t.medAbs <= best + TIE_DEX);
  tied.sort((a, b) => b.lambda - a.lambda); // larger lambda = more shrinkage wins ties.
  return { lambda: tied[0]!.lambda, table };
}
// Cap strength by inner CV on a training set (predictions capped in log space).
// One fit per inner fold; all four s values are evaluated on the same OOF predictions.
function selectCapS(trainRows: Proto[], cfg: PipeCfg, refDays: number): { s: number; table: { s: number; medAbs: number }[] } {
  const sorted = [...trainRows].sort((a, b) => (log10(a.tvl_usd) - log10(b.tvl_usd)) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const perS: { s: number; preds: number[]; actual: number[] }[] = CAP_S_GRID.map((s) => ({ s, preds: [], actual: [] }));
  for (let fold = 0; fold < INNER_FOLDS; fold++) {
    const held = sorted.filter((_, i) => i % INNER_FOLDS === fold);
    const innerTrain = sorted.filter((_, i) => i % INNER_FOLDS !== fold);
    if (innerTrain.length === 0 || held.length === 0) continue;
    const pipe = fitPipeline(innerTrain, cfg, refDays);
    for (const p of held) {
      const v = Math.pow(10, predictPipe(pipe, p));
      for (const entry of perS) {
        entry.preds.push(log10(cappedValue(v, p.tvl_usd, innerTrain, entry.s)));
        entry.actual.push(log10(p.mcap_usd!));
      }
    }
  }
  const table = perS.map((e) => ({ s: e.s, medAbs: medianAbsLogErr(e.preds, e.actual) }));
  table.sort((a, b) => (a.medAbs - b.medAbs) || (a.s - b.s));
  return { s: table[0]!.s, table };
}
// ---------------------------------------------------------------- nested LOO (V0)
type OofRow = {
  slug: string; actual: number; challenger: number; deflt: number; flat: number;
  formLabel: string; subset: number; groupLambda: number;
};
const DEFAULT_CFG: PipeCfg = { form: { kind: 'global' }, subset: 0, groupLambda: Infinity };
function formLabel(f: FormSel): string {
  if (f.kind === 'global') return 'global';
  if (f.kind === 'offset') return `offset q=${f.q}`;
  return `ladder λ=${f.lambda}`;
}
function fitDefault(train: Proto[], refDays: number): FittedPipe {
  return fitPipeline(train, DEFAULT_CFG, refDays);
}
function flatPredict(train: Proto[], p: Proto): number {
  const ratios = train.map((c) => log10(c.mcap_usd! / c.tvl_usd));
  return log10(p.tvl_usd) + median(ratios);
}
function nestedLOO(comps: Proto[], refDays: number): { rows: OofRow[]; stageSummary: { forms: Record<string, number>; subsets: Record<string, number>; lambdas: Record<string, number> } } {
  const rows: OofRow[] = [];
  const stageSummary = { forms: {} as Record<string, number>, subsets: {} as Record<string, number>, lambdas: {} as Record<string, number> };
  const sorted = [...comps].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const held of sorted) {
    const train = sorted.filter((c) => c.slug !== held.slug);
    const { form } = selectForm(train, refDays);
    const { subset } = selectSubset(train, form, refDays);
    const { lambda } = selectGroupLambda(train, form, subset, refDays);
    const pipe = fitPipeline(train, { form, subset, groupLambda: lambda }, refDays);
    const defPipe = fitDefault(train, refDays);
    const fl = formLabel(form);
    stageSummary.forms[fl] = (stageSummary.forms[fl] ?? 0) + 1;
    stageSummary.subsets[SUBSET_NAMES[subset]! || '(TVL only)'] = (stageSummary.subsets[SUBSET_NAMES[subset]! || '(TVL only)'] ?? 0) + 1;
    const lamLabel = lambda === Infinity ? '∞' : String(lambda);
    stageSummary.lambdas[lamLabel] = (stageSummary.lambdas[lamLabel] ?? 0) + 1;
    rows.push({
      slug: held.slug,
      actual: log10(held.mcap_usd!),
      challenger: predictPipe(pipe, held),
      deflt: predictPipe(defPipe, held),
      flat: flatPredict(train, held),
      formLabel: fl, subset, groupLambda: lambda,
    });
  }
  return { rows, stageSummary };
}
// Paired 90% bootstrap lower bound on the median-error improvement (challenger vs default).
function pairedBootstrapGate(challErr: number[], defErr: number[]): { lower90: number; medianImprove: number; pass: boolean } {
  const rnd = mulberry32(BOOT_SEED);
  const n = challErr.length;
  const diffs: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    const c: number[] = [];
    const d: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      c.push(challErr[j]!);
      d.push(defErr[j]!);
    }
    diffs.push(median(d) - median(c));
  }
  diffs.sort((a, b) => a - b);
  const lower90 = diffs[Math.floor(0.05 * diffs.length)]!;
  const medianImprove = median(defErr) - median(challErr);
  return { lower90, medianImprove, pass: lower90 > 0 };
}
// Frozen 70/30 chronological audit: select ONLY on the 70% train, read the 30% once.
function timeSplitAudit(comps: Proto[], refDays: number): {
  boundary: string; trainN: number; testN: number;
  challMedAbs: number; defMedAbs: number; flatMedAbs: number;
  challSpear: number; deteriorationDex: number; pass: boolean;
  testPreds: { slug: string; actual: number; pred: number }[];
} {
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const boundary = train.length > 0 ? train[train.length - 1]!.listed_at! : 'n/a';
  const { form } = selectForm(train, refDays);
  const { subset } = selectSubset(train, form, refDays);
  const { lambda } = selectGroupLambda(train, form, subset, refDays);
  const pipe = fitPipeline(train, { form, subset, groupLambda: lambda }, refDays);
  const defPipe = fitDefault(train, refDays);
  const cp: number[] = [];
  const dp: number[] = [];
  const fp: number[] = [];
  const av: number[] = [];
  const testPreds: { slug: string; actual: number; pred: number }[] = [];
  for (const p of test) {
    cp.push(predictPipe(pipe, p));
    dp.push(predictPipe(defPipe, p));
    fp.push(flatPredict(train, p));
    av.push(log10(p.mcap_usd!));
    testPreds.push({ slug: p.slug, actual: log10(p.mcap_usd!), pred: predictPipe(pipe, p) });
  }
  const challMedAbs = medianAbsLogErr(cp, av);
  const defMedAbs = medianAbsLogErr(dp, av);
  const deteriorationDex = challMedAbs - defMedAbs;
  return {
    boundary, trainN: train.length, testN: test.length,
    challMedAbs, defMedAbs, flatMedAbs: medianAbsLogErr(fp, av),
    challSpear: spearman(cp, av), deteriorationDex,
    pass: deteriorationDex <= TIME_SPLIT_MAX_DETERIORATION_DEX,
    testPreds,
  };
}
// Permutation diagnostic: does the real grouping beat shuffled group IDs?
function permutationDiagnostic(comps: Proto[], cfg: PipeCfg, refDays: number): {
  realMedAbs: number; permMean: number; permP5: number; permP95: number; fracBeatReal: number; signal: boolean;
} {
  const real = innerCV(comps, cfg, refDays).medAbs;
  const cats = comps.map((p) => p.category);
  const errs: number[] = [];
  for (let k = 0; k < PERMUTATIONS; k++) {
    const shuffled = seededShuffle(cats, RANK_SEED + k + 7);
    const permuted = comps.map((p, i) => ({ ...p, category: shuffled[i]! }));
    errs.push(innerCV(permuted, cfg, refDays).medAbs);
  }
  errs.sort((a, b) => a - b);
  const fracBeatReal = errs.filter((e) => e < real).length / errs.length;
  return {
    realMedAbs: real,
    permMean: mean(errs),
    permP5: percentile(errs, 0.05),
    permP95: percentile(errs, 0.95),
    fracBeatReal,
    signal: real < percentile(errs, 0.05),
  };
}
// Sensitivity: (a) drop the 10% highest-leverage comps, (b) widen the integrity window.
function sensitivityReport(comps: Proto[], wideComps: Proto[], refDays: number): {
  baseSlope: number; noLeverageSlope: number; noLeverageMovePct: number;
  wideCount: number; wideSlope: number; wideMovePct: number; fragile: boolean;
} {
  const basePipe = fitDefault(comps, refDays);
  const baseSlope = basePipe.betaGlo[1]!;
  // Hat-matrix diagonals from the global OLS design.
  const X = comps.map((p) => [1, log10(p.tvl_usd / FLOOR_USD)]);
  const XtX: number[][] = [[0, 0], [0, 0]];
  for (const xi of X) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) XtX[a]![b] += xi[a]! * xi[b]!;
  const inv = solveLinear(XtX, [1, 0]);
  const inv2 = solveLinear(XtX, [0, 1]);
  const lev = X.map((xi) => {
    if (inv === null || inv2 === null) return 0;
    const v0 = inv[0]! * xi[0]! + inv2[0]! * xi[1]!;
    const v1 = inv[1]! * xi[0]! + inv2[1]! * xi[1]!;
    return xi[0]! * v0 + xi[1]! * v1;
  });
  const order = lev.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const dropN = Math.max(1, Math.floor(comps.length * 0.1));
  const drop = new Set(order.slice(0, dropN).map((o) => o.i));
  const kept = comps.filter((_, i) => !drop.has(i));
  const noLevSlope = fitDefault(kept, refDays).betaGlo[1]!;
  const noLevMove = Math.abs(noLevSlope - baseSlope) / Math.abs(baseSlope) * 100;
  const wideSlope = fitDefault(wideComps, refDays).betaGlo[1]!;
  const wideMove = Math.abs(wideSlope - baseSlope) / Math.abs(baseSlope) * 100;
  return {
    baseSlope, noLeverageSlope: noLevSlope, noLeverageMovePct: noLevMove,
    wideCount: wideComps.length, wideSlope, wideMovePct: wideMove,
    fragile: noLevMove > 15 || wideMove > 15,
  };
}

// ---------------------------------------------------------------- bands (V5: v1 stratified split-conformal, UNCHANGED)
function bandStratum(p: Proto, refDays: number, groupMap: Map<string, number>, groupSizes: Map<number, number>): number {
  if (daysTracked(p, refDays) === null) return 3; // missing tracking tenure.
  if (p.change_7d === null) return 2; // incomplete features.
  if (p.category !== null) {
    const id = groupMap.get(p.category);
    if (id !== undefined && (groupSizes.get(id) ?? 0) >= 6) return 1; // complete + calibrated group.
  }
  return 2; // complete + uncalibrated / null group.
}
type BandQuants = { q10: number; q25: number; q75: number; q90: number };
function quantilesFromErrors(errs: number[]): BandQuants {
  const s = [...errs].sort((a, b) => a - b);
  return { q10: quantileSorted(s, 0.1), q25: quantileSorted(s, 0.25), q75: quantileSorted(s, 0.75), q90: quantileSorted(s, 0.9) };
}
function buildBands(
  oof: { slug: string; actual: number; pred: number; stratum: number }[],
): { strata: BandQuants[]; pooled: BandQuants; looCov50: number; looCov80: number } {
  const pooled = quantilesFromErrors(oof.map((r) => r.actual - r.pred));
  const strata: BandQuants[] = [];
  for (let s = 1; s <= 3; s++) {
    const errs = oof.filter((r) => r.stratum === s).map((r) => r.actual - r.pred);
    const qs = quantilesFromErrors(errs);
    const w = errs.length / (errs.length + 15); // small-stratum shrinkage toward pooled.
    strata.push({
      q10: w * qs.q10 + (1 - w) * pooled.q10,
      q25: w * qs.q25 + (1 - w) * pooled.q25,
      q75: w * qs.q75 + (1 - w) * pooled.q75,
      q90: w * qs.q90 + (1 - w) * pooled.q90,
    });
  }
  // Nested LOO coverage: each row's quantiles exclude that row's own error.
  let in50 = 0;
  let in80 = 0;
  for (let i = 0; i < oof.length; i++) {
    const row = oof[i]!;
    const rest = oof.filter((_, j) => j !== i);
    const pooledR = quantilesFromErrors(rest.map((r) => r.actual - r.pred));
    const sErrs = rest.filter((r) => r.stratum === row.stratum).map((r) => r.actual - r.pred);
    const qs = quantilesFromErrors(sErrs);
    const w = sErrs.length / (sErrs.length + 15);
    const q: BandQuants = {
      q10: w * qs.q10 + (1 - w) * pooledR.q10,
      q25: w * qs.q25 + (1 - w) * pooledR.q25,
      q75: w * qs.q75 + (1 - w) * pooledR.q75,
      q90: w * qs.q90 + (1 - w) * pooledR.q90,
    };
    const e = row.actual - row.pred;
    if (row.pred + q.q25 <= row.actual && row.actual <= row.pred + q.q75) in50++;
    if (row.pred + q.q10 <= row.actual && row.actual <= row.pred + q.q90) in80++;
    void e;
  }
  return { strata, pooled, looCov50: in50 / oof.length, looCov80: in80 / oof.length };
}
// ---------------------------------------------------------------- rank intervals (V5: rank-percentile conformal)
function rankCalibration(comps: Proto[], cfg: PipeCfg, refDays: number): {
  qFinal: number; crossCoverage: number; crossMedianWidthRanks: number; crossP90WidthRanks: number;
} {
  const shuffled = seededShuffle(comps, RANK_SEED);
  const pctOf = (vals: number[], v: number): number => {
    let greater = 0;
    for (const x of vals) if (x > v) greater++;
    return greater / vals.length;
  };
  const widths: number[] = [];
  let covered = 0;
  let total = 0;
  for (let fold = 0; fold < 5; fold++) {
    const outerFold = shuffled.filter((_, i) => i % 5 === fold);
    const rest = shuffled.filter((_, i) => i % 5 !== fold);
    const restShuffled = seededShuffle(rest, RANK_SEED + fold + 1);
    const fitN = Math.floor(restShuffled.length * 0.6);
    const fitSet = restShuffled.slice(0, fitN);
    const calSet = restShuffled.slice(fitN);
    const pipe = fitPipeline(fitSet, cfg, refDays);
    const predAll = comps.map((p) => predictPipe(pipe, p));
    const actAll = comps.map((p) => log10(p.mcap_usd!));
    const calErrs = calSet.map((p) => {
      const idx = comps.indexOf(p);
      return Math.abs(pctOf(predAll, predAll[idx]!) - pctOf(actAll, actAll[idx]!));
    });
    const qCal = quantileSorted([...calErrs].sort((a, b) => a - b), 0.8);
    for (const p of outerFold) {
      const idx = comps.indexOf(p);
      const pp = pctOf(predAll, predAll[idx]!);
      const ap = pctOf(actAll, actAll[idx]!);
      const lo = Math.max(0, pp - qCal);
      const hi = Math.min(1, pp + qCal);
      if (ap >= lo && ap <= hi) covered++;
      widths.push((hi - lo) * comps.length);
      total++;
    }
  }
  widths.sort((a, b) => a - b);
  // Shipped quantile: final 60/40 fit/calibration split on all comps.
  const allShuffled = seededShuffle(comps, RANK_SEED);
  const fitN = Math.floor(allShuffled.length * 0.6);
  const fitSet = allShuffled.slice(0, fitN);
  const calSet = allShuffled.slice(fitN);
  const pipeF = fitPipeline(fitSet, cfg, refDays);
  const predAllF = comps.map((p) => predictPipe(pipeF, p));
  const actAllF = comps.map((p) => log10(p.mcap_usd!));
  const calErrsF = calSet.map((p) => {
    const idx = comps.indexOf(p);
    return Math.abs(pctOf(predAllF, predAllF[idx]!) - pctOf(actAllF, actAllF[idx]!));
  });
  const qFinal = quantileSorted([...calErrsF].sort((a, b) => a - b), 0.8);
  return {
    qFinal,
    crossCoverage: total > 0 ? covered / total : NaN,
    crossMedianWidthRanks: median(widths),
    crossP90WidthRanks: percentile(widths, 0.9),
  };
}
function rankInterval(rank: number, nBoard: number, q: number): { best: number; worst: number } {
  const p = (rank - 0.5) / nBoard;
  const lo = Math.max(0, p - q);
  const hi = Math.min(1, p + q);
  return { best: clamp(Math.floor(lo * nBoard) + 1, 1, nBoard), worst: clamp(Math.ceil(hi * nBoard), 1, nBoard) };
}
// ---------------------------------------------------------------- farm economics (spec section 3)
function gasTier(chain0: string): [number, number, number] {
  if (ETH_CHAINS.has(chain0)) return GAS_TIERS.eth!;
  if (ALT_CHAINS.has(chain0)) return GAS_TIERS.alt!;
  if (L2_CHAINS.has(chain0)) return GAS_TIERS.l2!;
  return GAS_TIERS.other!;
}
type Econ = {
  deposit: number; dropShare: number; share: number; gross50: number; gross25: number;
  gasLow: number; gasBase: number; gasHigh: number; oppCost: number;
  totalBase: number; totalHigh: number; net50: number; net25: number; netHr: number;
  pBe: number; alphaBe: number; fdvBe: number; dMin: number; dMax: number;
  tDays: number; tHours: number; verdict: string; researchReason: string;
};
function holdDays(days: number | null): number {
  if (days === null || days < 365) return 45;
  if (days < 730) return 60;
  return 75;
}
function computeFarmEconomics(
  p: Proto, implied: number, p25: number, days: number | null,
  groupSize: number, peerRate: number, deposit = ASSUMED.deposit, dropShare = ASSUMED.dropShare,
): Econ {
  const nChains = Array.isArray(p.chains) ? p.chains.length : 1;
  const [gasLow, gasBase, gasHigh] = gasTier(p.chains[0] ?? '');
  const multi = nChains >= 2;
  const gLow = gasLow + (multi ? GAS_MULTI[0] : 0);
  const gBase = gasBase + (multi ? GAS_MULTI[1] : 0);
  const gHigh = gasHigh + (multi ? GAS_MULTI[2] : 0);
  const tDays = holdDays(days);
  const tHours = Math.min(ASSUMED.maxHours, ASSUMED.baseHours + ASSUMED.extraChainHours * Math.max(0, nChains - 1));
  const share = deposit / (p.tvl_usd * ASSUMED.dilution);
  const gross50 = implied * dropShare * share;
  const gross25 = p25 * dropShare * share;
  const oppCost = deposit * ASSUMED.oppApr * (tDays / 365);
  const totalBase = gBase + oppCost;
  const totalHigh = gHigh + oppCost;
  const net50 = gross50 - totalBase;
  const net25 = gross25 - totalHigh;
  const netHr = net50 / tHours;
  const pBe = gross50 > 0 ? Math.min(1, totalBase / gross50) : 2; // >1.0 = impossible.
  const alphaBe = implied * share > 0 ? totalBase / (implied * share) : Infinity;
  const fdvBe = dropShare * share > 0 ? totalBase / (dropShare * share) : Infinity;
  const dMin = implied * dropShare > 0 ? (2 * gBase * p.tvl_usd * ASSUMED.dilution) / (implied * dropShare) : Infinity;
  const dMax = Math.min(0.005 * p.tvl_usd, 50000);
  let verdict = 'Skip';
  let researchReason = '';
  const research =
    days === null ? 'tenure unverified (listed_at null)'
    : p.category === null ? 'category null (uncalibrated)'
    : groupSize < 6 ? `uncalibrated (only ${groupSize} comps in group)`
    : peerRate === 0 ? 'no traded peer (rate 0)'
    : '';
  if (research !== '') {
    verdict = 'Research only';
    researchReason = research;
  } else if (net50 > 0 && net25 > 0 && pBe <= 0.45 && netHr >= 25) verdict = 'Farm';
  else if (net50 > 0 && pBe <= 0.75) verdict = 'Marginal';
  return {
    deposit, dropShare, share, gross50, gross25,
    gasLow: gLow, gasBase: gBase, gasHigh: gHigh, oppCost,
    totalBase, totalHigh, net50, net25, netHr,
    pBe, alphaBe, fdvBe, dMin, dMax, tDays, tHours, verdict, researchReason,
  };
}
function categoryInteraction(category: string | null): string {
  if (category === 'Dexs') return 'execute the category-typical native interaction: a modest swap plus a small liquidity position';
  if (category === 'Lending') return 'execute the category-typical native interaction: supply within a safe loan-to-value and borrow nothing exotic';
  if (category === 'Derivatives') return 'execute the category-typical native interaction: modest hedged volume, no leveraged directional bet';
  return 'execute the category-typical native interaction for this protocol type (its core function, at modest size)';
}
function buildFarmPlan(p: Proto, e: Econ, days: number | null, chg: number | null, researchOnly: boolean): string[] {
  const shortName = p.name.length > 24 ? `${p.name.slice(0, 21)}...` : p.name;
  const cat = p.category ?? 'uncategorized';
  const chain0 = p.chains[0] ?? 'unknown chain';
  const multi = p.chains.length >= 2 ? ` (+${p.chains.length - 1} extra chain${p.chains.length > 2 ? 's' : ''} bridged)` : '';
  const chgTxt = chg === null ? '7d trend unreported' : `7d TVL ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
  const tenureTxt = days === null ? 'tenure unknown' : `${days}d tracked`;
  const core = researchOnly
    ? 'documentation verification only: read the docs, verify the flows, commit $0 capital'
    : categoryInteraction(p.category);
  const step1 = `Eligibility + dilution check (~10 min, $0): ${shortName} records no token; TVL ${fmtUsd(p.tvl_usd)} in ${cat}; deposit ${fmtUsd(e.deposit)} is ${(e.share * 100).toFixed(2)}% of TVL (cap 0.5%). Source: snapshot tvl_usd/category. Stop: abort if a non-retroactive snapshot cutoff is announced or TVL dilutes past 2x.`;
  const step2 = `Stage capital + gas budget (~15 min, assumed gas ${fmtUsd(e.gasBase)} base, ${fmtUsd(e.gasLow)}-${fmtUsd(e.gasHigh)} range): stage ${fmtUsd(e.deposit)} on ${chain0}${multi}; keep a reserve inside the high gas ceiling. Source: snapshot chains[0]; gas is an [ASSUMED] scenario, not a live quote. Stop: abort if a real bridging/gas quote exceeds ${fmtUsd(e.gasHigh)} before the first deposit.`;
  const step3 = `Core protocol interaction (~20 min, cost in gas base + opportunity cost): ${core}; note ${chgTxt}. Source: snapshot category + change_7d. Stop: exit if 7d TVL drops more than 35%.`;
  const step4 = `Tenure + retention cadence (${e.tDays} days, ~10 min/week, assumed opportunity cost ${fmtUsd(e.oppCost)} at 4.5% APR): maintain the position across ${e.tDays} days (${tenureTxt}); avoid idle dust churning. Source: snapshot listed_at maturity proxy. Stop: withdraw if the break-even FDV hurdle exceeds the P75 upside.`;
  const step5 = `Break-even + stress audit (~10 min, $0): conditional slice P50 ${fmtUsd(e.gross50)} vs P25 stress ${fmtUsd(e.gross25)} against total cost ${fmtUsd(e.totalBase)}; break-even launch odds ${e.pBe > 1 ? '>100% (impossible)' : fmtPct(e.pBe)}, break-even drop share ${fmtPct(e.alphaBe)}, net ${fmtUsd(e.netHr)}/hr. Source: fitted P25-P75 + hurdles. Stop: reclassify to Skip if dilution cuts net P50 below zero or the benchmark yield exceeds 4.5%.`;
  const action = e.verdict === 'Farm' ? 'execute the Farm verdict: unwind at the TGE announcement or the day cap, keeping the P25-tested slice'
    : e.verdict === 'Marginal' ? 'execute the Marginal verdict: unwind at the TGE announcement or the day cap, size stays at the assumed deposit'
    : e.verdict === 'Research only' ? 'execute the Research-only verdict: $0 committed capital, documentation verification and monitoring only'
    : 'execute the Skip verdict: deploy $0 and monitor only';
  const step6 = `Exit / unwind + verdict execution (~15 min, exit gas ~${fmtUsd(e.gasBase * 0.5)}): ${action}. Source: recomputed verdict (${e.verdict}). Stop: mandatory unwind at the ${e.tDays}-day cap.`;
  const steps = [step1, step2, step3, step4, step5, step6];
  for (const s of steps) {
    if (s.length < 60 || s.length > 420) throw new Error(`farm step length ${s.length} out of 60-420: ${s.slice(0, 80)}`);
  }
  return steps;
}

// ---------------------------------------------------------------- cap ablation (V2, after form/subset/group)
function capAblationOuter(comps: Proto[], cfg: PipeCfg, refDays: number): {
  selNoCap: number; selCap: number; gloNoCap: number; gloCap: number;
  capGate: { lower90: number; medianImprove: number; pass: boolean };
  sMode: number;
} {
  const selNoCapErr: number[] = [];
  const selCapErr: number[] = [];
  const gloNoCapErr: number[] = [];
  const gloCapErr: number[] = [];
  const sCounts = new Map<number, number>();
  const sorted = [...comps].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const held of sorted) {
    const train = sorted.filter((c) => c.slug !== held.slug);
    const pipe = fitPipeline(train, cfg, refDays);
    const { s } = selectCapS(train, cfg, refDays);
    sCounts.set(s, (sCounts.get(s) ?? 0) + 1);
    const ySel = predictPipe(pipe, held);
    const vSel = Math.pow(10, ySel);
    selNoCapErr.push(Math.abs(ySel - log10(held.mcap_usd!)));
    selCapErr.push(Math.abs(log10(cappedValue(vSel, held.tvl_usd, train, s)) - log10(held.mcap_usd!)));
    const defPipe = fitDefault(train, refDays);
    const { s: sG } = selectCapS(train, DEFAULT_CFG, refDays);
    const yGlo = predictPipe(defPipe, held);
    const vGlo = Math.pow(10, yGlo);
    gloNoCapErr.push(Math.abs(yGlo - log10(held.mcap_usd!)));
    gloCapErr.push(Math.abs(log10(cappedValue(vGlo, held.tvl_usd, train, sG)) - log10(held.mcap_usd!)));
  }
  const capGate = pairedBootstrapGate(selCapErr, selNoCapErr);
  let sMode = 0;
  let sBest = -1;
  for (const [s, n] of sCounts) if (n > sBest) {
    sBest = n;
    sMode = s;
  }
  return {
    selNoCap: median(selNoCapErr), selCap: median(selCapErr),
    gloNoCap: median(gloNoCapErr), gloCap: median(gloCapErr),
    capGate, sMode,
  };
}
// ---------------------------------------------------------------- board + outputs
type BoardRow = {
  slug: string; name: string; rank: number; implied_value_usd: number; farm_steps: string[];
  tvl_usd: number; category: string | null; chains: string[]; change_7d: number | null;
  listed_at: string | null; p25_usd: number; p75_usd: number; p10_usd: number; p90_usd: number;
  rank_best: number; rank_worst: number; verdict: string; p_be: number; net_per_hour_usd: number;
  peer_token_rate: number; watchlist: boolean; extrapolated: boolean; group_size: number;
  days_tracked: number | null; grp_off_dex: number; cap_max_usd: number | null;
};
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Infinity;
  let allEqual = board.length > 1;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${r.slug} has rank ${r.rank}, expected ${i + 1}`;
    if (!slugs.has(r.slug)) return `row ${r.slug} is not a snapshot protocol`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `row ${r.slug}: bad implied value`;
    if (r.implied_value_usd > prev) return `values rise at rank ${r.rank}`;
    if (r.implied_value_usd !== prev) allEqual = false;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug}: ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim().length;
      if (t < 20 || t > 600) return `row ${r.slug}: farm step of ${t} chars`;
    }
  }
  if (allEqual) return 'all implied values are equal';
  for (const w of snapshot.watchlist) if (!seen.has(w)) return `watchlist slug ${w} missing from board`;
  const outside = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  if (outside < 60) return `only ${outside} rows outside the watchlist`;
  return null;
}
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const t0 = Date.now();
  const inputArg = arg('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
    process.exit(2);
  }
  const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const refDays = asOfDays(snapshot.as_of);
  if (!Number.isFinite(refDays) || snapshot.as_of === '') throw new Error('snapshot as_of missing or unparseable');
  if (snapshot.floor_usd !== FLOOR_USD) throw new Error(`snapshot floor ${snapshot.floor_usd} is not ${FLOOR_USD}`);
  const watchSet = new Set(snapshot.watchlist);
  for (const w of snapshot.watchlist) {
    if (!snapshot.protocols.some((p) => p.slug === w)) throw new Error(`watchlist slug ${w} is not a protocol`);
  }
  // Watchlist invariant: every supplied watchlist slug passes the exclusion screen.
  const watchConflicts: string[] = [];
  for (const p of snapshot.protocols) {
    if (watchSet.has(p.slug) && classifyProtocol(p).primaryReason !== null) watchConflicts.push(p.slug);
  }
  if (watchConflicts.length > 0) throw new Error(`watchlist conflicts with screen: ${watchConflicts.join(',')}`);

  const { comps, rejected, rawCount } = selectTradedComps(snapshot);
  const wide = selectTradedComps(snapshot, RATIO_WINDOW_WIDE);
  const compSlugs = new Set(comps.map((c) => c.slug));

  // ---- nested LOO over the whole selection procedure (V0).
  const loo = nestedLOO(comps, refDays);
  const challErr = loo.rows.map((r) => Math.abs(r.challenger - r.actual));
  const defErr = loo.rows.map((r) => Math.abs(r.deflt - r.actual));
  const flatErr = loo.rows.map((r) => Math.abs(r.flat - r.actual));
  const looMetrics = {
    challMed: median(challErr), defMed: median(defErr), flatMed: median(flatErr),
    challSpear: spearman(loo.rows.map((r) => r.challenger), loo.rows.map((r) => r.actual)),
    defSpear: spearman(loo.rows.map((r) => r.deflt), loo.rows.map((r) => r.actual)),
    flatSpear: spearman(loo.rows.map((r) => r.flat), loo.rows.map((r) => r.actual)),
    hit2: loo.rows.filter((r) => Math.max(Math.pow(10, r.challenger - r.actual), Math.pow(10, r.actual - r.challenger)) <= 2).length / loo.rows.length,
    hit3: loo.rows.filter((r) => Math.max(Math.pow(10, r.challenger - r.actual), Math.pow(10, r.actual - r.challenger)) <= 3).length / loo.rows.length,
  };
  const gate = pairedBootstrapGate(challErr, defErr);

  // ---- final selection on all comps (inner 5-fold), then the cap ablation.
  const { form: finalForm, table: formTable } = selectForm(comps, refDays);
  const { subset: finalSubset, table: subsetTable } = selectSubset(comps, finalForm, refDays);
  const { lambda: finalLambda, table: groupTable } = selectGroupLambda(comps, finalForm, finalSubset, refDays);
  const selectedCfg: PipeCfg = { form: finalForm, subset: finalSubset, groupLambda: finalLambda };
  const shippedCfg: PipeCfg = gate.pass ? selectedCfg : DEFAULT_CFG;
  const capOuter = capAblationOuter(comps, shippedCfg, refDays);
  const { s: capSFull, table: capSTable } = selectCapS(comps, shippedCfg, refDays);
  const capShips = capOuter.capGate.pass;
  const capS = capShips ? capSFull : null;
  const finalPipe = fitPipeline(comps, shippedCfg, refDays);
  if (!finalPipe.converged) process.stderr.write('token radar: WARNING final Huber fit did not converge\n');

  // ---- time-split audit, permutation diagnostic, sensitivity.
  const audit = timeSplitAudit(comps, refDays);
  // Permutation diagnostic runs the group procedure at the best point-error
  // lambda from the group table: the selected lambda is infinity (no group
  // effect), which would make the diagnostic trivially empty.
  const bestGroupLambda = groupTable.reduce((best, t) => (t.medAbs < best.medAbs ? t : best), groupTable[0]!).lambda;
  const perm = permutationDiagnostic(comps, { form: selectedCfg.form, subset: selectedCfg.subset, groupLambda: bestGroupLambda }, refDays);
  const sens = sensitivityReport(comps, wide.comps, refDays);

  // ---- bands from the shipped procedure's OOF errors.
  const shippedOof = loo.rows.map((r) => ({
    slug: r.slug,
    actual: r.actual,
    pred: gate.pass ? r.challenger : r.deflt,
    stratum: bandStratum(comps.find((c) => c.slug === r.slug)!, refDays, finalPipe.groupMap, finalPipe.groupSizes),
  }));
  const bands = buildBands(shippedOof);
  // Time-split band coverage with the final quantiles.
  const tsCov = { cov50: 0, cov80: 0, n: audit.testPreds.length };
  for (const t of audit.testPreds) {
    const p = comps.find((c) => c.slug === t.slug)!;
    const st = bandStratum(p, refDays, finalPipe.groupMap, finalPipe.groupSizes);
    const extrap = p.tvl_usd < finalPipe.trainMinTvl || p.tvl_usd > finalPipe.trainMaxTvl;
    const q = extrap ? bands.pooled : bands.strata[st - 1]!;
    if (t.pred + q.q25 <= t.actual && t.actual <= t.pred + q.q75) tsCov.cov50++;
    if (t.pred + q.q10 <= t.actual && t.actual <= t.pred + q.q90) tsCov.cov80++;
  }
  const rankCal = rankCalibration(comps, shippedCfg, refDays);

  // ---- peer tokenization rates (eligible = passes screen, not on hold).
  // Group summary + unshrunk ladder shape for the dashboard's aggregate tables.
  const ladderShapePipe = fitPipeline(comps, { form: { kind: 'ladder', lambda: 1 }, subset: 0, groupLambda: Infinity }, refDays);
  const lb = ladderShapePipe.betaLad;
  const ladderShape = {
    lambda: 1,
    knots: [ladderShapePipe.stats.k1, ladderShapePipe.stats.k2],
    slopes: [lb[1]!, lb[1]! + lb[2]!, lb[1]! + lb[2]! + lb[3]!],
  };
  const groupSizeBands: Record<string, number> = { '1-2': 0, '3-5': 0, '6-19': 0, '20+': 0 };
  for (const n of finalPipe.groupSizes.values()) {
    if (n <= 2) groupSizeBands['1-2'] = (groupSizeBands['1-2'] ?? 0) + 1;
    else if (n <= 5) groupSizeBands['3-5'] = (groupSizeBands['3-5'] ?? 0) + 1;
    else if (n <= 19) groupSizeBands['6-19'] = (groupSizeBands['6-19'] ?? 0) + 1;
    else groupSizeBands['20+'] = (groupSizeBands['20+'] ?? 0) + 1;
  }
  const groupsSummary = {
    lambda: finalPipe.cfg.groupLambda === Infinity ? 'inf' : finalPipe.cfg.groupLambda,
    count: finalPipe.groupSizes.size,
    maxAbs: Math.max(0, ...[...finalPipe.offsets.values()].map((v) => Math.abs(v))),
    bands: groupSizeBands,
  };
  const eligible = snapshot.protocols.filter((p) => {
    const cl = classifyProtocol(p);
    return cl.holdReason === null && cl.primaryReason === null;
  });
  const tradedEligible = eligible.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const pGlobal = tradedEligible.length / eligible.length;
  const peerRateByCat = new Map<string, number>();
  const catsEligible = new Map<string, { n: number; k: number }>();
  for (const p of eligible) {
    const key = p.category ?? '\0null';
    const acc = catsEligible.get(key) ?? { n: 0, k: 0 };
    acc.n++;
    if (p.mcap_usd !== null && p.mcap_usd > 0) acc.k++;
    catsEligible.set(key, acc);
  }
  for (const [key, acc] of catsEligible) peerRateByCat.set(key, (acc.k + 5 * pGlobal) / (acc.n + 5));

  // ---- score every eligible pre-token protocol.
  const candidates = snapshot.protocols.filter((p) => {
    const cl = classifyProtocol(p);
    return cl.tokenStatus === 'pre' && cl.holdReason === null && cl.primaryReason === null;
  });
  const scored = candidates.map((p) => {
    const yhat = predictPipe(finalPipe, p);
    const uncapped = Math.pow(10, yhat);
    let capMax: number | null = null;
    let value = uncapped;
    if (capS !== null) {
      let m = 0;
      for (const c of comps) if (c.tvl_usd >= p.tvl_usd / 3 && c.tvl_usd <= p.tvl_usd * 3) m = Math.max(m, c.mcap_usd!);
      if (m > 0) {
        capMax = m * (1 + capS);
        value = Math.min(value, capMax);
      }
    }
    const days = daysTracked(p, refDays);
    const stratum = bandStratum(p, refDays, finalPipe.groupMap, finalPipe.groupSizes);
    const extrapolated = p.tvl_usd < finalPipe.trainMinTvl || p.tvl_usd > finalPipe.trainMaxTvl;
    const q = extrapolated ? bands.pooled : bands.strata[stratum - 1]!;
    const yCapped = log10(value);
    const p50 = Math.round(value);
    const p25 = Math.round(Math.pow(10, yCapped + q.q25));
    const p75 = Math.round(Math.pow(10, yCapped + q.q75));
    const p10 = Math.round(Math.pow(10, yCapped + q.q10));
    const p90 = Math.round(Math.pow(10, yCapped + q.q90));
    const grpId = p.category === null ? null : finalPipe.groupMap.get(p.category);
    const groupSize = grpId === undefined || grpId === null ? 0 : finalPipe.groupSizes.get(grpId) ?? 0;
    const peerRate = p.category === null ? pGlobal : peerRateByCat.get(p.category) ?? pGlobal;
    const econ = computeFarmEconomics(p, p50, p25, days, groupSize, peerRate);
    const steps = buildFarmPlan(p, econ, days, p.change_7d, econ.verdict === 'Research only');
    return {
      p, yhat, value, capMax, p50, p25, p75, p10, p90, stratum, extrapolated,
      groupSize, peerRate, econ, steps, grpOff: groupOffset(finalPipe, p),
    };
  });
  scored.sort((a, b) => (b.value - a.value) || (b.p.tvl_usd - a.p.tvl_usd) || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const nBoard = scored.length;
  const board: BoardRow[] = scored.map((s, i) => {
    const rank = i + 1;
    const ri = rankInterval(rank, nBoard, rankCal.qFinal);
    return {
      slug: s.p.slug, name: s.p.name, rank, implied_value_usd: s.p50, farm_steps: s.steps,
      tvl_usd: s.p.tvl_usd, category: s.p.category, chains: s.p.chains, change_7d: s.p.change_7d,
      listed_at: s.p.listed_at, p25_usd: s.p25, p75_usd: s.p75, p10_usd: s.p10, p90_usd: s.p90,
      rank_best: ri.best, rank_worst: ri.worst, verdict: s.econ.verdict, p_be: s.econ.pBe,
      net_per_hour_usd: Math.round(s.econ.netHr * 100) / 100,
      peer_token_rate: Math.round(s.peerRate * 10000) / 10000,
      watchlist: watchSet.has(s.p.slug), extrapolated: s.extrapolated, group_size: s.groupSize,
      days_tracked: daysTracked(s.p, refDays), grp_off_dex: s.grpOff, cap_max_usd: s.capMax,
    };
  });
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }
  const census = buildCensus(snapshot, new Set(board.map((r) => r.slug)), compSlugs);
  const verdictCounts: Record<string, number> = {};
  for (const r of board) verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;

  // ---- dashboard data (compact; values recompute client-side from raw fields).
  const cats = [...new Set(board.map((r) => r.category ?? '—'))].sort();
  const chainsAll = [...new Set(board.flatMap((r) => r.chains))].sort();
  const verdictIdx: Record<string, number> = { Farm: 0, Marginal: 1, 'Research only': 2, Skip: 3 };
  const rowsStr = board.map((r) => {
    const f = [r.slug, r.name, String(cats.indexOf(r.category ?? '—')), r.chains.map((c) => String(chainsAll.indexOf(c))).join(','), String(r.tvl_usd), r.change_7d === null ? '' : String(Math.round(r.change_7d * 10) / 10), r.days_tracked === null ? '' : String(r.days_tracked), String(r.implied_value_usd), String(verdictIdx[r.verdict]!), String(Math.round(r.grp_off_dex * 1e4) / 1e4), r.watchlist ? '1' : '0', String(r.group_size)];
    for (const x of f) if (x.includes('|') || x.includes('\n')) throw new Error('delimited field contains a separator');
    return f.join('|');
  }).join('\n');
  const compsStr = comps.map((c) => {
    const f = [c.slug, String(c.tvl_usd), String(c.mcap_usd)];
    for (const x of f) if (x.includes('|') || x.includes('\n')) throw new Error('delimited field contains a separator');
    return f.join('|');
  }).join('\n');
  const st = finalPipe.stats;
  const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
  const dataObj = {
    meta: {
      asOf: snapshot.as_of,
      total: snapshot.protocols.length, boardN: board.length, compN: comps.length,
      watchN: snapshot.watchlist.length,
    },
    params: {
      // Effective shipped form: fitPipeline may force the ladder lambda down
      // one grid step under the slope constraint; finalPipe.cfg carries it.
      form: finalPipe.cfg.form, subset: finalPipe.cfg.subset, selectedSubset: selectedCfg.subset, groupLambda: finalPipe.cfg.groupLambda === Infinity ? 'inf' : finalPipe.cfg.groupLambda,
      betaLad: finalPipe.betaLad, betaGlo: finalPipe.betaGlo,
      k1: r4(st.k1), k2: r4(st.k2), medTvl: st.medTvl,
      growS: st.growS, growP1: r4(st.growP1), growP99: r4(st.growP99), growMed: r4(st.growMed), growIqr: r4(st.growIqr),
      ageP1: r4(st.ageP1), ageP99: r4(st.ageP99), ageMed: r4(st.ageMed), ageIqr: r4(st.ageIqr),
      chainP1: r4(st.chainP1), chainP99: r4(st.chainP99), chainMed: r4(st.chainMed), chainIqr: r4(st.chainIqr),
      capS, quants: {
        strata: bands.strata.map((q) => [q.q10, q.q25, q.q75, q.q90]),
        pooled: [bands.pooled.q10, bands.pooled.q25, bands.pooled.q75, bands.pooled.q90],
      },
      qFinal: rankCal.qFinal, compMinTvl: finalPipe.trainMinTvl, compMaxTvl: finalPipe.trainMaxTvl,
    },
    cats, chains: chainsAll, rows: rowsStr, comps: compsStr,
    peerRates: cats.map((c) => { const v = peerRateByCat.get(c === '—' ? '\0null' : c); return v === undefined ? null : Math.round(v * 10000) / 10000; }),
    peerGlobal: Math.round(pGlobal * 10000) / 10000,
    census: { ...census, refOtherReasons: undefined },
    valid: {
      loo: { challMed: r4(looMetrics.challMed), defMed: r4(looMetrics.defMed), flatMed: r4(looMetrics.flatMed), challSpear: r4(looMetrics.challSpear), defSpear: r4(looMetrics.defSpear), flatSpear: r4(looMetrics.flatSpear), hit2: r4(looMetrics.hit2), hit3: r4(looMetrics.hit3), challMult: r4(Math.pow(10, looMetrics.challMed)), defMult: r4(Math.pow(10, looMetrics.defMed)), flatMult: r4(Math.pow(10, looMetrics.flatMed)) },
      gate: { lower90: r4(gate.lower90), medianImprove: r4(gate.medianImprove), pass: gate.pass },
      timeSplit: {
        boundary: audit.boundary, trainN: audit.trainN, testN: audit.testN,
        challMed: r4(audit.challMedAbs), defMed: r4(audit.defMedAbs), flatMed: r4(audit.flatMedAbs),
        challSpear: r4(audit.challSpear), deteriorationDex: r4(audit.deteriorationDex), pass: audit.pass,
        cov50: tsCov.n > 0 ? r4(tsCov.cov50 / tsCov.n) : null, cov80: tsCov.n > 0 ? r4(tsCov.cov80 / tsCov.n) : null,
      },
      formTable: formTable.map((t) => [t.label, r4(t.medAbs), r4(t.spear)]),
      subsetTable: subsetTable.map((t) => [t.subset, t.name, r4(t.medAbs), r4(t.spear), t.admitted]),
      groupTable: groupTable.map((t) => [t.label, r4(t.medAbs), r4(t.spear)]),
      capOuter: { selNoCap: r4(capOuter.selNoCap), selCap: r4(capOuter.selCap), gloNoCap: r4(capOuter.gloNoCap), gloCap: r4(capOuter.gloCap), sMode: capOuter.sMode, gate: { lower90: r4(capOuter.capGate.lower90), medianImprove: r4(capOuter.capGate.medianImprove), pass: capOuter.capGate.pass }, ships: capShips },
      perm: { realMedAbs: r4(perm.realMedAbs), permMean: r4(perm.permMean), permP5: r4(perm.permP5), permP95: r4(perm.permP95), fracBeatReal: r4(perm.fracBeatReal), signal: perm.signal, lambda: bestGroupLambda },
      groups: { ...groupsSummary, maxAbs: r4(groupsSummary.maxAbs) },
      ladderShape: { lambda: ladderShape.lambda, knots: ladderShape.knots.map(r4), slopes: ladderShape.slopes.map(r4) },
      sens: { baseSlope: r4(sens.baseSlope), noLeverageSlope: r4(sens.noLeverageSlope), noLeverageMovePct: r4(sens.noLeverageMovePct), wideCount: sens.wideCount, wideSlope: r4(sens.wideSlope), wideMovePct: r4(sens.wideMovePct), fragile: sens.fragile },
      bands: { looCov50: r4(bands.looCov50), looCov80: r4(bands.looCov80) },
      rank: { qFinal: rankCal.qFinal, crossCoverage: r4(rankCal.crossCoverage), crossMedianWidthRanks: r4(rankCal.crossMedianWidthRanks), crossP90WidthRanks: r4(rankCal.crossP90WidthRanks) },
    },
  };
  const dataJs = `window.RADAR=${JSON.stringify(dataObj)};\n`;

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  mkdirSync(join(out, 'dashboard'), { recursive: true });
  writeFileSync(join(out, 'dashboard', 'data.js'), dataJs);
  const dashCopied = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
  // data.js was written first; do not let the copy overwrite it (repo has no data.js).
  const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: bad name\n`);
      process.exit(1);
    }
  }
  // data.js self-check: parse back and verify every digest value matches board.json.
  const parsed = JSON.parse(dataJs.slice('window.RADAR='.length, -2)) as typeof dataObj;
  const parsedRows = parsed.rows.split('\n').map((l) => l.split('|'));
  if (parsedRows.length !== board.length) throw new Error('data.js row count mismatch');
  for (let i = 0; i < board.length; i++) {
    const dr = parsedRows[i]!;
    if (dr[0] !== board[i]!.slug || Number(dr[7]) !== board[i]!.implied_value_usd) throw new Error(`data.js digest mismatch at row ${i + 1}`);
  }
  const parsedComps = parsed.comps.split('\n').map((l) => l.split('|'));
  if (parsedComps.length !== comps.length) throw new Error('data.js comp count mismatch');
  for (let i = 0; i < comps.length; i++) {
    const dc = parsedComps[i]!;
    if (dc[0] !== comps[i]!.slug || Number(dc[1]) !== comps[i]!.tvl_usd || Number(dc[2]) !== comps[i]!.mcap_usd) throw new Error(`data.js comp mismatch at comp ${i + 1}`);
  }
  const runtimeSec = (Date.now() - t0) / 1000;
  const summary = {
    asOf: snapshot.as_of, totalProtocols: snapshot.protocols.length, watchlist: snapshot.watchlist.length,
    compsRaw: rawCount, compsFitted: comps.length, compRejected: rejected,
    boardRows: board.length, watchlistCovered: board.filter((r) => r.watchlist).length,
    belowFloor: board.filter((r) => !r.watchlist).length,
    shippedForm: formLabel(finalPipe.cfg.form), shippedSubset: SUBSET_NAMES[finalPipe.cfg.subset]!,
    shippedGroupLambda: finalPipe.cfg.groupLambda === Infinity ? 'inf' : finalPipe.cfg.groupLambda,
    selectedForm: formLabel(selectedCfg.form), finalConverged: finalPipe.converged,
    gatePass: gate.pass, gateLower90: gate.lower90, gateMedianImprove: gate.medianImprove,
    looChallMedAbsDex: looMetrics.challMed, looChallMult: Math.pow(10, looMetrics.challMed),
    looDefMult: Math.pow(10, looMetrics.defMed), looFlatMult: Math.pow(10, looMetrics.flatMed),
    looChallSpear: looMetrics.challSpear, looDefSpear: looMetrics.defSpear, looFlatSpear: looMetrics.flatSpear,
    looHit2: looMetrics.hit2, looHit3: looMetrics.hit3,
    timeSplit: { boundary: audit.boundary, trainN: audit.trainN, testN: audit.testN, challMed: audit.challMedAbs, defMed: audit.defMedAbs, flatMed: audit.flatMedAbs, spear: audit.challSpear, deteriorationDex: audit.deteriorationDex, pass: audit.pass },
    capShips, capS, capOuterMedNoCap: capOuter.selNoCap, capOuterMedCap: capOuter.selCap,
    capGateLower90: capOuter.capGate.lower90, capGatePass: capOuter.capGate.pass,
    perm, permLambda: bestGroupLambda, sens,
    bandsLooCov50: bands.looCov50, bandsLooCov80: bands.looCov80,
    bandsTsCov50: tsCov.n > 0 ? tsCov.cov50 / tsCov.n : null,
    bandsTsCov80: tsCov.n > 0 ? tsCov.cov80 / tsCov.n : null,
    rankQFinal: rankCal.qFinal, rankCrossCoverage: rankCal.crossCoverage,
    rankCrossMedianWidth: rankCal.crossMedianWidthRanks, rankCrossP90Width: rankCal.crossP90WidthRanks,
    census, verdictCounts,
    maxGroupOffset: Math.max(0, ...[...finalPipe.offsets.values()].map((v) => Math.abs(v))),
    groupCount: finalPipe.offsets.size,
    dossierDataJsBytes: Buffer.byteLength(dataJs, 'utf8'),
    runtimeSec, dashCopied,
  };
  if (shots.length < 3) {
    process.stdout.write(`---SUMMARY---\n${JSON.stringify(summary, null, 2)}\n`);
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} image(s): hand in 3 before the dossier can be built\n`);
    process.exit(1);
  }
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));
  const dossierText = JSON.parse(readFileSync(join(out, 'dossier.json'), 'utf8')) as { text: string };
  const dossierBytes = Buffer.byteLength(dossierText.text, 'utf8');
  process.stdout.write(`---SUMMARY---\n${JSON.stringify({ ...summary, dossierTextBytes: dossierBytes }, null, 2)}\n`);
}

main();
