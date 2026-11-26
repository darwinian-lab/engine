// Visuals for the lab, PRs and issues:
// - capture(): validated screenshots of an arm's key pages (desktop + phone). Error pages (Cloudflare errors,
//   "failed to load", blank pages) are retried and never stored.
// - runDemo(): a mutant's own demo (demo.json): annotated screenshots of exactly what changed, and a captioned
//   video of the flow the change is about (mp4 for the lab, GIF for GitHub). Run on the mutant and on its parent,
//   the same steps give before/after pairs.
// - renderHtml(): renders an HTML mockup (issues: "how it should look").
import fs from "node:fs";
import path from "node:path";
import { run } from "./util.mjs";

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, maxHeight: 4200 },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    maxHeight: 2800,
  },
};

const BAD_PAGE = /error 1\d{3}|worker threw exception|worker exceeded|internal server error|bad gateway|service unavailable|failed to load|this page isn.t working|application error|cannot (get|post) \/|there is nothing here yet|error code: \d{3,4}|web server is down|too many redirects/i;

/** The router key only ever goes to the arm's own origin, never to third parties. */
async function guard(ctx, origin, routerKey) {
  if (!routerKey) return;
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (!req.url().startsWith(origin)) return route.continue();
    return route.continue({ headers: { ...req.headers(), "x-dw-key": routerKey, "x-dw-visitor": "evolve-shot" } });
  });
}

async function browserOrNull() {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch(process.env.DW_CHROME ? { executablePath: process.env.DW_CHROME } : {});
  } catch (e) {
    console.log(`visuals unavailable: ${e.message.split("\n")[0]}`);
    return null; // visuals are a nice-to-have; never block evolution on them
  }
}

/** Is what the page shows a real page (not an error, a blank, or a platform default)? */
async function healthy(page, res) {
  if (res && res.status() >= 400) return `HTTP ${res.status()}`;
  const info = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 3000) })).catch(() => ({ title: "", text: "" }));
  if (info.text.trim().length < 80) return "blank page";
  if (BAD_PAGE.test(info.title) || BAD_PAGE.test(info.text.slice(0, 1500))) return `error page: ${(info.title || info.text).slice(0, 80)}`;
  return null;
}

/** Load a page, retrying while it shows an error (fresh deployments can take a moment). */
async function load(page, url, tries = 4) {
  let why = "not loaded";
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(600);
      why = await healthy(page, res);
      if (!why) return null;
    } catch (e) {
      why = e.message.split("\n")[0];
    }
    await page.waitForTimeout(4000 * i);
  }
  return why;
}

/** Validated full-page screenshots of the key pages on desktop and phone. */
export async function capture({ origin, routerKey, pages, outDir }) {
  const browser = await browserOrNull();
  if (!browser) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  try {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const { maxHeight, ...opts } = vp;
      const ctx = await browser.newContext({ ...opts, reducedMotion: "reduce" });
      await guard(ctx, origin, routerKey);
      const page = await ctx.newPage();
      for (const p of pages.slice(0, 4)) {
        const bad = await load(page, origin + p);
        if (bad) {
          console.log(`shot ${vpName} ${p} skipped: ${bad}`);
          continue;
        }
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        const height = Math.min(h, maxHeight);
        const file = path.join(outDir, `key-${vpName}-${p.replace(/\W+/g, "_") || "home"}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 72, fullPage: true, clip: { x: 0, y: 0, width: opts.viewport.width, height } });
        out.push({ kind: "shot", role: "key", page: p, name: p, viewport: vpName, file, mime: "image/jpeg", width: opts.viewport.width * opts.deviceScaleFactor, height: height * opts.deviceScaleFactor });
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Demos: what a mutant changed, shown the way a person would see it.
// ---------------------------------------------------------------------------------------------------------

// Overlay helpers injected into every page: numbered boxes around elements, a caption bar, and a visible cursor.
const OVERLAY = `(() => {
  if (window.__dw) return;
  const css = document.createElement("style");
  css.textContent = ".__dw-box{position:absolute;border:3px solid #e5484d;border-radius:8px;box-shadow:0 0 0 4px rgba(229,72,77,.25);pointer-events:none;z-index:2147483646}" +
    ".__dw-tag{position:absolute;background:#e5484d;color:#fff;font:600 13px/1.25 system-ui,sans-serif;padding:4px 8px;border-radius:6px;max-width:280px;pointer-events:none;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,.25)}" +
    ".__dw-cap{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:rgba(17,17,17,.88);color:#fff;font:600 16px/1.35 system-ui,sans-serif;padding:10px 16px;border-radius:10px;max-width:86vw;text-align:center;z-index:2147483647;pointer-events:none}" +
    ".__dw-cur{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(229,72,77,.35);border:2px solid #e5484d;z-index:2147483647;pointer-events:none;transition:left .35s ease,top .35s ease,transform .15s}";
  const add = () => document.documentElement.appendChild(css);
  document.documentElement ? add() : document.addEventListener("DOMContentLoaded", add);
  window.__dw = {
    clear() { document.querySelectorAll(".__dw-box,.__dw-tag").forEach((n) => n.remove()); },
    mark(el, n, label) {
      const r = el.getBoundingClientRect(), sx = scrollX, sy = scrollY;
      const b = document.createElement("div"); b.className = "__dw-box";
      Object.assign(b.style, { left: r.left + sx - 6 + "px", top: r.top + sy - 6 + "px", width: r.width + 12 + "px", height: r.height + 12 + "px" });
      const t = document.createElement("div"); t.className = "__dw-tag"; t.textContent = (n ? n + ". " : "") + (label || "");
      document.body.append(b, t);
      // The label straddles the box's top edge at its right end, so it hides as little of the page as possible.
      const tw = t.offsetWidth;
      Object.assign(t.style, { left: Math.max(4, Math.min(r.right + sx + 6 - tw, Math.min(document.documentElement.scrollWidth, innerWidth + sx) - tw - 4)) + "px", top: Math.max(2, r.top + sy - 20) + "px" });
    },
    caption(text) {
      let c = document.querySelector(".__dw-cap");
      if (!text) return c && c.remove();
      if (!c) { c = document.createElement("div"); c.className = "__dw-cap"; document.body.appendChild(c); }
      c.textContent = text;
    },
    cursor(x, y, press) {
      let c = document.querySelector(".__dw-cur");
      if (!c) { c = document.createElement("div"); c.className = "__dw-cur"; c.style.left = innerWidth / 2 + "px"; c.style.top = innerHeight / 2 + "px"; document.body.appendChild(c); }
      c.style.left = x + "px"; c.style.top = y + "px"; c.style.transform = press ? "scale(.7)" : "scale(1)";
    },
  };
})();`;

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "x";

/** Run one demo step. Returns an error string or null. */
async function step(page, s, { show = false } = {}) {
  const t = 8000;
  try {
    const a = s.action;
    if (a === "goto") return (await load(page, new URL(s.value ?? s.target ?? "/", page.url()).href, 2));
    if (a === "wait") return (await page.waitForTimeout(Math.min(Number(s.value) || 800, 5000)), null);
    if (a === "scroll") {
      if (s.target) await page.locator(s.target).first().scrollIntoViewIfNeeded({ timeout: t });
      else await page.mouse.wheel(0, Number(s.value) || 600);
      return null;
    }
    if (a === "press" && !s.target) return (await page.keyboard.press(String(s.value)), null);
    const loc = page.locator(s.target).first();
    await loc.waitFor({ state: "visible", timeout: t });
    await loc.scrollIntoViewIfNeeded({ timeout: t });
    if (show) {
      const box = await loc.boundingBox();
      if (box) {
        await page.evaluate(([x, y]) => window.__dw?.cursor(x, y, false), [box.x + box.width / 2, box.y + box.height / 2]);
        await page.waitForTimeout(450);
        if (a === "click" || a === "check") await page.evaluate(([x, y]) => window.__dw?.cursor(x, y, true), [box.x + box.width / 2, box.y + box.height / 2]);
      }
    }
    if (a === "click") await loc.click({ timeout: t });
    else if (a === "fill") {
      if (show) await loc.pressSequentially(String(s.value ?? ""), { delay: 45, timeout: 20_000 });
      else await loc.fill(String(s.value ?? ""), { timeout: t });
    } else if (a === "select") await loc.selectOption(String(s.value), { timeout: t });
    else if (a === "check") await loc.check({ timeout: t });
    else if (a === "hover") await loc.hover({ timeout: t });
    else if (a === "press") await loc.press(String(s.value), { timeout: t });
    else if (a === "upload") return "upload is not supported in demos";
    else return `unknown action ${a}`;
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    return null;
  } catch (e) {
    return `${s.action} ${s.target ?? ""}: ${e.message.split("\n")[0].slice(0, 160)}`;
  }
}

/** Draw the annotations of a shot; returns how many elements were found. */
async function annotate(page, marks = []) {
  await page.evaluate(() => window.__dw?.clear());
  let found = 0;
  for (const [i, m] of marks.slice(0, 6).entries()) {
    const loc = page.locator(m.target).first();
    if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) continue;
    if (found === 0) await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const h = await loc.elementHandle({ timeout: 1500 }).catch(() => null);
    if (!h) continue;
    await page.evaluate(([el, n, label]) => window.__dw?.mark(el, n, label), [h, marks.length > 1 ? i + 1 : 0, m.label ?? ""]);
    found++;
  }
  return found;
}

/**
 * demo = { shots: [{ name, path, viewport?, steps?: [...], marks?: [{target, label}], caption? }],
 *          flow?: { name, path, viewport?, steps: [{ action, target?, value?, caption? }] } }
 * Returns { items, errors }: items are files to publish (role "demo" shots and "flow" video/gif).
 */
export async function runDemo({ origin, routerKey, demo, outDir, side = "after", flow = true }) {
  const browser = await browserOrNull();
  if (!browser) return { items: [], errors: ["no browser"] };
  fs.mkdirSync(outDir, { recursive: true });
  const items = [], errors = [];
  try {
    for (const [k, sh] of (demo?.shots ?? []).slice(0, 6).entries()) {
      const vpName = sh.viewport === "mobile" ? "mobile" : "desktop";
      const { maxHeight, ...opts } = VIEWPORTS[vpName];
      const ctx = await browser.newContext({ ...opts, reducedMotion: "reduce" });
      await guard(ctx, origin, routerKey);
      await ctx.addInitScript(OVERLAY);
      const page = await ctx.newPage();
      let note = null;
      const bad = await load(page, origin + (sh.path ?? "/"));
      if (bad) {
        errors.push(`shot "${sh.name}": ${bad}`);
        await ctx.close();
        continue;
      }
      for (const s of sh.steps ?? []) {
        const err = await step(page, s);
        if (err) { note = err; break; }
      }
      const found = await annotate(page, sh.marks);
      if (side === "after" && (note || (sh.marks?.length && !found))) errors.push(`shot "${sh.name}": ${note ?? "none of its marked elements are visible"}`);
      const file = path.join(outDir, `${side}-${k}-${slug(sh.name)}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 80 });
      items.push({ kind: "shot", role: side, name: sh.name, caption: sh.caption ?? null, page: sh.path ?? "/", viewport: vpName, file, mime: "image/jpeg", width: opts.viewport.width * opts.deviceScaleFactor, height: opts.viewport.height * opts.deviceScaleFactor, note: note && side === "before" ? "not available before this change" : null });
      await ctx.close();
    }
    if (flow && demo?.flow?.steps?.length) {
      const f = demo.flow;
      const vpName = f.viewport === "mobile" ? "mobile" : "desktop";
      const { maxHeight, ...opts } = VIEWPORTS[vpName];
      const size = { width: opts.viewport.width, height: opts.viewport.height };
      // Frames come from Chrome's screencast, sampled at a fixed rate (works with any Chrome, no Playwright ffmpeg).
      const fdir = path.join(outDir, `frames-${side}`);
      fs.mkdirSync(fdir, { recursive: true });
      const ctx = await browser.newContext({ ...opts, deviceScaleFactor: 1 });
      await guard(ctx, origin, routerKey);
      await ctx.addInitScript(OVERLAY);
      const page = await ctx.newPage();
      const FPS = 10;
      let last = null, k = 0, timer = null;
      const cdp = await ctx.newCDPSession(page);
      cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
        last = data;
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
      const bad = await load(page, origin + (f.path ?? "/"));
      let failed = bad ? `flow: ${bad}` : null;
      if (!failed) {
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
        timer = setInterval(() => { if (last && k < 1800) fs.writeFileSync(path.join(fdir, `f${String(k++).padStart(5, "0")}.jpg`), Buffer.from(last, "base64")); }, 1000 / FPS);
        await page.evaluate((t) => window.__dw?.caption(t), f.name ?? "");
        await page.waitForTimeout(1500);
        for (const s of f.steps.slice(0, 25)) {
          if (s.caption) await page.evaluate((t) => window.__dw?.caption(t), s.caption);
          const err = await step(page, s, { show: true });
          if (err) { failed = `flow step ${err}`; break; }
          await page.waitForTimeout(900);
        }
        await page.waitForTimeout(1800);
        clearInterval(timer);
        await cdp.send("Page.stopScreencast").catch(() => {});
      }
      await ctx.close();
      if (failed && side === "after") errors.push(failed);
      if (k > FPS && (!failed || side === "after")) {
        const input = ["-framerate", String(FPS), "-i", path.join(fdir, "f%05d.jpg")];
        const mp4 = path.join(outDir, `flow-${side}.mp4`), gif = path.join(outDir, `flow-${side}.gif`);
        const a = await run("ffmpeg", ["-y", "-loglevel", "error", ...input, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4], { timeoutMs: 240_000 });
        if (a.code === 0) items.push({ kind: "video", role: `flow-${side}`, name: f.name ?? "Flow", caption: failed ? `stopped early: ${failed}` : null, page: f.path ?? "/", viewport: vpName, file: mp4, mime: "video/mp4", width: size.width, height: size.height });
        else console.log(`ffmpeg mp4 failed: ${(a.err || a.out).slice(-300)}`);
        const w = vpName === "mobile" ? 320 : 720;
        const g = await run("ffmpeg", ["-y", "-loglevel", "error", ...input, "-vf", `fps=8,scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, "-loop", "0", gif], { timeoutMs: 240_000 });
        if (g.code === 0 && fs.statSync(gif).size < 9_000_000) items.push({ kind: "gif", role: `flow-${side}`, name: f.name ?? "Flow", page: f.path ?? "/", viewport: vpName, file: gif, mime: "image/gif", width: w, height: Math.round((w * size.height) / size.width) });
      }
      fs.rmSync(fdir, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
  return { items, errors };
}

/** Render an HTML document (a mockup) to images, desktop and phone. */
export async function renderHtml({ html, outDir, name, notes = false }) {
  const browser = await browserOrNull();
  if (!browser) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  try {
    for (const vpName of ["desktop", "mobile"]) {
      const { maxHeight, ...opts } = VIEWPORTS[vpName];
      const ctx = await browser.newContext({ ...opts, javaScriptEnabled: true });
      await ctx.route("**/*", (r) => (r.request().url().startsWith("data:") || r.request().url() === "about:blank" ? r.continue() : r.abort()));
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(400);
      if (notes) {
        await page.addScriptTag({ content: OVERLAY }).catch(() => {});
        await page.evaluate(() => { window.__dw?.clear(); const els = [...document.querySelectorAll("[data-note]")].slice(0, 4); els.forEach((el, i) => window.__dw?.mark(el, els.length > 1 ? i + 1 : 0, el.getAttribute("data-note"))); window.scrollTo(0, 0); }).catch(() => {});
      }
      // Crop to the content (a mockup often has an empty tail), within the usual height limit.
      const content = await page.evaluate(() => Math.ceil(Math.max(0, ...[...document.body.querySelectorAll("*")].map((e) => e.getBoundingClientRect().bottom + scrollY)) + 32));
      const h = Math.min(Math.max(content, opts.viewport.height / 2), maxHeight);
      const file = path.join(outDir, `${slug(name)}-${vpName}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 82, fullPage: true, clip: { x: 0, y: 0, width: opts.viewport.width, height: h } });
      out.push({ kind: "shot", role: "mockup", name, viewport: vpName, file, mime: "image/jpeg" });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** A screenshot of a live page with an optional annotation (issues: "where this goes today"). */
export async function shootMarked({ url, routerKey = null, marks = [], outDir, name, viewport = "desktop" }) {
  const browser = await browserOrNull();
  if (!browser) return null;
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const { maxHeight, ...opts } = VIEWPORTS[viewport];
    // A bot user agent: on a public domain the router serves the champion and never counts this as a visitor.
    const ua = `${opts.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"} darwinian-engine-bot`;
    const ctx = await browser.newContext({ ...opts, userAgent: ua, reducedMotion: "reduce" });
    await guard(ctx, new URL(url).origin, routerKey);
    await ctx.addInitScript(OVERLAY);
    const page = await ctx.newPage();
    if (await load(page, url, 3)) return null;
    await annotate(page, marks);
    const file = path.join(outDir, `${slug(name)}-today.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 80 });
    return { kind: "shot", role: "today", name, viewport, file, mime: "image/jpeg" };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Storage: files go to the media branch (by URL); the database keeps a small row per file.
// ---------------------------------------------------------------------------------------------------------
import { uploadMedia } from "./media.mjs";

const CHUNK = 400_000; // base64 chars per row (legacy fallback for small images only)

/** Publish captured files and record them. Returns [{...item, url}] for the ones that made it. */
export async function storeMedia(db, species, armId, items, { prefix = "" } = {}) {
  const stored = [];
  const stamp = Date.now().toString(36);
  for (const it of items) {
    const bytes = fs.statSync(it.file).size;
    const url = await uploadMedia(`${species}/${armId}/${stamp}-${prefix}${path.basename(it.file)}`, it.file);
    if (!url && (bytes > 1_500_000 || it.kind !== "shot")) continue;
    const [row] = await db.all(
      "INSERT INTO media (species, arm_id, kind, page, viewport, mime, size, width, height, created_at, url, role, name, caption, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      [species, armId, it.kind, it.page ?? null, it.viewport ?? null, it.mime, bytes, it.width ?? null, it.height ?? null, Date.now(), url, it.role ?? null, it.name ?? null, it.caption ?? null, it.note ?? null],
    );
    if (!url) {
      const b64 = fs.readFileSync(it.file).toString("base64");
      for (let i = 0, seq = 0; i < b64.length; i += CHUNK, seq++) await db.run("INSERT INTO media_chunk (media_id, seq, data) VALUES (?,?,?)", [row.id, seq, b64.slice(i, i + CHUNK)]);
    }
    stored.push({ ...it, url: url ?? null, id: row.id });
  }
  return stored;
}
