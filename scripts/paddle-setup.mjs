#!/usr/bin/env node
// One-shot (idempotent) Paddle setup for every species, so the owner only has to create an account and an API key.
//
//   PADDLE_API_KEY=pdl_live_apikey_... (or pdl_sdbx_apikey_... for the sandbox) node scripts/paddle-setup.mjs [--dry]
//
// For every offer declared in a species' species.json it finds or creates a Paddle product + price, creates (or
// reuses) a client-side token and one webhook destination per domain, then writes the router secrets
// PADDLE_CLIENT_TOKEN, PADDLE_ENV, PADDLE_PRICES and PADDLE_WEBHOOK_SECRET with wrangler. Run it again whenever
// offers change. Needs: PADDLE_API_KEY, CLOUDFLARE_API_TOKEN/ACCOUNT_ID (for wrangler), and species.json files
// (from $DW_WORKDIR/<repo> checkouts, or fetched with gh + DW_GH_TOKEN).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ENGINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const settings = JSON.parse(fs.readFileSync(path.join(ENGINE, "evolve/settings.json"), "utf8"));
const KEY = process.env.PADDLE_API_KEY ?? "";
const DRY = process.argv.includes("--dry");
if (!KEY) throw new Error("PADDLE_API_KEY is missing (Paddle dashboard → Developer tools → Authentication → API keys).");
const SANDBOX = KEY.includes("_sdbx_");
const API = SANDBOX ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
const EVENTS = ["transaction.completed", "subscription.canceled", "adjustment.created", "adjustment.updated"];

async function paddle(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Paddle ${method} ${p} → ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 400)}`);
  return j;
}
async function listAll(p) {
  const out = [];
  let next = `${p}${p.includes("?") ? "&" : "?"}per_page=200`;
  while (next) {
    const j = await paddle("GET", next);
    out.push(...(j.data ?? []));
    const n = j.meta?.pagination?.next;
    next = j.meta?.pagination?.has_more && n ? n.replace(API, "") : null;
  }
  return out;
}

function speciesJson(sp) {
  const local = path.join(process.env.DW_WORKDIR ?? path.join(ENGINE, ".."), sp.repo, "species.json");
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, "utf8"));
  const r = spawnSync("gh", ["api", `repos/${settings.github.org}/${sp.repo}/contents/species.json`, "-H", "Accept: application/vnd.github.raw"], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: process.env.DW_GH_TOKEN ?? process.env.GH_TOKEN ?? "" },
  });
  if (r.status !== 0) throw new Error(`could not read ${sp.repo}/species.json: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function putSecret(envName, name, value) {
  if (DRY) return console.log(`  (dry) would set ${name} on dw-router-${envName}`);
  const r = spawnSync("npx", ["wrangler", "secret", "put", name, "--env", envName], { cwd: path.join(ENGINE, "router"), input: value, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`wrangler secret put ${name} --env ${envName} failed: ${r.stderr || r.stdout}`);
  console.log(`  set ${name} on dw-router-${envName}`);
}

const products = await listAll("/products?status=active&include=prices");
const tokenName = "darwinian-checkout";
let clientToken = process.env.PADDLE_CLIENT_TOKEN ?? "";
if (!clientToken) {
  try {
    const existing = (await listAll("/client-tokens?status=active")).find((t) => t.name === tokenName);
    clientToken = existing?.token ?? (DRY ? "(dry)" : (await paddle("POST", "/client-tokens", { name: tokenName, description: "Paddle.js on the species domains" })).data.token);
  } catch (e) {
    throw new Error(`Could not create a client-side token (${e.message}). Give the API key the client_token.write permission, or create one in Developer tools → Authentication and pass it as PADDLE_CLIENT_TOKEN.`);
  }
}
const destinations = await listAll("/notification-settings");

for (const sp of settings.species) {
  const species = speciesJson(sp);
  const offers = species.offers ?? [];
  console.log(`\n${sp.id} (${sp.domain}): ${offers.length} offer(s)`);
  if (!offers.length) continue;
  const prices = {};
  for (const o of offers) {
    const amount = String(Math.round(o.price * 100));
    const currency = o.currency ?? "USD";
    let product = products.find((p) => p.custom_data?.dw_species === sp.id && p.custom_data?.dw_sku === o.sku);
    if (!product) {
      product = DRY
        ? { id: "(dry)", prices: [] }
        : (await paddle("POST", "/products", { name: o.name, tax_category: "saas", description: o.describe ?? o.name, custom_data: { dw_species: sp.id, dw_sku: o.sku } })).data;
      console.log(`  created product ${o.name}`);
    }
    const match = (product.prices ?? []).find(
      (pr) => pr.status === "active" && pr.unit_price?.amount === amount && pr.unit_price?.currency_code === currency && (pr.billing_cycle?.interval ?? null) === (o.interval ?? null),
    );
    let price = match;
    if (!price) {
      price = DRY
        ? { id: "(dry)" }
        : (
            await paddle("POST", "/prices", {
              product_id: product.id,
              description: `${o.sku} ${amount} ${currency}${o.interval ? "/" + o.interval : ""}`,
              name: o.interval ? `${o.name} (per ${o.interval})` : o.name,
              unit_price: { amount, currency_code: currency },
              billing_cycle: o.interval ? { interval: o.interval, frequency: 1 } : null,
              quantity: { minimum: 1, maximum: 1 },
              custom_data: { dw_species: sp.id, dw_sku: o.sku },
            })
          ).data;
      console.log(`  created price ${o.sku}: ${o.price} ${currency}${o.interval ? " per " + o.interval : " once"}`);
    }
    prices[o.sku] = price.id;
  }
  const url = `https://${sp.domain}/_dw/pay/webhook`;
  let dest = destinations.find((d) => d.destination === url && d.active);
  if (!dest) {
    dest = DRY
      ? { endpoint_secret_key: "(dry)" }
      : (await paddle("POST", "/notification-settings", { description: `Darwinian router ${sp.id}`, type: "url", destination: url, subscribed_events: EVENTS, api_version: 1 })).data;
    console.log(`  created webhook destination ${url}`);
  }
  putSecret(sp.id, "PADDLE_CLIENT_TOKEN", clientToken);
  putSecret(sp.id, "PADDLE_ENV", SANDBOX ? "sandbox" : "production");
  putSecret(sp.id, "PADDLE_PRICES", JSON.stringify(prices));
  putSecret(sp.id, "PADDLE_WEBHOOK_SECRET", dest.endpoint_secret_key);
}

console.log(`\nDone (${SANDBOX ? "SANDBOX: test payments only, no revenue counted" : "LIVE"}).`);
console.log("Paddle only opens checkout on approved websites: Paddle dashboard → Checkout → Website approval → add");
for (const sp of settings.species) console.log(`  https://${sp.domain}`);
console.log("and set one of them as the default payment link (Checkout → Checkout settings).");
