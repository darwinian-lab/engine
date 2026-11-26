import { describe, it, expect } from "vitest";
// @ts-expect-error plain JS module
import { decideNursery, combineMoney } from "../../evolve/lib/select.mjs";

const now = Date.now();
const arms = [
  { arm_id: "champ", status: "champion", created_at: now },
  { arm_id: "a", status: "nursery", created_at: now },
];
const base = {
  arms,
  real: {},
  sims: { champ: { trials: 200, successes: 160 }, a: { trials: 200, successes: 160 } },
  quality: {},
  pairs: { a: { n: 2, wins: 1, losses: 1, ties: 0 } },
  weeklyReal: 0,
  now,
};

describe("money in selection", () => {
  it("combines real and simulated money with the simulation weight", () => {
    const m = combineMoney({ x: { real: { trials: 10, starts: 1, buys: 1, revenue: 9 }, sims: { trials: 20, starts: 4, buys: 2 } } }, 0.5);
    expect(m.x).toEqual({ trials: 20, starts: 3, buys: 2, revenue: 9 });
  });

  it("more checkouts and purchases raise a challenger's gain", () => {
    const flat = decideNursery({ ...base, money: {} });
    const rich = decideNursery({
      ...base,
      money: { champ: { sims: { trials: 20, starts: 0, buys: 0 } }, a: { sims: { trials: 20, starts: 6, buys: 3 } } },
    });
    expect(rich.gain.a).toBeGreaterThan(flat.gain.a + 20);
    expect(rich.promotions).toContain("a");
  });

  it("a challenger that clearly loses checkouts is never merged", () => {
    const d = decideNursery({
      ...base,
      sims: { champ: { trials: 200, successes: 140 }, a: { trials: 200, successes: 180 } },
      money: { champ: { sims: { trials: 20, starts: 12, buys: 6 } }, a: { sims: { trials: 20, starts: 0, buys: 0 } } },
    });
    expect(d.mreg.a).toBeGreaterThan(0.25);
    expect(d.promotions).not.toContain("a");
  });
});
