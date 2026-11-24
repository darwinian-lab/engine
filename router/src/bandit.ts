// Thompson sampling over Beta-Bernoulli arms, segment-aware, with a fixed control share.
// Pure functions: no I/O, easy to test and identical in router and evolve loop.

export interface ArmStat {
  arm_id: string;
  segment: string; // 'mobile' | 'desktop' | 'all'
  trials: number;
  successes: number;
}

export interface Arm {
  arm_id: string;
  status: string; // live | control | champion
  origin: string;
}

export type Rng = () => number;

// Standard normal via Box-Muller.
function normal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia & Tsang gamma sampler (shape k > 0, scale 1).
export function sampleGamma(k: number, rng: Rng): number {
  if (k < 1) {
    const u = rng();
    return sampleGamma(1 + k, rng) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

// Segment posterior falls back to the arm's global numbers until the segment has data.
export const SEGMENT_MIN_TRIALS = 30;

export function posterior(
  stats: ArmStat[],
  arm_id: string,
  segment: string,
): { a: number; b: number } {
  const seg = stats.find((s) => s.arm_id === arm_id && s.segment === segment);
  const all = stats.find((s) => s.arm_id === arm_id && s.segment === "all");
  const pick = seg && seg.trials >= SEGMENT_MIN_TRIALS ? seg : all;
  const t = pick?.trials ?? 0;
  const s = Math.min(pick?.successes ?? 0, t);
  return { a: 1 + s, b: 1 + (t - s) };
}

export interface ChooseOptions {
  controlShare: number; // e.g. 0.1
  rng?: Rng;
}

// Pick an arm for a new visitor.
export function chooseArm(
  arms: Arm[],
  stats: ArmStat[],
  segment: string,
  opts: ChooseOptions,
): Arm | null {
  const rng = opts.rng ?? Math.random;
  const control = arms.find((a) => a.status === "control");
  const evolving = arms.filter((a) => a.status === "live" || a.status === "champion");
  if (evolving.length === 0) return control ?? null;
  if (control && rng() < opts.controlShare) return control;
  let best: Arm | null = null;
  let bestDraw = -1;
  for (const arm of evolving) {
    const { a, b } = posterior(stats, arm.arm_id, segment);
    const draw = sampleBeta(a, b, rng);
    if (draw > bestDraw) {
      bestDraw = draw;
      best = arm;
    }
  }
  return best;
}

// Monte Carlo probability that each arm is the best (used for selection decisions).
export function probBest(
  arms: string[],
  stats: ArmStat[],
  segment = "all",
  draws = 4000,
  rng: Rng = Math.random,
): Record<string, number> {
  const wins: Record<string, number> = Object.fromEntries(arms.map((a) => [a, 0]));
  const post = arms.map((id) => ({ id, ...posterior(stats, id, segment) }));
  for (let i = 0; i < draws; i++) {
    let best = "";
    let bestDraw = -1;
    for (const p of post) {
      const d = sampleBeta(p.a, p.b, rng);
      if (d > bestDraw) {
        bestDraw = d;
        best = p.id;
      }
    }
    wins[best]++;
  }
  for (const k of Object.keys(wins)) wins[k] /= draws;
  return wins;
}

// Deterministic choice for crawlers: posterior mean, highest wins (never the control).
export function bestByMean(arms: Arm[], stats: ArmStat[]): Arm | null {
  const evolving = arms.filter((a) => a.status === "live" || a.status === "champion");
  const champ = evolving.find((a) => a.status === "champion");
  if (champ) return champ;
  let best: Arm | null = null;
  let bestMean = -1;
  for (const arm of evolving) {
    const { a, b } = posterior(stats, arm.arm_id, "all");
    const m = a / (a + b);
    if (m > bestMean) {
      bestMean = m;
      best = arm;
    }
  }
  return best;
}
