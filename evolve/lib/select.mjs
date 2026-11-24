// Natural selection: decide who is promoted, who dies and how many children to spawn.
// Pure functions (same Beta-Bernoulli math as the router's bandit).

function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
function gamma(k, rng) {
  if (k < 1) return gamma(1 + k, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a, b, rng) => { const x = gamma(a, rng); return x / (x + gamma(b, rng)); };

export function probBest(stats, draws = 4000, rng = Math.random) {
  const ids = Object.keys(stats);
  const wins = Object.fromEntries(ids.map((i) => [i, 0]));
  if (ids.length === 0) return wins;
  for (let i = 0; i < draws; i++) {
    let best = ids[0], bd = -1;
    for (const id of ids) {
      const s = stats[id];
      const d = beta(1 + s.successes, 1 + s.trials - s.successes, rng);
      if (d > bd) { bd = d; best = id; }
    }
    wins[best]++;
  }
  for (const id of ids) wins[id] /= draws;
  return wins;
}

export const DEFAULTS = {
  minTrials: 100, // visitors an arm needs before it can be judged
  promoteAt: 0.95, // P(best) to become champion
  killAt: 0.05, // P(best) below which an arm dies
  maxAgeDays: 21, // arms that can't prove themselves in this time die
  population: 3,
};

/**
 * @param arms   evolving arms [{arm_id, status:'live'|'champion', created_at, generation}]
 * @param stats  {arm_id: {trials, successes}}
 * @param weeklyVisitors  species-wide human visitors in the last 7 days
 * @returns {promote, retire:[{arm_id,cause}], spawn, pb, population}
 */
export function decide(arms, stats, weeklyVisitors, now = Date.now(), opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = Object.fromEntries(arms.map((a) => [a.arm_id, stats[a.arm_id] ?? { trials: 0, successes: 0 }]));
  const pb = probBest(s);
  const champion = arms.find((a) => a.status === "champion");
  const retire = [];
  let promote = null;

  const judged = arms.filter((a) => s[a.arm_id].trials >= o.minTrials);
  for (const a of judged) {
    if (a.status !== "champion" && pb[a.arm_id] >= o.promoteAt) promote = a.arm_id;
  }
  for (const a of arms) {
    if (a.arm_id === promote) continue;
    if (a.status === "champion" && !promote) continue; // a champion only dies by being outcompeted
    const ageDays = (now - a.created_at) / 86400_000;
    if (a.status === "champion" && promote) retire.push({ arm_id: a.arm_id, cause: `outcompeted by ${promote}` });
    else if (s[a.arm_id].trials >= o.minTrials && pb[a.arm_id] < o.killAt)
      retire.push({ arm_id: a.arm_id, cause: `lost: P(best)=${pb[a.arm_id].toFixed(3)} after ${s[a.arm_id].trials} visitors` });
    else if (ageDays > o.maxAgeDays && pb[a.arm_id] < 0.5)
      retire.push({ arm_id: a.arm_id, cause: `timed out after ${ageDays.toFixed(0)} days without winning (P(best)=${pb[a.arm_id].toFixed(2)})` });
  }

  // Population adapts to traffic: each arm needs ~minTrials visitors per ~2 weeks to be judged.
  const affordable = Math.floor((weeklyVisitors * 2) / o.minTrials);
  const population = Math.max(2, Math.min(o.population, affordable || 2));
  const survivors = arms.length - retire.length;
  const spawn = Math.max(0, population - survivors);
  return { promote, retire, spawn, pb, population, champion: promote ?? champion?.arm_id ?? null };
}

/** Mutation size: mostly small steps, occasionally big leaps. */
export function mutationSize(rng = Math.random) {
  const x = rng();
  return x < 0.5 ? "small" : x < 0.85 ? "medium" : "large";
}
