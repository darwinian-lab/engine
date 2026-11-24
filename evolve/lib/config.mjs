// Config = settings.json (committed, non-secret) + state.json (written by bootstrap, committed)
// + secrets from the environment. `--config file.json` still works for running on a server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./util.mjs";

export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STATE_PATH = path.join(ENGINE_DIR, "evolve/state.json");

export function loadConfig(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--config");
  const file = i >= 0 ? argv[i + 1] : process.env.DW_CONFIG;
  if (file) {
    const cfg = readJson(file, null);
    if (!cfg) throw new Error(`cannot read config ${file}`);
    cfg.save = () => fs.writeFileSync(file, JSON.stringify(stripFns(cfg), null, 2));
    return cfg;
  }
  const settings = readJson(path.join(ENGINE_DIR, "evolve/settings.json"), null);
  if (!settings) throw new Error("missing evolve/settings.json");
  const state = readJson(STATE_PATH, {});
  const env = process.env;
  const cfg = {
    ...settings,
    workdir: env.DW_WORKDIR ?? settings.workdir ?? path.join(ENGINE_DIR, "..", "work"),
    cloudflare: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      workersSubdomain: state.workersSubdomain ?? "",
      d1Engine: state.d1Engine ?? "",
      apiBase: settings.cloudflareApiBase,
    },
    routerKey: env.DW_ROUTER_KEY ?? "",
    labKey: env.DW_LAB_KEY ?? "",
  };
  // Persist only the non-secret, bootstrap-discovered values.
  cfg.save = () =>
    fs.writeFileSync(STATE_PATH, JSON.stringify({ workersSubdomain: cfg.cloudflare.workersSubdomain, d1Engine: cfg.cloudflare.d1Engine }, null, 2) + "\n");
  return cfg;
}

function stripFns(o) {
  return JSON.parse(JSON.stringify(o));
}
