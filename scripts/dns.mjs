// Ensures the DNS records listed in ops/dns.json exist. Add-only: never edits or deletes anything.
import fs from "node:fs";
import path from "node:path";
import { ENGINE_DIR } from "../evolve/lib/config.mjs";

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN missing");
const api = async (p, init = {}) => {
  const r = await fetch("https://api.cloudflare.com/client/v4" + p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const j = await r.json();
  if (!j.success) throw new Error(`${p}: ${JSON.stringify(j.errors)}`);
  return j.result;
};
const { records } = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "ops/dns.json"), "utf8"));
for (const rec of records) {
  const [zone] = await api(`/zones?name=${rec.zone}`);
  if (!zone) throw new Error(`zone ${rec.zone} not found`);
  const existing = await api(`/zones/${zone.id}/dns_records?type=${rec.type}&name=${rec.name}&per_page=100`);
  const want = rec.content.replace(/^"|"$/g, "");
  if (existing.some((e) => e.content.replace(/^"|"$/g, "") === want)) {
    console.log(`ok      ${rec.type} ${rec.name} ${want}`);
    continue;
  }
  await api(`/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify({ type: rec.type, name: rec.name, content: rec.content, ttl: 1, comment: "darwinian" }) });
  console.log(`added   ${rec.type} ${rec.name} ${want}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=dns added::${rec.type} ${rec.name}`);
}
