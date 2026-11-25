// The seed bank: dead mutants can come back generations later, when the environment has changed.
//
// A seed is an idea (root arm) and every revival of it. After its n-th death it may only return once
// 2^(n-1) generations have passed (1, then 2, then 4); after 3 deaths it is archived for good.
// Charter violations are never revived. Among eligible seeds:
//   score = closeness × change × dormancy / deaths
//     closeness: how close it came to beating the champion when it died (0..1)
//     change:    1 + 0.5 per new champion since it died (the environment it would face is different)
//     dormancy:  1 − e^(−Δgen/2), so a seed rests a while before it is worth another try
export const SEED_DEFAULTS = { maxDeaths: 3, minScore: 0.12, perCycle: 1 };

const CHARTER_BREACH = /dark pattern|mislead|deceptiv|fake|manipulat|privacy|tracker|hidden (cost|price|fee)|charter|unsafe|unlawful|phishing|game the measurement|fitness endpoint/i;

export function isRevivable(cause) {
  return !CHARTER_BREACH.test(cause ?? "");
}

/**
 * dead: arms rows with status retired|stillborn|dead (fields: arm_id, revived_from, revivable, died_gen, final_score, cause, mutation)
 * alive: arm rows currently alive (to avoid reviving an idea that's already competing)
 * gen: the species' current generation
 */
export function pickRevivals({ dead, alive, gen, opts = {}, rng = Math.random }) {
  const o = { ...SEED_DEFAULTS, ...opts };
  const aliveRoots = new Set(alive.map((a) => a.revived_from ?? a.arm_id));
  const groups = new Map();
  for (const a of dead) {
    const root = a.revived_from ?? a.arm_id;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(a);
  }
  const candidates = [];
  for (const [root, members] of groups) {
    if (aliveRoots.has(root)) continue;
    if (members.some((m) => m.revivable === 0)) continue;
    if (!members.some((m) => m.mutation)) continue;
    const deaths = members.length;
    if (deaths > o.maxDeaths) continue;
    const last = members.slice().sort((x, y) => (y.died_gen ?? 0) - (x.died_gen ?? 0) || (y.retired_at ?? 0) - (x.retired_at ?? 0))[0];
    if (last.died_gen == null) continue;
    const dg = gen - last.died_gen;
    if (dg < 2 ** (deaths - 1)) continue;
    const closeness = Math.max(0.05, Math.min(1, last.final_score ?? 0.3));
    const score = (closeness * (1 + 0.5 * dg) * (1 - Math.exp(-dg / 2))) / deaths;
    candidates.push({ root, last, deaths, dg, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.filter((c) => c.score >= o.minScore && rng() < Math.min(1, c.score * 2)).slice(0, o.perCycle);
}
