import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

/** Run a command, capture output. Never throws; returns { code, out, err }. */
// Environment for AI agents: no secrets (Cloudflare, GitHub, lab key) and no git credentials, only what the CLIs need.
const AGENT_ENV_KEEP = /^(PATH|HOME|USER|LANG|LC_\w+|TERM|TMPDIR|SHELL|CI|NODE_\w+|npm_config_\w+|PLAYWRIGHT_BROWSERS_PATH|CLAUDE_CODE_OAUTH_TOKEN|DW_CHROME|XDG_\w+)$/;
export function agentEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (AGENT_ENV_KEEP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/** Writes a line to the CI log, prefixed so interleaved agents stay readable. */
// Values that must never appear in logs (the engine repo and its Actions logs are public). Derived keys are not
// GitHub secrets, so Actions doesn't mask them by itself: each is registered with ::add-mask:: and redacted here.
const SECRETS = new Set();
export function addSecret(v) {
  if (!v || v.length < 8 || SECRETS.has(v)) return;
  SECRETS.add(v);
  if (process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${v}\n`);
}
export function redact(text) {
  let t = String(text ?? "");
  for (const v of SECRETS) t = t.split(v).join("***");
  return t;
}

export function echo(prefix, line) {
  for (const l of redact(line).split("\n")) if (l.trim()) process.stdout.write(`${prefix} ${l}\n`);
}

export function run(cmd, args, { cwd, timeoutMs = 10 * 60_000, input, env, agent = false, onLine, echoPrefix } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: agent ? agentEnv(env) : { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    // Optional live streaming: every output line goes to onLine (and/or straight to the CI log) as it arrives.
    if (onLine || echoPrefix) {
      const buf = { stdout: "", stderr: "" };
      for (const name of ["stdout", "stderr"]) {
        p[name].on("data", (d) => {
          buf[name] += d;
          const lines = buf[name].split("\n");
          buf[name] = lines.pop();
          for (const l of lines) {
            if (onLine) onLine(l, name);
            else echo(echoPrefix, l);
          }
        });
        p[name].on("end", () => {
          if (buf[name]) (onLine ? onLine(buf[name], name) : echo(echoPrefix, buf[name]));
        });
      }
    }
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      err += `\n[timeout after ${timeoutMs}ms]`;
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5000);
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: 127, out, err: err + String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out, err });
    });
    if (input) p.stdin.write(input);
    p.stdin.end();
  });
}

/** Like run, but throws on non-zero exit. */
export async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(redact(`${cmd} ${args.join(" ")} failed (${r.code}):\n${(r.err || r.out).slice(-3000)}`));
  return r.out;
}

/** Expand a command template like ["codex","exec","-o","{out}","{prompt}"]. */
export function expand(tpl, vars) {
  return tpl.map((x) => x.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "")));
}

export function rid(n = 4) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** Pull the first JSON object out of a model's free-text answer. */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function lock(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => fs.rmSync(file, { force: true });
  } catch {
    const pid = Number(fs.readFileSync(file, "utf8"));
    try {
      process.kill(pid, 0);
      return null; // another run is alive
    } catch {
      fs.rmSync(file, { force: true }); // stale lock
      return lock(file);
    }
  }
}

export const stripHtml = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Did an agent stop because the account hit its usage limit? Only the agent's final message (Claude prints
 * "You've hit your 5-hour limit · resets …" as its whole answer) or its error stream count; an agent's normal
 * answer may well mention "rate limits" or "quota" as part of the work.
 */
export function limitHit({ out = "", err = "", code = 0 }) {
  const msg = /^\s*(you['’]ve hit your [\w -]*limit|claude ai usage limit reached|usage limit reached)/i;
  if (msg.test(out.trim().slice(0, 200))) return true;
  return code !== 0 && /hit your [\w -]*limit|usage limit|rate.?limit|limit reached|quota|credit balance/i.test(err.slice(-2000));
}
