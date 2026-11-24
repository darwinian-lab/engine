// Minimal Cloudflare D1 client over the REST API.
export function d1(cfg, databaseId) {
  const url = `${cfg.cloudflare.apiBase ?? "https://api.cloudflare.com/client/v4"}/accounts/${cfg.cloudflare.accountId}/d1/database/${databaseId}/query`;
  async function q(sql, params = []) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.cloudflare.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) throw new Error(`D1 error: ${JSON.stringify(j.errors ?? j).slice(0, 500)}`);
    return j.result?.[0]?.results ?? [];
  }
  return {
    all: q,
    first: async (sql, params) => (await q(sql, params))[0] ?? null,
    run: async (sql, params) => {
      await q(sql, params);
    },
  };
}
