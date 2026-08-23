/**
 * Replay CAPI events that Meta never received.
 *
 * Every event so far failed on a permissions error, so the dataset has nothing.
 * New conversations recover on their own (the idempotency guard filters on
 * `AND success`, so failures retry), but people who already bought will never
 * trigger another Purchase. Those have to be replayed by hand.
 *
 * Reuses the original event_id and event_time, so this stays idempotent with
 * the running app and preserves attribution timing.
 *
 *   node scripts/backfill-capi.mjs           dry run — shows what would be sent
 *   node scripts/backfill-capi.mjs --send    actually send
 *
 * Fix the token FIRST — verify with: npm run verify:capi
 */
import "dotenv/config";
import { createHash } from "crypto";
import pg from "pg";

const clean = (v) => {
  if (!v) return undefined;
  const s = v.trim().replace(/^["']+|["']+$/g, "").trim();
  return s === "" ? undefined : s;
};

const GRAPH = clean(process.env.GRAPH_VERSION) ?? "v23.0";
const DATASET = clean(process.env.META_DATASET_ID);
const TOKEN = clean(process.env.META_CAPI_ACCESS_TOKEN) ?? clean(process.env.WA_ACCESS_TOKEN);
const WABA = clean(process.env.WA_WABA_ID);
const PAGE_ID = clean(process.env.META_PAGE_ID);
const TEST_CODE = clean(process.env.META_TEST_EVENT_CODE);
const SEND = process.argv.includes("--send");
const SEVEN_DAYS = 7 * 24 * 60 * 60;

const sha256 = (v) => createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

if (!DATASET || !TOKEN) {
  console.error("Missing META_DATASET_ID or a Meta token in .env");
  process.exit(1);
}
if (!clean(process.env.META_CAPI_ACCESS_TOKEN)) {
  console.warn("\n\x1b[33mWARNING\x1b[0m  META_CAPI_ACCESS_TOKEN is not set — using WA_ACCESS_TOKEN.");
  console.warn("         That is the fallback that caused the original failures. Run npm run verify:capi first.\n");
}

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
await db.connect();

// Failed events with no later successful row for the same event_id.
const { rows } = await db.query(`
  SELECT DISTINCT ON (e.event_id)
         e.id, e.event_id, e.event_name, e.contact_id,
         e.created_at,
         extract(epoch FROM e.created_at)::bigint AS event_time,
         c.wa_id, c.ctwa_clid,
         p.amount AS payment_amount
  FROM capi_events e
  JOIN contacts c ON c.id = e.contact_id
  LEFT JOIN payments p
    ON p.contact_id = e.contact_id AND p.verified
   AND e.event_id LIKE 'purchase:%' || p.reference
  WHERE e.success = false
    AND NOT EXISTS (
      SELECT 1 FROM capi_events s WHERE s.event_id = e.event_id AND s.success
    )
  ORDER BY e.event_id, e.id DESC
`);

if (!rows.length) {
  console.log("\nNothing to backfill — every event already has a successful delivery.\n");
  await db.end();
  process.exit(0);
}

const nowSec = Math.floor(Date.now() / 1000);
console.log(`\n${SEND ? "SENDING" : "DRY RUN"} — ${rows.length} event(s) to replay\n`);

let sent = 0, failed = 0, skipped = 0;

for (const r of rows) {
  const ageSec = nowSec - Number(r.event_time);
  const label = `${r.event_name.padEnd(17)} contact ${String(r.contact_id).padEnd(4)} ${r.event_id}`;

  if (ageSec > SEVEN_DAYS) {
    console.log(`  SKIP  ${label} — older than Meta's 7-day window`);
    skipped++;
    continue;
  }

  if (!r.ctwa_clid) {
    console.log(`  SKIP  ${label} — organic contact, Meta requires ctwa_clid on business_messaging events`);
    skipped++;
    continue;
  }

  // Purchase value comes from the verified payment; InitiateCheckout falls back
  // to the same amount when that contact went on to pay.
  let value;
  if (r.event_name === "Purchase" || r.event_name === "InitiateCheckout") {
    if (r.payment_amount != null) value = Number(r.payment_amount);
  }
  if (r.event_name === "Purchase" && value == null) {
    const p = await db.query(
      `SELECT amount FROM payments WHERE contact_id=$1 AND verified ORDER BY id DESC LIMIT 1`,
      [r.contact_id],
    );
    if (p.rows[0]?.amount != null) value = Number(p.rows[0].amount);
  }

  const payload = {
    data: [{
      event_name: r.event_name,
      event_time: Number(r.event_time),
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      event_id: r.event_id,
      user_data: {
        ...(WABA ? { whatsapp_business_account_id: WABA } : {}),
        ...(PAGE_ID ? { page_id: PAGE_ID } : {}),
        ...(r.ctwa_clid ? { ctwa_clid: r.ctwa_clid } : {}),
        ph: [sha256(r.wa_id)],
      },
      ...(value != null ? { custom_data: { value, currency: "PKR" } } : {}),
    }],
    ...(TEST_CODE ? { test_event_code: TEST_CODE } : {}),
  };

  const detail = `${label}${value != null ? `  Rs ${value}` : ""}${r.ctwa_clid ? "  [ctwa]" : ""}`;

  if (!SEND) {
    console.log(`  WOULD  ${detail}`);
    continue;
  }

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH}/${DATASET}/events?access_token=${encodeURIComponent(TOKEN)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
  );
  const json = await res.json().catch(() => ({}));

  await db.query(
    `INSERT INTO capi_events (contact_id, event_name, event_id, success, response)
     VALUES ($1,$2,$3,$4,$5)`,
    [r.contact_id, r.event_name, r.event_id, res.ok, JSON.stringify(json)],
  );

  if (res.ok) {
    console.log(`  \x1b[32mSENT\x1b[0m   ${detail}`);
    sent++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m   ${detail}\n         ${json?.error?.message ?? JSON.stringify(json)}`);
    failed++;
  }
}

console.log(
  SEND
    ? `\nDone — ${sent} sent, ${failed} failed, ${skipped} skipped.\n`
    : `\nDry run only. Re-run with --send once npm run verify:capi passes.\n`,
);

await db.end();
