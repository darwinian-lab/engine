// Issues with pictures: for a backlog item, an agent draws an HTML mockup of how it should look (in the site's own
// style) and points at where it goes on today's page. The engine renders both, publishes them and appends them to
// the issue, so a person sees the idea instead of imagining it.
import fs from "node:fs";
import path from "node:path";
import { claudeStream } from "./stream.mjs";
import { extractJson, limitHit, log } from "./util.mjs";
import { api } from "./ghpr.mjs";
import { renderHtml, shootMarked } from "./shots.mjs";
import { uploadMedia } from "./media.mjs";

export const VISUALS_MARK = "<!-- dw:visuals -->";

export async function siteHtml(domain, p = "/", routerKey = null) {
  // A bot user agent: the router never counts the engine's own visits as real visitors.
  const r = await fetch(`https://${domain}${p}`, { headers: { "user-agent": "darwinian-engine-bot" } }).catch(() => null);
  if (!r?.ok) return "";
  return (await r.text()).replace(/<script[\s\S]*?<\/script>/g, "").slice(0, 40000);
}

export const MOCKUP_SPEC = `"page": "the existing path this idea changes or adds to (e.g. \\"/\\" or \\"/pricing\\"), or null for a new page",
 "where": "a CSS selector on that page today where the change goes (or null)",
 "where_label": "a few words for that spot, e.g. \\"design panel goes here\\"",
 "mockup_html": "a complete, self-contained HTML document showing how it should look when done"`;

export const MOCKUP_RULES = `The mockup: one self-contained HTML document (inline <style>, inline SVG allowed; no external files, fonts,
images or scripts that fetch anything) with <meta name="viewport" content="width=device-width, initial-scale=1">. Match the site's current look (reuse its colours, fonts, spacing and
components from the HTML you were given). Show the realistic finished state with believable example content, the
whole relevant screen, responsive down to a 390px phone. Put data-note="short label" on the 1-3 elements that
are new, so they get annotated. Keep it under 25 KB.`;

/** Ask an agent for a mockup of one issue. */
export async function mockupFor({ cfg, model = "sonnet", product, domain, issue, html }) {
  const r = await claudeStream({
    args: ["-p", `You draw mockups for the backlog of "${product}" (${domain}) so people can see an idea before it is built.

## The idea (a backlog issue)
# ${issue.title}
${String(issue.body ?? "").replace(/<!-- dw:visuals -->[\s\S]*/, "").slice(0, 5000)}

## The site's current home page HTML (for its look: colours, fonts, components)
${html.slice(0, 30000)}

${MOCKUP_RULES}

Answer with ONLY JSON: {${MOCKUP_SPEC}}`, "--model", model],
    cwd: path.join(cfg.workdir, ".tmp"),
    label: `${product} mockup`,
    timeoutMs: 15 * 60_000,
    transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts"),
  });
  if (limitHit(r)) throw new Error("usage limit");
  return extractJson(r.out);
}

/** Render, publish and append visuals to an issue. Returns true if the issue was updated. */
export async function illustrateIssue({ cfg, repoSlug, species, domain, number, mock }) {
  if (!mock?.mockup_html) return false;
  const dir = path.join(cfg.workdir, ".tmp", "illustrate", `${species}-${number}`);
  try {
    const name = `issue-${number}`;
    const shots = await renderHtml({ html: mock.mockup_html, outDir: dir, name, notes: true });
    const today = mock.page ? await shootMarked({ url: `https://${domain}${mock.page}`, routerKey: cfg.routerKey, marks: mock.where ? [{ target: mock.where, label: mock.where_label ?? "this changes" }] : [], outDir: dir, name }) : null;
    const stamp = Date.now().toString(36);
    const up = async (it) => (it ? { ...it, url: await uploadMedia(`issues/${species}/${number}-${stamp}-${path.basename(it.file)}`, it.file) } : null);
    const [desk, phone] = await Promise.all(shots.map(up));
    const now = await up(today);
    if (!desk?.url) return false;
    const issue = await api("GET", `repos/${repoSlug}/issues/${number}`);
    const body = String(issue.body ?? "").replace(/\n*<!-- dw:visuals -->[\s\S]*/, "");
    const section = [
      "",
      VISUALS_MARK,
      now?.url ? `### Today (\`${mock.page}\`)\n\n<img src="${now.url}" width="640" alt="today">` : "",
      `### How it should look (mockup)\n\n<img src="${desk.url}" width="640" alt="mockup, desktop">${phone?.url ? ` <img src="${phone.url}" width="230" alt="mockup, phone">` : ""}`,
      "<sub>Mockup drawn by the engine to show the idea; red boxes mark what is new. The real build may differ.</sub>",
    ].filter((x) => x !== "").join("\n\n");
    await api("PATCH", `repos/${repoSlug}/issues/${number}`, { body: `${body}\n\n${section}`.slice(0, 65000) });
    // Keep the mockup's HTML with the issue's media, so builders and people can open it.
    const htmlFile = path.join(dir, "mockup.html");
    fs.writeFileSync(htmlFile, mock.mockup_html);
    await uploadMedia(`issues/${species}/${number}-${stamp}-mockup.html`, htmlFile);
    return true;
  } catch (e) {
    log(`illustrate #${number} failed: ${e.message}`);
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
