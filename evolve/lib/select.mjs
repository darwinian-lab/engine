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

/**
 * Expected loss of choosing a over b: the average amount (in success rate) by which a falls short of b, over the
 * draws where it does. Small means switching is safe even if a turns out not to be better.
 */
export function expectedLoss(a, b, draws = 4000, rng = Math.random) {
  let loss = 0;
  for (let i = 0; i < draws; i++) {
    const x = beta(1 + a.successes, 1 + a.trials - a.successes, rng);
    const y = beta(1 + b.successes, 1 + b.trials - b.successes, rng);
    if (y > x) loss += y - x;
  }
  return loss / draws;
}

/** P(a beats b) for two Beta posteriors, by sampling. */
export function probBeats(a, b, draws = 4000, rng = Math.random) {
  let w = 0;
  for (let i = 0; i < draws; i++) {
    if (beta(1 + a.successes, 1 + a.trials - a.successes, rng) > beta(1 + b.successes, 1 + b.trials - b.successes, rng)) w++;
  }
  return w / draws;
}

export const NURSERY_DEFAULTS = {
  simWeight: 1, // one simulated session counts like this many real visitors...
  simFadeAt: 50, // ...shrinking as real weekly visitors grow (weight / (1 + weekly/simFadeAt))
  minSims: 6, // sessions before an arm can be judged on simulations
  minTrials: 100, // real visitors before an arm can be judged on real traffic alone
  // Promotion = "not worse" with enough evidence (see decideNursery).
  minSimsPromote: 10, // simulated sessions before an arm can be merged
  minPairs: 2, // side-by-side comparisons with the champion before an arm can be merged
  finalistMinSims: 4, // a finalist (a winner replayed onto the new main) only needs a quick confirmation
  finalistMinPairs: 1,
  regressMargin: 0.05, // a regression means a success rate more than 5 points below the champion's
  maxRegress: 0.25, // merge only if P(regression) is below this (small samples can't do much better)
  scoreMargin: 3, // experience-score points that count as "worse"
  maxQualityRegress: 0.2, // merge only if P(score more than scoreMargin below) is below this
  minPairPref: 0.4, // merge only if side-by-side preference for it is at least this (0.5 = even)
  killRegress: 0.9, // die when P(regression) on success or score exceeds this
  killAt: 0.1, // (legacy) P(beats champion) below which a judged arm dies
  graduateAt: 0.5, // P(beats champion) for a nursery arm to get real traffic
  fieldSize: 2, // live arms competing for real traffic besides champion and control
  nurserySize: 6, // arms judged by simulated people only
  spawnPerCycle: 3,
  nurseryMaxDays: 7,
  fieldMaxDays: 21,
};

/**
 * Selection with simulated and real evidence combined.
 * arms: [{arm_id, status:'champion'|'live'|'nursery', created_at}]
 * real, sims: {arm_id: {trials, successes}}
 * Returns {promote, retire:[{arm_id,cause,score}], graduate:[arm_id], spawn, pb, pbeat, combined, lambda}
 */
/** P(a's success rate is more than `margin` below b's): the chance that switching to a is a real regression. */
export function probRegress(a, b, margin, draws = 4000, rng = Math.random) {
  let n = 0;
  for (let i = 0; i < draws; i++) {
    const x = beta(1 + a.successes, 1 + a.trials - a.successes, rng);
    const y = beta(1 + b.successes, 1 + b.trials - b.successes, rng);
    if (x < y - margin) n++;
  }
  return n / draws;
}

/** Normal-approximation P(quality of a is more than `margin` points below b). */
function qualityRegress(qa, qb, margin) {
  if (!qa || !qb || qa.n < 3 || qb.n < 3) return null;
  const d = qa.mean - qb.mean, se = Math.sqrt(qa.se ** 2 + qb.se ** 2) || 1;
  const z = (-margin - d) / se;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function decideNursery({ arms, real, sims, quality = {}, pairs = {}, weeklyReal, now = Date.now(), opts = {} }) {
  const o = { ...NURSERY_DEFAULTS, ...opts };
  const lambda = o.simWeight / (1 + weeklyReal / o.simFadeAt);
  const combined = {};
  for (const a of arms) {
    const r = real[a.arm_id] ?? { trials: 0, successes: 0 };
    const s = sims[a.arm_id] ?? { trials: 0, successes: 0 };
    combined[a.arm_id] = { trials: r.trials + lambda * s.trials, successes: r.successes + lambda * s.successes, real: r, sims: s };
  }
  const pb = probBest(combined);
  // If nobody succeeded anywhere, the measurement itself is broken (e.g. the simulated browser can't do something
  // real browsers can): make no promotions, graduations or kills on it.
  const anySuccess = Object.values(combined).some((c) => c.successes > 0);
  const champion = arms.find((a) => a.status === "champion");
  const judged = (id) => (sims[id]?.trials ?? 0) >= o.minSims || (real[id]?.trials ?? 0) >= o.minTrials;
  const pbeat = {};
  for (const a of arms) pbeat[a.arm_id] = champion && a.arm_id !== champion.arm_id ? probBeats(combined[a.arm_id], combined[champion.arm_id]) : null;
  const mean = (id) => (combined[id].successes + 1) / (combined[id].trials + 2);
  const loss = {};

  // Natural selection, Darwin-style: a mutation spreads unless it is harmful. A challenger is merged when, with enough
  // evidence, it is NOT worse than the champion on any of three signals: success rate (real + simulated), the
  // simulated people's experience score, and blinded side-by-side preferences. Clear winners are merged first, and
  // small, neutral improvements accumulate instead of waiting for proof of superiority.
  const preg = {}, qreg = {}, pairPref = {}, gain = {};
  const cid = champion?.arm_id;
  for (const a of arms) {
    if (!cid || a.arm_id === cid) continue;
    preg[a.arm_id] = probRegress(combined[a.arm_id], combined[cid], o.regressMargin);
    qreg[a.arm_id] = qualityRegress(quality[a.arm_id], quality[cid], o.scoreMargin);
    const p = pairs[a.arm_id];
    pairPref[a.arm_id] = p && p.n ? (1 + p.wins + 0.5 * p.ties) / (2 + p.n) : null;
    gain[a.arm_id] = 100 * (mean(a.arm_id) - mean(cid)) + ((quality[a.arm_id]?.mean ?? 0) - (quality[cid]?.mean ?? 0)) + 20 * ((pairPref[a.arm_id] ?? 0.5) - 0.5);
  }
  // Finalists already won once; replayed onto the new main they only need a quick check that nothing regressed.
  const isFinalist = (id) => Boolean(arms.find((a) => a.arm_id === id)?.finalist_of);
  const enough = (id) => {
    const [ms, mp] = isFinalist(id) ? [o.finalistMinSims, o.finalistMinPairs] : [o.minSimsPromote, o.minPairs];
    return ((sims[id]?.trials ?? 0) >= ms || (real[id]?.trials ?? 0) >= o.minTrials) && (mp <= 0 || (pairs[id]?.n ?? 0) >= mp);
  };
  const notWorse = (id) =>
    preg[id] < o.maxRegress &&
    (qreg[id] == null || qreg[id] < o.maxQualityRegress) &&
    (pairPref[id] == null || pairPref[id] >= o.minPairPref);
  let promotions = [];
  if (!anySuccess) return { promote: null, promotions: [], retire: [], graduate: [], spawn: Math.max(0, Math.min(o.spawnPerCycle, o.nurserySize - arms.filter((a) => a.status === "nursery").length)), pb, pbeat: {}, combined, lambda, blind: true };
  if (champion && judged(champion.arm_id)) {
    const contenders = arms.filter((a) => a.status !== "champion" && enough(a.arm_id) && notWorse(a.arm_id) && gain[a.arm_id] >= 0); // and, all signals together, it looks at least as good
    for (const a of contenders) loss[a.arm_id] = expectedLoss(combined[a.arm_id], combined[cid]);
    contenders.sort((x, y) => gain[y.arm_id] - gain[x.arm_id]);
    promotions = contenders.map((a) => a.arm_id);
  }
  const promote = promotions[0] ?? null;
  const winning = new Set(promotions);
  const retire = [];
  for (const a of arms) {
    // The champion is retired by the caller only once a winner has actually been merged.
    if (a.status === "champion" || winning.has(a.arm_id)) continue;
    const ageDays = (now - a.created_at) / 86400_000;
    const c = combined[a.arm_id];
    const ev = `${c.sims.successes}/${c.sims.trials} simulated, ${c.real.successes}/${c.real.trials} real`;
    const clearlyWorse = judged(a.arm_id) && cid && (
      preg[a.arm_id] > o.killRegress ||
      (qreg[a.arm_id] != null && qreg[a.arm_id] > o.killRegress) ||
      ((pairs[a.arm_id]?.n ?? 0) >= 4 && pairPref[a.arm_id] < 0.25));
    if (clearlyWorse) {
      const why = preg[a.arm_id] > o.killRegress ? `success rate clearly below the champion's (P(worse)=${preg[a.arm_id].toFixed(2)})` : qreg[a.arm_id] > o.killRegress ? `experience score clearly below the champion's (${quality[a.arm_id].mean.toFixed(0)} vs ${quality[cid].mean.toFixed(0)})` : `simulated people preferred the champion side by side (${pairs[a.arm_id].wins}-${pairs[a.arm_id].losses}-${pairs[a.arm_id].ties})`;
      retire.push({ arm_id: a.arm_id, cause: `lost to the champion: ${why} [${ev}]`, score: pbeat[a.arm_id] ?? 0.1 });
    } else if (a.status === "nursery" && ageDays > o.nurseryMaxDays) {
      retire.push({ arm_id: a.arm_id, cause: `left the nursery without proving itself after ${ageDays.toFixed(0)} days [${ev}]`, score: pbeat[a.arm_id] ?? 0.3 });
    } else if (a.status === "live" && ageDays > o.fieldMaxDays && (pbeat[a.arm_id] ?? 0) < 0.5) {
      retire.push({ arm_id: a.arm_id, cause: `timed out after ${ageDays.toFixed(0)} days [${ev}]`, score: pbeat[a.arm_id] ?? 0.3 });
    }
  }
  const dying = new Set(retire.map((r) => r.arm_id));
  const liveLeft = arms.filter((a) => a.status === "live" && !dying.has(a.arm_id)).length;
  const graduate = arms
    .filter((a) => a.status === "nursery" && !dying.has(a.arm_id) && !winning.has(a.arm_id) && judged(a.arm_id) && combined[a.arm_id].successes > 0 && (pbeat[a.arm_id] ?? 0) > o.graduateAt)
    .sort((x, y) => mean(y.arm_id) - mean(x.arm_id))
    .slice(0, Math.max(0, o.fieldSize - liveLeft))
    .map((a) => a.arm_id);
  const nurseryLeft = arms.filter((a) => a.status === "nursery" && !dying.has(a.arm_id) && !graduate.includes(a.arm_id) && !winning.has(a.arm_id)).length;
  const spawn = Math.max(0, Math.min(o.spawnPerCycle, o.nurserySize - nurseryLeft));
  return { promote, promotions, retire, graduate, spawn, pb, pbeat, loss, preg, qreg, pairPref, gain, combined, lambda };
}
