#!/usr/bin/env node
// One-time (idempotent) setup on the server:
//   node scripts/bootstrap.mjs --config /etc/darwinian/config.json
// Creates databases, fills placeholders, deploys the routers and generation 0 of every species.

import fs from "node:fs";
import path from "node:path";
import { d1 } from "../evolve/lib/d1.mjs";
import { loadConfig, ENGINE_DIR } from "../evolve/lib/config.mjs";
import { must, run, log } from "../evolve/lib/util.mjs";

// In GitHub Actions, surface fatal errors as annotations (readable without opening the log).
const annotate = (e) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${String(e?.stack ?? e).slice(0, 1500).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A")}`);
  console.error(e);
  process.exit(1);
};
process.on("uncaughtException", annotate);
process.on("unhandledRejection", annotate);


const cfg = loadConfig();
const engine = ENGINE_DIR;
const env = { CLOUDFLARE_API_TOKEN: cfg.cloudflare.apiToken, CLOUDFLARE_ACCOUNT_ID: cfg.cloudflare.accountId };
const api = cfg.cloudflare.apiBase ?? "https://api.cloudflare.com/client/v4";
const save = () => cfg.save();
const git = (cwd, ...a) => must("git", ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local", ...a], { cwd });

async function cf(p, init = {}) {
  const r = await fetch(api + p, { ...init, headers: { authorization: `Bearer ${cfg.cloudflare.apiToken}`, "content-type": "application/json" } });
  const j = await r.json();
  if (!j.success) throw new Error(`${p}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

async function database(name) {
  const list = await cf(`/accounts/${cfg.cloudflare.accountId}/d1/database?name=${name}`);
  const hit = list.find((d) => d.name === name);
  if (hit) return hit.uuid;
  log(`creating D1 database ${name}`);
  return (await cf(`/accounts/${cfg.cloudflare.accountId}/d1/database`, { method: "POST", body: JSON.stringify({ name }) })).uuid;
}

function fill(file, map) {
  let s = fs.readFileSync(file, "utf8");
  const before = s;
  for (const [k, v] of Object.entries(map)) s = s.split(k).join(v);
  if (s !== before) fs.writeFileSync(file, s);
  return s !== before;
}

// 0. keys + workers.dev subdomain
if (!cfg.routerKey || !cfg.labKey) throw new Error("DW_ROUTER_KEY and DW_LAB_KEY must be set (the bootstrap workflow creates them).");
if (!cfg.cloudflare.workersSubdomain) {
  const sub = await cf(`/accounts/${cfg.cloudflare.accountId}/workers/subdomain`).catch(() => null);
  if (!sub?.subdomain) throw new Error("No workers.dev subdomain yet: open Workers & Pages in the Cloudflare dashboard once to claim one, then re-run.");
  cfg.cloudflare.workersSubdomain = sub.subdomain;
}
save();

// 1. engine database
cfg.cloudflare.d1Engine = await database("darwinian");
save();
const db = d1(cfg, cfg.cloudflare.d1Engine);
for (const f of fs.readdirSync(path.join(engine, "migrations")).sort()) {
  await db.run(fs.readFileSync(path.join(engine, "migrations", f), "utf8")); // all statements are idempotent
}

// commit discovered state (d1 id, workers subdomain) so scheduled runs can use it
if ((await run("git", ["status", "--porcelain", "evolve/state.json"], { cwd: engine })).out.trim()) {
  await git(engine, "add", "evolve/state.json");
  await git(engine, "commit", "-q", "-m", "bootstrap: record database and workers subdomain");
  await git(engine, "push", "-q", "origin", "HEAD:main");
}

// 2. routers
const domains = Object.fromEntries(cfg.species.map((s) => [`__DOMAIN_${s.id.toUpperCase()}__`, s.domain]));
if (fill(path.join(engine, "router/wrangler.toml"), { __D1_ID__: cfg.cloudflare.d1Engine, ...domains })) {
  await git(engine, "add", "router/wrangler.toml");
  await git(engine, "commit", "-q", "-m", "bootstrap: router database and domains");
  await git(engine, "push", "-q", "origin", "HEAD:main");
}
for (const sp of cfg.species) {
  log(`deploying router for ${sp.id} on ${sp.domain}`);
  await must("npx", ["wrangler", "deploy", "--env", sp.id], { cwd: path.join(engine, "router"), env, timeoutMs: 300_000 });
  const secrets = [["ROUTER_KEY", cfg.routerKey], ["LAB_KEY", cfg.labKey]];
  // The first species' router doubles as the experiment's clock (starts an evolve run every 3 hours).
  if (sp === cfg.species[0] && process.env.DW_GH_TOKEN) secrets.push(["GH_DISPATCH_TOKEN", process.env.DW_GH_TOKEN]);
  for (const [k, v] of secrets) {
    await must("npx", ["wrangler", "secret", "put", k, "--env", sp.id], { cwd: path.join(engine, "router"), env, input: v });
  }
}

// 3. species: database, generation 0 (frozen control + first champion)
for (const sp of cfg.species) {
  const repo = path.join(cfg.workdir, sp.repo);
  const sdb = await database(`sp-${sp.id}`);
  if (fill(path.join(repo, "wrangler.toml"), { __SDB_ID__: sdb, ...domains })) {
    await git(repo, "add", "wrangler.toml");
    await git(repo, "commit", "-q", "-m", "bootstrap: database and domain");
    await git(repo, "push", "-q", "origin", "HEAD:main");
  }
  await must("npm", ["install", "--no-audit", "--no-fund"], { cwd: repo, timeoutMs: 600_000 });
  await must("npx", ["wrangler", "d1", "migrations", "apply", `sp-${sp.id}`, "--remote"], { cwd: repo, env, timeoutMs: 300_000 });

  const species = JSON.parse(fs.readFileSync(path.join(repo, "species.json"), "utf8"));
  await db.run("INSERT INTO species_config (species, json, updated_at) VALUES (?,?,?) ON CONFLICT(species) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at", [sp.id, JSON.stringify(species), Date.now()]);
  await db.run("INSERT OR IGNORE INTO species_state (species, stage, generation, updated_at) VALUES (?,0,0,?)", [sp.id, Date.now()]);

  for (const [armId, status] of [["g0-ctrl", "control"], ["g0-base", "champion"]]) {
    const exists = await db.first("SELECT arm_id FROM arms WHERE species=? AND arm_id=?", [sp.id, armId]);
    if (exists) continue;
    const name = `sp-${sp.id}-${armId}`;
    log(`deploying ${name}`);
    await must("npx", ["wrangler", "deploy", "--name", name, "--var", `ROUTER_KEY:${cfg.routerKey}`], { cwd: repo, env, timeoutMs: 300_000 });
    const tag = `fossil/${sp.id}/${armId}`;
    await run("git", ["tag", tag], { cwd: repo });
    await run("git", ["push", "-q", "origin", tag], { cwd: repo });
    await db.run(
      "INSERT INTO arms (species, arm_id, origin, status, generation, parent, git_ref, hypothesis, created_at) VALUES (?,?,?,?,0,NULL,?,?,?)",
      [sp.id, armId, `https://${name}.${cfg.cloudflare.workersSubdomain}.workers.dev`, status, tag,
        status === "control" ? "Frozen generation 0. Never evolves: the baseline every lineage is compared against." : "Generation 0: the seed, written by hand.", Date.now()],
    );
  }
  await db.run("INSERT INTO journal (ts, species, kind, arm_id, detail) VALUES (?,?,?,?,?)", [Date.now(), sp.id, "note", null, "bootstrap complete: generation 0 is alive"]);
}

console.log("\nDone. Lab dashboards (add ?key=<your DW_LAB_KEY>):");
for (const sp of cfg.species) console.log(`  ${sp.id}: https://${sp.domain}/_dw/lab`);
