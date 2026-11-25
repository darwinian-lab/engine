// Prove the engine's GitHub token can do every PR operation the pipeline needs, in seconds, without a build:
// branch, commit, open PR, comment, close, delete branch. Run: node evolve/prcheck.mjs [species...]
import fs from "node:fs";
import { api, openPR, commentPR, closePR } from "./lib/ghpr.mjs";

const cfg = JSON.parse(fs.readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const only = process.argv.slice(2);
let failed = 0;
for (const sp of cfg.species.filter((s) => !only.length || only.includes(s.id))) {
  const repo = `${cfg.github.org}/${sp.repo}`;
  const branch = `dw-probe-${Date.now()}`;
  const step = async (name, fn) => {
    try {
      const r = await fn();
      console.log(`  ok   ${name}`);
      return r;
    } catch (e) {
      console.log(`  FAIL ${name}: ${e.message}`);
      throw e;
    }
  };
  console.log(repo);
  let pr;
  try {
    const main = await step("read main", () => api("GET", `repos/${repo}/git/ref/heads/main`));
    await step("create branch", () => api("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha }));
    await step("commit a file", () => api("PUT", `repos/${repo}/contents/.dw-probe`, { message: "Engine PR probe", content: Buffer.from(`${new Date().toISOString()}\n`).toString("base64"), branch }));
    pr = await step("open PR", () => openPR(repo, { base: "main", head: branch, title: "Engine PR probe (closes itself)", body: "Checks that the engine's token can open, comment on and close PRs." }));
    await step("comment", () => commentPR(repo, pr.number, "Probe comment."));
    await step("close PR", () => closePR(repo, pr.number));
  } catch {
    failed++;
    if (pr) await closePR(repo, pr.number).catch(() => {});
  } finally {
    await api("DELETE", `repos/${repo}/git/refs/heads/${branch}`).then(() => console.log("  ok   delete branch"), () => {});
  }
}
if (failed) {
  console.log(`::error title=prcheck::${failed} repo(s) failed the PR probe`);
  process.exit(1);
}
console.log("All PR operations work.");
