// Publishes screenshots, flow videos and mockups to the engine repo's orphan `media` branch (public), so PRs,
// issues and the lab can show them by plain URL. Nothing heavy goes into the database any more.
import fs from "node:fs";
import { api } from "./ghpr.mjs";

const REPO = process.env.DW_MEDIA_REPO ?? "darwinian-lab/engine";
const BRANCH = process.env.DW_MEDIA_BRANCH ?? "media";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

export const mediaUrl = (rel) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${rel}`;

/**
 * Upload one file under `rel` (e.g. "qr/g3-abcd/after-design-panel.jpg"). Uploads are serialised (each one is a
 * commit on the branch) and retried on conflicts. Returns the public URL, or null if it could not be uploaded.
 */
export function uploadMedia(rel, file) {
  const job = chain.then(async () => {
    const content = fs.readFileSync(file).toString("base64");
    if (content.length > 60_000_000) return null; // ~45 MB: something went wrong
    for (let i = 1; i <= 5; i++) {
      try {
        let sha;
        try {
          sha = (await api("GET", `repos/${REPO}/contents/${rel}?ref=${BRANCH}`, undefined, { tries: 1 })).sha;
        } catch {}
        await api("PUT", `repos/${REPO}/contents/${rel}`, { message: `media: ${rel}`, content, branch: BRANCH, ...(sha ? { sha } : {}), committer: { name: "darwinian", email: "evolve@darwinian.local" } });
        return mediaUrl(rel);
      } catch (e) {
        if (i === 5) {
          console.log(`media upload ${rel} failed: ${e.message.slice(0, 200)}`);
          return null;
        }
        await sleep(1500 * i);
      }
    }
    return null;
  });
  chain = job.catch(() => null);
  return job;
}
