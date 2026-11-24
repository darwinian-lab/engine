import { describe, it, expect } from "vitest";
import { chooseArm, probBest, sampleBeta, bestByMean, type Arm, type ArmStat } from "../src/bandit";
import { matchEvents, type SpeciesConfig } from "../src/config";

// Seeded RNG for reproducible tests.
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const arms: Arm[] = [
  { arm_id: "ctrl", status: "control", origin: "https://c" },
  { arm_id: "a", status: "live", origin: "https://a" },
  { arm_id: "b", status: "live", origin: "https://b" },
];

describe("bandit", () => {
  it("beta samples are in [0,1] with the right mean", () => {
    const r = rng();
    let sum = 0;
    for (let i = 0; i < 5000; i++) {
      const x = sampleBeta(3, 7, r);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      sum += x;
    }
    expect(sum / 5000).toBeCloseTo(0.3, 1);
  });

  it("routes about controlShare of traffic to the control", () => {
    const r = rng(7);
    let ctrl = 0;
    for (let i = 0; i < 5000; i++) if (chooseArm(arms, [], "desktop", { controlShare: 0.1, rng: r })!.arm_id === "ctrl") ctrl++;
    expect(ctrl / 5000).toBeGreaterThan(0.08);
    expect(ctrl / 5000).toBeLessThan(0.12);
  });

  it("shifts traffic toward the better arm", () => {
    const stats: ArmStat[] = [
      { arm_id: "a", segment: "all", trials: 400, successes: 80 },
      { arm_id: "b", segment: "all", trials: 400, successes: 40 },
    ];
    const r = rng(9);
    let a = 0;
    for (let i = 0; i < 2000; i++) if (chooseArm(arms, stats, "desktop", { controlShare: 0, rng: r })!.arm_id === "a") a++;
    expect(a / 2000).toBeGreaterThan(0.95);
    const pb = probBest(["a", "b"], stats, "all", 3000, rng(3));
    expect(pb.a).toBeGreaterThan(0.99);
    expect(bestByMean(arms, stats)!.arm_id).toBe("a");
  });

  it("uses segment data once a segment has enough visitors", () => {
    const stats: ArmStat[] = [
      { arm_id: "a", segment: "all", trials: 400, successes: 80 },
      { arm_id: "b", segment: "all", trials: 400, successes: 60 },
      { arm_id: "a", segment: "mobile", trials: 200, successes: 10 },
      { arm_id: "b", segment: "mobile", trials: 200, successes: 50 },
    ];
    const r = rng(11);
    let b = 0;
    for (let i = 0; i < 1000; i++) if (chooseArm(arms, stats, "mobile", { controlShare: 0, rng: r })!.arm_id === "b") b++;
    expect(b / 1000).toBeGreaterThan(0.95);
  });

  it("falls back to the control when nothing else is alive", () => {
    expect(chooseArm([arms[0]], [], "desktop", { controlShare: 0.1 })!.arm_id).toBe("ctrl");
  });
});

describe("event matching", () => {
  const cfg: SpeciesConfig = {
    species: "qr",
    brand: { name: "x", domain: "x.com" },
    stages: [{ name: "activation", event: "qr_download" }],
    events: [
      { name: "qr_download", method: "GET", path: "^/api/qr\\.svg$", query: "dl=1" },
      { name: "waitlist_join", method: "POST", path: "^/api/waitlist$" },
      { name: "testimonial_received", path: "^/api/c/", credit: "header" },
    ],
  };
  it("matches method, path, query and status", () => {
    const u = (s: string) => new URL("https://x.com" + s);
    expect(matchEvents(cfg, "GET", u("/api/qr.svg?d=1&dl=1"), 200).map((r) => r.name)).toEqual(["qr_download"]);
    expect(matchEvents(cfg, "GET", u("/api/qr.svg?d=1"), 200)).toEqual([]);
    expect(matchEvents(cfg, "POST", u("/api/waitlist"), 500)).toEqual([]);
    expect(matchEvents(cfg, "POST", u("/api/waitlist"), 201).length).toBe(1);
    expect(matchEvents(cfg, "POST", u("/api/c/abc"), 200)).toEqual([]); // header-credited only
  });
});
