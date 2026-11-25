// Runs Claude Code with streaming JSON output and renders every event (thinking, messages, tool calls and results,
// including those of subagents) to the CI log as it happens. The raw stream is kept as a transcript file.
import fs from "node:fs";
import path from "node:path";
import { run, echo } from "./util.mjs";

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function describeTool(name, input = {}) {
  if (name === "Bash") return `$ ${clip(input.command, 300)}`;
  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return `${name} ${input.file_path ?? input.notebook_path ?? ""}`;
  if (name === "Glob" || name === "Grep") return `${name} ${clip(input.pattern, 120)}${input.path ? ` in ${input.path}` : ""}`;
  if (name === "Task" || name === "Agent") return `${name} → ${clip(input.description ?? input.subagent_type ?? "", 120)}`;
  if (name === "WebFetch") return `WebFetch ${input.url}`;
  if (name === "TodoWrite") return `TodoWrite ${(input.todos ?? []).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "·"} ${clip(t.content, 60)}`).join(" | ")}`;
  if (name.startsWith("mcp__browser__")) return `🌐 ${name.replace(/^mcp__browser__/, "")} ${clip(input.url ?? input.element ?? input.text ?? JSON.stringify(input), 160)}`;
  return `${name} ${clip(JSON.stringify(input), 160)}`;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join(" ");
  return JSON.stringify(content ?? "");
}

/**
 * claude -p with live rendering. `args` are the usual claude arguments WITHOUT --output-format.
 * Returns { code, out (final result text), err, transcript }.
 */
export async function claudeStream({ args, cwd, timeoutMs, label, transcriptDir, env, agent = true }) {
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, `${label.replace(/[^\w.-]+/g, "_")}-${Date.now()}.jsonl`);
  const raw = fs.createWriteStream(transcript);
  const prefix = `[${label}]`;
  const subagents = new Map(); // tool_use_id of a Task call → its description
  let final = "";
  let errText = "";
  echo(prefix, `▶ start`);
  const r = await run("claude", [...args, "--output-format", "stream-json", "--verbose"], {
    cwd,
    timeoutMs,
    env,
    agent,
    onLine: (line, stream) => {
      if (stream === "stderr") {
        errText += line + "\n";
        echo(prefix, `⚠ ${clip(line, 400)}`);
        return;
      }
      raw.write(line + "\n");
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        echo(prefix, clip(line, 400));
        return;
      }
      const sub = ev.parent_tool_use_id ? subagents.get(ev.parent_tool_use_id) : null;
      const p = sub ? `${prefix} [sub: ${clip(sub, 40)}]` : prefix;
      if (ev.type === "system" && ev.subtype === "init") echo(p, `model ${ev.model ?? "?"}, tools: ${(ev.tools ?? []).length}${(ev.mcp_servers ?? []).length ? `, mcp: ${ev.mcp_servers.map((m) => `${m.name}(${m.status})`).join(" ")}` : ""}`);
      if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "thinking" && c.thinking) echo(p, `🤔 ${clip(c.thinking, 800)}`);
          if (c.type === "text" && c.text) echo(p, `💬 ${clip(c.text, 2000)}`);
          if (c.type === "tool_use") {
            if (c.name === "Task" || c.name === "Agent") subagents.set(c.id, c.input?.description ?? c.input?.subagent_type ?? "subagent");
            echo(p, `🔧 ${describeTool(c.name, c.input)}`);
          }
        }
      }
      if (ev.type === "user") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "tool_result") echo(p, `   ↳ ${c.is_error ? "error" : "ok"}: ${clip(resultText(c.content), 240)}`);
        }
      }
      if (ev.type === "result") {
        final = ev.result ?? "";
        echo(prefix, `■ ${ev.subtype ?? "done"} in ${ev.num_turns ?? "?"} turns, ${Math.round((ev.duration_ms ?? 0) / 1000)} s`);
      }
    },
  });
  raw.end();
  return { code: r.code, out: final || "", err: errText + r.err, transcript };
}
