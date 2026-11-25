// Photographs a deployed arm for the lab: full-page screenshots of its key pages on desktop and
// on a phone, plus a short phone video scrolling through the home page.
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

/** The router key only ever goes to the arm's own origin, never to third parties. */
async function guard(ctx, origin, routerKey) {
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (!req.url().startsWith(origin)) return route.continue();
    return route.continue({ headers: { ...req.headers(), "x-dw-key": routerKey, "x-dw-visitor": "evolve-shot" } });
  });
}

export async function capture({ origin, routerKey, pages, outDir, video = true }) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return []; // photos are a nice-to-have; never block evolution on them
  }
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  const browser = await chromium.launch(process.env.DW_CHROME ? { executablePath: process.env.DW_CHROME } : {});
  try {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const { maxHeight, ...opts } = vp;
      const ctx = await browser.newContext({ ...opts, reducedMotion: "reduce" });
      await guard(ctx, origin, routerKey);
      const page = await ctx.newPage();
      for (const p of pages.slice(0, 3)) {
        try {
          await page.goto(origin + p, { waitUntil: "networkidle", timeout: 30_000 });
          await page.waitForTimeout(500);
          const h = await page.evaluate(() => document.documentElement.scrollHeight);
          const height = Math.min(h, maxHeight);
          const file = path.join(outDir, `${vpName}-${p.replace(/\W+/g, "_") || "home"}.jpg`);
          await page.screenshot({ path: file, type: "jpeg", quality: 72, fullPage: true, clip: { x: 0, y: 0, width: opts.viewport.width, height } });
          out.push({ kind: "shot", page: p, viewport: vpName, file, mime: "image/jpeg", width: opts.viewport.width * opts.deviceScaleFactor, height: height * opts.deviceScaleFactor });
        } catch (e) {
          console.log(`shot ${vpName} ${p} failed: ${e.message.split("\n")[0]}`);
        }
      }
      await ctx.close();
    }

    if (video) await recordScroll(browser, origin, routerKey, outDir, out).catch((e) => console.log(`video failed: ${e.message.split("\n")[0]}`));
  } finally {
    await browser.close();
  }
  return out;
}

// A phone-sized scroll through the home page, built from evenly spaced frames (smooth and deterministic).
async function recordScroll(browser, origin, routerKey, outDir, out) {
  const { maxHeight, ...opts } = VIEWPORTS.mobile;
  const ctx = await browser.newContext({ ...opts, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await guard(ctx, origin, routerKey);
  const page = await ctx.newPage();
  const fdir = path.join(outDir, "frames");
  fs.mkdirSync(fdir, { recursive: true });
  try {
    await page.goto(origin + "/", { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(500);
    const end = await page.evaluate(() => Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, 6000)));
    const FPS = 15;
    const positions = [];
    for (let i = 0; i < FPS; i++) positions.push(0); // hold the first screen for a second
    const n = Math.max(1, Math.round(Math.min(7, 1.5 + end / 900) * FPS));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      positions.push(Math.round(end * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2))); // ease in-out
    }
    for (let i = 0; i < FPS; i++) positions.push(end); // and the last
    let k = 0;
    for (const y of positions) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.screenshot({ path: path.join(fdir, `f${String(k++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 80 });
    }
    const mp4 = path.join(outDir, "scroll.mp4");
    const r = await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(fdir, "f%04d.jpg"), "-vf", "scale=390:-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4],
      { timeoutMs: 180_000 },
    );
    if (r.code === 0 && fs.existsSync(mp4)) out.push({ kind: "video", page: "/", viewport: "mobile", file: mp4, mime: "video/mp4", width: 390, height: 844 });
    else console.log(`ffmpeg failed: ${(r.err || r.out).slice(-300)}`);
  } finally {
    fs.rmSync(fdir, { recursive: true, force: true });
    await ctx.close();
  }
}

const CHUNK = 400_000; // base64 chars per row

/** Stores captured files in the engine database (media + media_chunk). */
export async function storeMedia(db, species, armId, items) {
  let stored = 0;
  for (const it of items) {
    const b64 = fs.readFileSync(it.file).toString("base64");
    if (b64.length > 12_000_000) continue; // ~9 MB: something went wrong, skip it
    const [row] = await db.all(
      "INSERT INTO media (species, arm_id, kind, page, viewport, mime, size, width, height, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id",
      [species, armId, it.kind, it.page, it.viewport, it.mime, Math.round((b64.length * 3) / 4), it.width ?? null, it.height ?? null, Date.now()],
    );
    for (let i = 0, seq = 0; i < b64.length; i += CHUNK, seq++) {
      await db.run("INSERT INTO media_chunk (media_id, seq, data) VALUES (?,?,?)", [row.id, seq, b64.slice(i, i + CHUNK)]);
    }
    stored++;
  }
  return stored;
}
