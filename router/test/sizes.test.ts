import { describe, it, expect } from "vitest";
// @ts-ignore engine module
import { mutationSize, SIZES } from "../../evolve/lib/select.mjs";

describe("mutationSize", () => {
  it("draws every size from the default mix, mostly big ones", () => {
    let i = 0;
    const seq = Array.from({ length: 1000 }, (_, k) => (k + 0.5) / 1000);
    const counts: Record<string, number> = {};
    for (let k = 0; k < 1000; k++) { const s = mutationSize(() => seq[i++]); counts[s] = (counts[s] ?? 0) + 1; }
    for (const s of SIZES) expect(counts[s]).toBeGreaterThan(0);
    expect(counts.feature + counts.redesign + counts.large).toBeGreaterThan(500);
  });
  it("respects a custom mix", () => {
    expect(mutationSize(() => 0.99, { small: 1 })).toBe("small");
    expect(mutationSize(() => 0.7, { small: 0.5, redesign: 0.5 })).toBe("redesign");
  });
});
