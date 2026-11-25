// Viability gates every mutant must pass before it may meet a real visitor.
import fs from "node:fs";
import path from "node:path";
import { run } from "./util.mjs";

const DESTRUCTIVE_SQL = /\b(DROP|DELETE|RENAME|UPDATE|REPLACE|TRUNCATE)\b/i;

/** Files changed relative to the parent ref (stages everything first). */
export async function changedFiles(wt, ref) {
  await run("git", ["add", "-A"], { cwd: wt });
  const r = await run("git", ["diff", "--cached", "--name-status", ref], { cwd: wt });
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status: status[0], path: rest[rest.length - 1] };
    });
}

export function protectedViolations(changes, protectedList, wt) {
  const v = [];
  for (const c of changes) {
    for (const p of protectedList) {
      const isDir = p.endsWith("/");
      const hit = isDir ? c.path.startsWith(p) : c.path === p;
      if (!hit) continue;
      if (isDir && p === "migrations/" && c.status === "A") {
        const sql = fs.readFileSync(path.join(wt, c.path), "utf8");
        if (DESTRUCTIVE_SQL.test(sql)) v.push(`new migration ${c.path} contains destructive SQL`);
        continue; // additive migrations are allowed
      }
      v.push(`${c.status === "D" ? "deleted" : "modified"} protected path ${c.path}`);
    }
  }
  return v;
}

export async function gate(wt, ref, species, { requireMutationFile = true } = {}) {
  const problems = [];
  const changes = await changedFiles(wt, ref);
  if (changes.length === 0) return { ok: false, failure: "No changes were made.", changes };
  problems.push(...protectedViolations(changes, species.protected ?? [], wt));
  if (requireMutationFile && !changes.some((c) => c.path === "MUTATION.md" && c.status !== "D")) problems.push("MUTATION.md was not written for this mutation.");
  const pkg = JSON.parse(fs.readFileSync(path.join(wt, "package.json"), "utf8"));
  for (const script of ["test", "typecheck", "build", "e2e"]) {
    if (!pkg.scripts?.[script]) continue;
    const r = await run("npm", ["run", "--silent", script], { cwd: wt, timeoutMs: (script === "e2e" ? 8 : 5) * 60_000, agent: true });
    if (r.code !== 0) problems.push(`npm run ${script} failed:\n${(r.out + r.err).slice(-3000)}`);
  }
  return { ok: problems.length === 0, failure: problems.join("\n\n"), changes };
}
