import { describe, it, expect } from "vitest";
// @ts-expect-error plain JS module
import { decideNursery } from "../../evolve/lib/select.mjs";
// @ts-expect-error plain JS module
import { sourceOf, rankIssues, betterPedigree } from "../../evolve/lib/issues.mjs";

const now = Date.now();
const arms = [
  { arm_id: "champ", status: "champion", created_at: now },
  { arm_id: "a", status: "nursery", created_at: now },
];
// The challenger is exactly as good as the champion, with modest evidence (6 sims, 1 side-by-side tie).
const base = {
  arms,
  real: {},
  sims: { champ: { trials: 40, successes: 30 }, a: { trials: 6, successes: 5 } },
  pairs: { a: { n: 1, wins: 0, losses: 0, ties: 1 } },
  weeklyReal: 0,
  now,
};

describe("pedigree", () => {
  it("an idea agreed with the owner merges on less evidence; the same result from exploration does not", () => {
    expect(decideNursery({ ...base, pedigree: { a: "discussion" } }).promotions).toContain("a");
    expect(decideNursery({ ...base, pedigree: { a: "exploration" } }).promotions).not.toContain("a");
    expect(decideNursery({ ...base, pedigree: { a: "sim" } }).promotions).not.toContain("a");
  });

  it("untrusted ideas must show a gain, not just 'not worse'", () => {
    const lots = { ...base, sims: { champ: { trials: 200, successes: 150 }, a: { trials: 200, successes: 150 } }, pairs: { a: { n: 4, wins: 2, losses: 2, ties: 0 } } };
    expect(decideNursery({ ...lots, pedigree: { a: "owner" } }).promotions).toContain("a");
    expect(decideNursery({ ...lots, pedigree: { a: "ideation" } }).promotions).not.toContain("a");
  });

  it("trust never saves a clearly worse mutant", () => {
    const worse = { ...base, sims: { champ: { trials: 200, successes: 180 }, a: { trials: 100, successes: 40 } } };
    const d = decideNursery({ ...worse, pedigree: { a: "discussion" } });
    expect(d.promotions).not.toContain("a");
    expect(d.retire.map((r: { arm_id: string }) => r.arm_id)).toContain("a");
  });

  it("labels map to sources, ranking puts discussion first, crossovers inherit the better parent", () => {
    expect(sourceOf(["from:discussion"])).toBe("discussion");
    expect(sourceOf([])).toBe("owner");
    expect(sourceOf(["from:sim"])).toBe("sim");
    const ranked = rankIssues([
      { number: 1, source: "sim", votes: 9 },
      { number: 2, source: "owner", votes: 1 },
      { number: 3, source: "discussion", votes: 1 },
      { number: 4, source: "user", votes: 1 },
    ]);
    expect(ranked.map((i: { number: number }) => i.number)).toEqual([3, 2, 4, 1]);
    expect(betterPedigree("sim", "owner")).toBe("owner");
    expect(betterPedigree(null, "ideation")).toBe("ideation");
  });
});
