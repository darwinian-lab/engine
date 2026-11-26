// Engine capability: PAYMENTS. The router owns money, so mutants can neither fake revenue nor see card data.
//
//   GET  /_dw/pay/c.js       browser API (window.dwPay): offers, what this visitor owns, open(sku) → checkout
//   POST /_dw/pay/start      a visitor opened a checkout (fitness event "checkout_start"); simulated people
//                            "pay" here instead of at Paddle (segment 'sim', never real money)
//   POST /_dw/pay/webhook    Paddle notifications (signed): grants, renewals, cancellations, refunds
//   GET  /_dw/pay/thanks     after checkout: waits for the payment to land, shows the purchase code, continues
//   GET  /_dw/pay/status     {paid, code} for this visitor and sku
//   GET|POST /_dw/pay/restore  unlock a purchase in another browser with its purchase code
//
// Arms learn what a visitor owns from the x-dw-paid header (set here, stripped from client requests), and whether
// checkout is live from x-dw-pay. Offers (sku, name, price) are declared in the species' protected species.json;
// Paddle price ids live in the router secret PADDLE_PRICES ({"sku": "pri_..."}), written by scripts/paddle-setup.mjs.

import type { Env } from "./index";
import type { Offer, SpeciesConfig } from "./config";

export interface PayEnv {
  PADDLE_CLIENT_TOKEN?: string; // public client-side token (test_... or live_...)
  PADDLE_ENV?: string; // "sandbox" | "production"
  PADDLE_PRICES?: string; // JSON {sku: priceId}
  PADDLE_WEBHOOK_SECRET?: string; // endpoint secret of this domain's notification destination
}

export interface PayVisitor {
  visitor: string | null;
  arm: string | null;
  segment: string;
  sim: boolean;
  owner: boolean;
}

type LogFn = (env: Env, e: { arm: string; visitor: string; segment: string; name: string; path?: string; value?: number; props?: unknown }) => Promise<void>;

const SIGNATURE_TOLERANCE_S = 300; // replays are harmless anyway: every notification is processed once (pay_events)
const PAID_COOKIE = "dw_paid";
const YEAR_S = 60 * 60 * 24 * 365;

export function priceIds(env: PayEnv): Record<string, string> {
  try {
    const v = JSON.parse(env.PADDLE_PRICES ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Checkout is live for this species when Paddle is configured and every declared offer has a price. */
export function payReady(env: PayEnv, cfg: SpeciesConfig | null): boolean {
  const offers = cfg?.offers ?? [];
  const ids = priceIds(env);
  return Boolean(env.PADDLE_CLIENT_TOKEN) && offers.length > 0 && offers.every((o) => ids[o.sku]);
}

export async function paidSkus(env: Env, visitor: string): Promise<string[]> {
  // Never break page loads over this (e.g. before the payments migration has run).
  const rows = await env.DB.prepare(
    "SELECT DISTINCT sku FROM entitlements WHERE species = ? AND visitor = ? AND status IN ('active','sim','test')",
  )
    .bind(env.SPECIES, visitor)
    .all<{ sku: string }>()
    .catch(() => ({ results: [] as { sku: string }[] }));
  return rows.results.map((r) => r.sku);
}

/** Should the router look up entitlements for this request? Only for visitors who have ever paid (cookie hint). */
export function mayHavePaid(cookies: Record<string, string>, sim: boolean): boolean {
  return sim || cookies[PAID_COOKIE] === "1";
}

function code(): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  const s = Array.from(b, (x) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

const json = (v: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store", ...extra } });
const paidCookie = `${PAID_COOKIE}=1; Path=/; Max-Age=${YEAR_S}; Secure; HttpOnly; SameSite=Lax`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/_dw/") ? n : "/");

export function priceLabel(o: Offer): string {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: o.currency || "USD" }).format(o.price);
  return o.interval ? `${amount} per ${o.interval}` : `${amount} once`;
}

// ---------------------------------------------------------------------------------------------------------------
// Signature verification (Paddle-Signature: ts=<unix>;h1=<hex hmac-sha256 of "ts:body">)
// ---------------------------------------------------------------------------------------------------------------

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyPaddle(secret: string, header: string | null, body: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret || !header) return false;
  let ts = "";
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "ts") ts = (v ?? "").trim();
    if (k?.trim() === "h1" && v) h1.push(v.trim());
  }
  if (!/^\d+$/.test(ts) || Math.abs(nowS - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  const want = await hmacHex(secret, `${ts}:${body}`);
  return h1.some((h) => sameHex(h, want));
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------------------------

interface PaddleEvent {
  event_id?: string;
  event_type?: string;
  data?: Record<string, any>;
}

async function armOf(env: Env, visitor: string): Promise<{ arm_id: string; segment: string } | null> {
  return env.DB.prepare(
    "SELECT arm_id, segment FROM events WHERE species = ? AND visitor = ? AND segment != 'sim' ORDER BY ts DESC LIMIT 1",
  )
    .bind(env.SPECIES, visitor)
    .first<{ arm_id: string; segment: string }>();
}

export async function handleWebhook(req: Request, env: Env & PayEnv, cfg: SpeciesConfig | null, logEvent: LogFn): Promise<Response> {
  const body = await req.text();
  if (!(await verifyPaddle(env.PADDLE_WEBHOOK_SECRET ?? "", req.headers.get("paddle-signature"), body))) return new Response("bad signature", { status: 401 });
  let ev: PaddleEvent;
  try {
    ev = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const d = ev.data ?? {};
  const custom = (d.custom_data ?? {}) as Record<string, string>;
  const test = env.PADDLE_ENV === "sandbox";
  const provider = test ? "paddle-sandbox" : "paddle";

  // Which species does this belong to? Every domain's destination receives every event; each router keeps its own.
  let mine = custom.dw_species === env.SPECIES;
  const subId: string | null = d.subscription_id ?? (ev.event_type?.startsWith("subscription.") ? d.id : null) ?? null;
  if (!mine && !custom.dw_species && (subId || d.transaction_id)) {
    const known = await env.DB.prepare("SELECT 1 AS x FROM entitlements WHERE species = ? AND (subscription_id = ? OR txn_id = ?) LIMIT 1")
      .bind(env.SPECIES, subId ?? "", d.transaction_id ?? "")
      .first();
    mine = Boolean(known);
  }
  if (!mine) return new Response("not this species", { status: 200 });

  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO pay_events (species, event_id, ts, type, json) VALUES (?,?,?,?,?)")
    .bind(env.SPECIES, ev.event_id ?? `${ev.event_type}:${d.id}`, Date.now(), ev.event_type ?? "", body.slice(0, 4000))
    .run();
  if (!fresh.meta.changes) return new Response("duplicate", { status: 200 });

  const now = Date.now();
  if (ev.event_type === "transaction.completed") {
    const ids = priceIds(env);
    const priceId: string | undefined = d.items?.[0]?.price?.id ?? d.items?.[0]?.price_id;
    let sku = custom.dw_sku ?? Object.keys(ids).find((k) => ids[k] === priceId) ?? null;
    let visitor: string | null = custom.dw_vid ?? null;
    if ((!sku || !visitor) && subId) {
      // A renewal: carry the original buyer's sku and visitor.
      const first = await env.DB.prepare("SELECT sku, visitor FROM entitlements WHERE species = ? AND subscription_id = ? ORDER BY ts ASC LIMIT 1")
        .bind(env.SPECIES, subId)
        .first<{ sku: string; visitor: string }>();
      sku = sku ?? first?.sku ?? null;
      visitor = visitor ?? first?.visitor ?? null;
    }
    if (!sku || !visitor) return new Response("unattributed", { status: 200 });
    const amount = Number(d.details?.totals?.grand_total ?? 0) / 100;
    const currency = String(d.currency_code ?? "USD");
    const where = await armOf(env, visitor);
    const renewal = Boolean(subId && (await env.DB.prepare("SELECT 1 AS x FROM entitlements WHERE species = ? AND subscription_id = ? LIMIT 1").bind(env.SPECIES, subId).first()));
    if (!renewal) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO entitlements (species, visitor, sku, status, provider, txn_id, subscription_id, customer_id, code, amount, currency, arm_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(env.SPECIES, visitor, sku, test ? "test" : "active", provider, d.id ?? "", subId, d.customer_id ?? null, code(), amount, currency, where?.arm_id ?? null, now)
        .run();
    }
    if (where && !test) {
      await logEvent(env, { arm: where.arm_id, visitor, segment: where.segment, name: "purchase", value: amount, props: { sku, currency, renewal } });
    } else if (where) {
      await logEvent(env, { arm: where.arm_id, visitor, segment: where.segment, name: "c:test_purchase", value: amount, props: { sku } });
    }
    return new Response("ok");
  }
  if (ev.event_type === "subscription.canceled" && subId) {
    await env.DB.prepare("UPDATE entitlements SET status = 'canceled' WHERE species = ? AND subscription_id = ?").bind(env.SPECIES, subId).run();
    return new Response("ok");
  }
  if ((ev.event_type === "adjustment.created" || ev.event_type === "adjustment.updated") && d.action === "refund" && d.status === "approved" && d.transaction_id) {
    const row = await env.DB.prepare("SELECT visitor, arm_id, amount FROM entitlements WHERE species = ? AND txn_id = ? LIMIT 1")
      .bind(env.SPECIES, d.transaction_id)
      .first<{ visitor: string; arm_id: string | null; amount: number }>();
    await env.DB.prepare("UPDATE entitlements SET status = 'refunded' WHERE species = ? AND txn_id = ?").bind(env.SPECIES, d.transaction_id).run();
    const refunded = Number(d.totals?.total ?? 0) / 100 || row?.amount || 0;
    const where = row ? await armOf(env, row.visitor) : null;
    if (row && where && !test) await logEvent(env, { arm: where.arm_id, visitor: row.visitor, segment: where.segment, name: "refund", value: refunded, props: { txn: d.transaction_id } });
    return new Response("ok");
  }
  return new Response("ignored", { status: 200 });
}

// ---------------------------------------------------------------------------------------------------------------
// Browser API
// ---------------------------------------------------------------------------------------------------------------

export function clientConfig(env: PayEnv, cfg: SpeciesConfig | null, v: PayVisitor, paid: string[]) {
  const ids = priceIds(env);
  const offers: Record<string, { name: string; price: number; currency: string; interval: string | null; label: string; priceId: string | null }> = {};
  for (const o of cfg?.offers ?? []) {
    offers[o.sku] = { name: o.name, price: o.price, currency: o.currency || "USD", interval: o.interval ?? null, label: priceLabel(o), priceId: ids[o.sku] ?? null };
  }
  return {
    species: cfg?.species ?? "",
    ready: v.sim || payReady(env, cfg), // simulated people always see a (simulated) working checkout
    sim: v.sim,
    env: env.PADDLE_ENV === "sandbox" ? "sandbox" : "production",
    token: v.sim ? null : env.PADDLE_CLIENT_TOKEN ?? null,
    vid: v.visitor,
    offers,
    paid,
  };
}

// Plain ES5 so it runs everywhere. Never runs anything on its own: checkout opens only from dwPay.open() on a click.
const CLIENT_JS = `(function(C){
  function start(sku,extra){var b=JSON.stringify(Object.assign({sku:sku},extra||{}));
    return fetch('/_dw/pay/start',{method:'POST',headers:{'content-type':'application/json'},body:b,credentials:'same-origin'}).then(function(r){return r.ok?r.json():{};}).catch(function(){return {};});}
  function thanks(sku,next){return location.origin+'/_dw/pay/thanks?sku='+encodeURIComponent(sku)+'&next='+encodeURIComponent(next);}
  var paddle=null;
  function loadPaddle(){if(paddle)return paddle;paddle=new Promise(function(ok,fail){var s=document.createElement('script');s.src='https://cdn.paddle.com/paddle/v2/paddle.js';
    s.onload=function(){try{if(C.env==='sandbox')Paddle.Environment.set('sandbox');Paddle.Initialize({token:C.token});ok(window.Paddle);}catch(e){fail(e);}};
    s.onerror=function(){paddle=null;fail(new Error('Checkout could not load. Check your connection and try again.'));};document.head.appendChild(s);});return paddle;}
  function simCheckout(sku,o,next){return new Promise(function(done){
    var prev=document.activeElement,w=document.createElement('div');w.setAttribute('role','dialog');w.setAttribute('aria-modal','true');w.setAttribute('aria-labelledby','dwpay-t');
    w.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;font:16px/1.45 system-ui,sans-serif';
    w.innerHTML='<div style="background:#fff;color:#111;max-width:420px;width:100%;border-radius:12px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3)">'+
      '<h2 id="dwpay-t" style="margin:0 0 8px;font-size:20px">Checkout (test mode)</h2>'+
      '<p style="margin:0 0 6px"><b></b></p><p style="margin:0 0 14px">Price: <b></b></p>'+
      '<p style="margin:0 0 16px;color:#555;font-size:14px">This is a simulated checkout for testing. Nothing is charged. In real life a secure payment form would open here.</p>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" data-ok style="min-height:44px;padding:0 18px;border-radius:8px;border:0;background:#111;color:#fff;font:inherit;cursor:pointer"></button>'+
      '<button type="button" data-no style="min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #999;background:#fff;color:#111;font:inherit;cursor:pointer">Cancel</button></div></div>';
    var bs=w.querySelectorAll('b');bs[0].textContent=o.name;bs[1].textContent=o.label;w.querySelector('[data-ok]').textContent='Pay '+o.label+' (simulated)';
    function close(r){w.remove();if(prev&&prev.focus)prev.focus();done(r);}
    w.querySelector('[data-no]').onclick=function(){close({cancelled:true});};
    w.addEventListener('keydown',function(e){if(e.key==='Escape')close({cancelled:true});});
    w.querySelector('[data-ok]').onclick=function(){this.disabled=true;start(sku,{simConfirm:true}).then(function(){location.href=thanks(sku,next);});};
    document.body.appendChild(w);w.querySelector('[data-ok]').focus();});}
  window.dwPay={ready:C.ready,offers:C.offers,paid:C.paid.slice(),
    has:function(sku){return C.paid.indexOf(sku)>=0;},
    restoreUrl:'/_dw/pay/restore',
    open:function(sku,opts){opts=opts||{};var o=C.offers[sku];if(!o)return Promise.reject(new Error('Unknown offer: '+sku));
      var next=opts.next||(location.pathname+location.search);
      if(C.sim){start(sku);return simCheckout(sku,o,next);}
      if(!C.ready||!o.priceId){return Promise.reject(new Error('Payments are not available yet.'));}
      start(sku);
      return loadPaddle().then(function(P){P.Checkout.open({items:[{priceId:o.priceId,quantity:1}],
        customData:{dw_vid:C.vid||'',dw_sku:sku,dw_species:C.species},customer:opts.email?{email:opts.email}:undefined,
        settings:{displayMode:'overlay',successUrl:thanks(sku,next)}});return {opened:true};});}};
  try{document.dispatchEvent(new Event('dwpay:ready'));}catch(e){}
})`;

export function clientJs(config: ReturnType<typeof clientConfig>): string {
  return `${CLIENT_JS}(${JSON.stringify(config).replace(/</g, "\\u003c")});`;
}

// ---------------------------------------------------------------------------------------------------------------
// Pages (router-rendered, minimal)
// ---------------------------------------------------------------------------------------------------------------

function pageHtml(cfg: SpeciesConfig | null, title: string, body: string): Response {
  const brand = esc(cfg?.brand.name ?? "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | ${brand}</title>` +
      `<style>body{font:17px/1.5 system-ui,sans-serif;color:#111;background:#fafaf7;margin:0;padding:24px}main{max-width:480px;margin:8vh auto;background:#fff;border:1px solid #e5e5e0;border-radius:14px;padding:24px}` +
      `h1{font-size:24px;margin:0 0 12px}.code{font:600 22px ui-monospace,monospace;letter-spacing:.06em;background:#f2f2ec;border-radius:8px;padding:10px 14px;display:inline-block;margin:6px 0}` +
      `a.btn,button{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:8px;border:0;background:#111;color:#fff;font:inherit;text-decoration:none;cursor:pointer}` +
      `input{font:inherit;min-height:44px;padding:0 12px;border:1px solid #999;border-radius:8px;width:100%;box-sizing:border-box;margin:6px 0 12px}.muted{color:#555;font-size:15px}</style></head>` +
      `<body><main>${body}<p class="muted" style="margin-top:20px"><a href="/">${brand}</a></p></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } },
  );
}

async function latestEntitlement(env: Env, visitor: string, sku: string) {
  return env.DB.prepare("SELECT code, status FROM entitlements WHERE species = ? AND visitor = ? AND sku = ? AND status IN ('active','sim','test') ORDER BY ts DESC LIMIT 1")
    .bind(env.SPECIES, visitor, sku)
    .first<{ code: string; status: string }>();
}

export async function handlePay(req: Request, env: Env & PayEnv, cfg: SpeciesConfig | null, v: PayVisitor, logEvent: LogFn, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/_dw/pay/webhook" && req.method === "POST") return handleWebhook(req, env, cfg, logEvent);

  if (p === "/_dw/pay/c.js") {
    const paid = v.visitor ? await paidSkus(env, v.visitor) : [];
    return new Response(clientJs(clientConfig(env, cfg, v, paid)), {
      headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "private, no-store" },
    });
  }

  if (p === "/_dw/pay/start" && req.method === "POST") {
    let body: { sku?: string; simConfirm?: boolean; unavailable?: boolean } = {};
    try {
      body = JSON.parse((await req.text()).slice(0, 1000));
    } catch {
      /* ignore */
    }
    const offer = (cfg?.offers ?? []).find((o) => o.sku === body.sku);
    if (!offer || !v.visitor || !v.arm) return json({ ok: false }, 400);
    const segment = v.sim ? "sim" : v.segment;
    if (v.sim && body.simConfirm) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO entitlements (species, visitor, sku, status, provider, txn_id, code, amount, currency, arm_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(env.SPECIES, v.visitor, offer.sku, "sim", "sim", `sim-${code()}`, code(), offer.price, offer.currency || "USD", v.arm, Date.now())
        .run();
      await logEvent(env, { arm: v.arm, visitor: v.visitor, segment, name: "purchase", value: 0, props: { sku: offer.sku, simulated: true } });
      return json({ ok: true }, 200, { "set-cookie": paidCookie });
    }
    if (!v.owner) waitUntil(logEvent(env, { arm: v.arm, visitor: v.visitor, segment, name: "checkout_start", path: url.pathname, props: { sku: offer.sku } }));
    return json({ ok: true });
  }

  if (p === "/_dw/pay/status") {
    const sku = url.searchParams.get("sku") ?? "";
    const row = v.visitor ? await latestEntitlement(env, v.visitor, sku) : null;
    return json({ paid: Boolean(row), code: row?.code ?? null }, 200, row ? { "set-cookie": paidCookie } : {});
  }

  if (p === "/_dw/pay/thanks") {
    const sku = url.searchParams.get("sku") ?? "";
    const offer = (cfg?.offers ?? []).find((o) => o.sku === sku);
    const next = safeNext(url.searchParams.get("next"));
    const res = pageHtml(
      cfg,
      "Thank you",
      `<h1>Thank you!</h1><div id="s" role="status" aria-live="polite"><p>Confirming your payment${offer ? ` for <b>${esc(offer.name)}</b>` : ""}… this usually takes a few seconds.</p></div>` +
        `<p><a class="btn" id="go" href="${esc(next)}">Continue</a></p>` +
        `<script>(function(){var n=0,s=document.getElementById('s');function poll(){fetch('/_dw/pay/status?sku=${encodeURIComponent(sku)}',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(j){` +
        `if(j.paid){s.innerHTML='<p>Payment received. You now have <b>${esc(offer?.name ?? "your purchase")}</b> in this browser.</p><p>Your purchase code (keep it to unlock on another device or browser):</p><div class="code"></div><p class="muted">Use it at <a href="/_dw/pay/restore">${esc(cfg?.brand.domain ?? "")}/_dw/pay/restore</a>. Your receipt comes by email from Paddle, our payment provider, who also handles cancellations and refunds.</p>';s.querySelector('.code').textContent=j.code;return;}` +
        `if(++n<40)setTimeout(poll,1500);else s.innerHTML='<p>Your payment is still being confirmed. Paddle has emailed your receipt; refresh this page in a minute. If it does not unlock, reply to the receipt email.</p>';}).catch(function(){if(++n<40)setTimeout(poll,1500);});}poll();})();</script>`,
    );
    return res;
  }

  if (p === "/_dw/pay/restore") {
    let msg = "";
    if (req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const entered = String(form?.get("code") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const formatted = entered.length === 10 ? `${entered.slice(0, 5)}-${entered.slice(5)}` : "";
      const row = formatted
        ? await env.DB.prepare("SELECT * FROM entitlements WHERE species = ? AND code = ? AND status IN ('active','sim','test') LIMIT 1").bind(env.SPECIES, formatted).first<Record<string, any>>()
        : null;
      if (row && v.visitor) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO entitlements (species, visitor, sku, status, provider, txn_id, subscription_id, customer_id, code, amount, currency, arm_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(env.SPECIES, v.visitor, row.sku, row.status, row.provider, row.txn_id, row.subscription_id, row.customer_id, row.code, 0, row.currency, row.arm_id, Date.now())
          .run();
        const offer = (cfg?.offers ?? []).find((o) => o.sku === row.sku);
        const res = pageHtml(cfg, "Unlocked", `<h1>Unlocked</h1><p><b>${esc(offer?.name ?? row.sku)}</b> is now active in this browser.</p><p><a class="btn" href="/">Continue</a></p>`);
        res.headers.append("set-cookie", paidCookie);
        return res;
      }
      msg = `<p role="alert" style="color:#a00">That code didn't match a purchase. Check it and try again.</p>`;
    }
    return pageHtml(
      cfg,
      "Unlock a purchase",
      `<h1>Unlock your purchase</h1><p>Bought on another device or browser? Enter the purchase code shown after payment.</p>${msg}` +
        `<form method="post"><label for="code">Purchase code</label><input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="ABCDE-FGHJK" required><button type="submit">Unlock</button></form>` +
        `<p class="muted">Lost the code? Reply to your Paddle receipt email and we will help.</p>`,
    );
  }

  return new Response("Not found", { status: 404 });
}
