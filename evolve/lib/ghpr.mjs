// Pull requests over GitHub's REST API only. `gh pr create/ready` go through GraphQL, which failed for the engine's
// fine-grained token with opaque "Something went wrong" errors. REST works with "Pull requests: write", and every
// call retries transient server errors.

const env = () => ({ GH_TOKEN: process.env.DW_GH_TOKEN ?? process.env.GH_TOKEN ?? "" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BODY = 60000;

export async function api(method, route, body, { tries = 4 } = {}) {
  const token = env().GH_TOKEN;
  for (let i = 1; ; i++) {
    let status = 0;
    let text = "";
    try {
      const res = await fetch(`https://api.github.com/${route}`, {
        method,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "darwinian-engine", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      text = await res.text();
      if (res.ok) return text.trim() ? JSON.parse(text) : {};
    } catch (e) {
      text = String(e.message ?? e);
    }
    const transient = status === 0 || status >= 500 || /secondary rate limit/i.test(text);
    if (!transient || i >= tries) throw new Error(`GitHub ${method} ${route} -> ${status || "network error"}: ${text.trim().slice(0, 400)}`);
    await sleep(5000 * i);
  }
}

/** Open a PR (or return the open one for the same head). */
export async function openPR(repo, { base, head, title, body }) {
  try {
    const pr = await api("POST", `repos/${repo}/pulls`, { base, head, title, body: body.slice(0, MAX_BODY) });
    return { number: pr.number, url: pr.html_url };
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    const owner = repo.split("/")[0];
    const [pr] = await api("GET", `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    if (!pr) throw e;
    return { number: pr.number, url: pr.html_url };
  }
}

export const commentPR = (repo, number, body) => api("POST", `repos/${repo}/issues/${number}/comments`, { body: body.slice(0, MAX_BODY) });

export async function closePR(repo, number, comment) {
  if (comment) await commentPR(repo, number, comment).catch(() => {});
  await api("PATCH", `repos/${repo}/pulls/${number}`, { state: "closed" });
}
