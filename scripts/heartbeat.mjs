// Appends one line per day to log/YYYY-MM.md summarising what evolution did in the last 24h.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ENGINE_DIR } from "../evolve/lib/config.mjs";
import { d1 } from "../evolve/lib/d1.mjs";
import { run } from "../evolve/lib/util.mjs";

const cfg = loadConfig();
if (!cfg.cloudflare.d1Engine) process.exit(0);
const db = d1(cfg, cfg.cloudflare.d1Engine);
const day = new Date().toISOString().slice(0, 10);
const file = path.join(ENGINE_DIR, "log", `${day.slice(0, 7)}.md`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# Evolution log ${day.slice(0, 7)}\n\n`;
if (existing.includes(`- ${day}`)) process.exit(0);
const rows = await db.all("SELECT species, kind, COUNT(*) n FROM journal WHERE ts > ? GROUP BY species, kind", [Date.now() - 86400_000]);
const by = {};
for (const r of rows) (by[r.species ?? "engine"] ??= []).push(`${r.n} ${r.kind}`);
const line = `- ${day}: ${Object.entries(by).map(([s, k]) => `**${s}** ${k.join(", ")}`).join(" · ") || "quiet day"}\n`;
fs.writeFileSync(file, existing + line);
await run("git", ["add", file], { cwd: ENGINE_DIR });
await run("git", ["commit", "-q", "-m", `log: ${day}`], { cwd: ENGINE_DIR });
await run("git", ["push", "-q", "origin", "HEAD:main"], { cwd: ENGINE_DIR });
