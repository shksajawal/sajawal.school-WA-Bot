import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { config } from "./config.js";

try {
  const u = new URL(config.databaseUrl);
  if (!u.protocol.startsWith("postgres")) throw new Error(`unexpected protocol "${u.protocol}"`);
  console.log(`DATABASE_URL ok → host ${u.hostname}:${u.port || 5432}`);
} catch (err) {
  throw new Error(
    `DATABASE_URL is not a valid postgres URL (length ${config.databaseUrl.length}). ` +
      `It must start with postgresql:// — check for stray characters. (${err})`,
  );
}

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// "handoff" is legacy (retired 2026-08-25) — kept so old rows read cleanly until the boot migration drains them.
export type ContactStatus = "active" | "payment_pending" | "payment_review" | "purchased" | "handoff";

export interface Contact {
  id: number;
  wa_id: string;
  name: string | null;
  ctwa_clid: string | null;
  ctwa_source_id: string | null;
  source: string;
  status: ContactStatus;
  qualified: boolean;
  followup_count: number;
  last_user_msg_at: Date | null;
  drip_step: number;
  email: string | null;
}

export interface StoredMessage {
  id: number;
  contact_id: number;
  direction: "in" | "out";
  msg_type: string;
  body: string | null;
}

export async function initDb(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // schema.sql lives at the repo root, one level above src/ (or dist/)
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  await pool.query(schema);
}

export async function upsertContact(opts: {
  waId: string;
  name?: string | null;
  ctwaClid?: string | null;
  ctwaSourceId?: string | null;
  source?: string;
}): Promise<Contact> {
  const res = await pool.query<Contact>(
    `INSERT INTO contacts (wa_id, name, ctwa_clid, ctwa_source_id, source)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'organic'))
     ON CONFLICT (wa_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, contacts.name),
       ctwa_clid = COALESCE(contacts.ctwa_clid, EXCLUDED.ctwa_clid),
       ctwa_source_id = COALESCE(contacts.ctwa_source_id, EXCLUDED.ctwa_source_id),
       source = CASE WHEN contacts.source = 'organic' AND $5 IS NOT NULL THEN $5 ELSE contacts.source END
     RETURNING *`,
    [opts.waId, opts.name ?? null, opts.ctwaClid ?? null, opts.ctwaSourceId ?? null, opts.source ?? null],
  );
  return res.rows[0];
}

export async function getContact(id: number): Promise<Contact | null> {
  const res = await pool.query<Contact>(`SELECT * FROM contacts WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function updateContact(
  id: number,
  fields: Partial<Pick<Contact, "status" | "qualified" | "followup_count" | "last_user_msg_at" | "name" | "drip_step" | "email">>,
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`UPDATE contacts SET ${sets} WHERE id = $1`, [id, ...Object.values(fields)]);
}

/** Returns the inserted row id, or null if this wa_message_id was already processed. */
export async function insertMessage(opts: {
  contactId: number;
  waMessageId?: string | null;
  direction: "in" | "out";
  msgType?: string;
  body?: string | null;
}): Promise<number | null> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO messages (contact_id, wa_message_id, direction, msg_type, body)
     VALUES ($1, $2, $3, COALESCE($4, 'text'), $5)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [opts.contactId, opts.waMessageId ?? null, opts.direction, opts.msgType ?? null, opts.body ?? null],
  );
  return res.rows[0]?.id ?? null;
}

export async function getRecentMessages(contactId: number, limit = 24): Promise<StoredMessage[]> {
  const res = await pool.query<StoredMessage>(
    `SELECT * FROM (
       SELECT id, contact_id, direction, msg_type, body
       FROM messages WHERE contact_id = $1 ORDER BY id DESC LIMIT $2
     ) sub ORDER BY id ASC`,
    [contactId, limit],
  );
  return res.rows;
}

export async function latestInboundMessageId(contactId: number): Promise<number | null> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM messages WHERE contact_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`,
    [contactId],
  );
  return res.rows[0]?.id ?? null;
}

export async function verifiedReferenceExists(reference: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM payments WHERE reference = $1 AND verified LIMIT 1`,
    [reference],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function insertPayment(opts: {
  contactId: number;
  waMediaId?: string | null;
  amount?: number | null;
  reference?: string | null;
  verified: boolean;
  detail?: unknown;
  screenshot?: Buffer | null;
  screenshotMime?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO payments (contact_id, wa_media_id, amount, reference, verified, detail, screenshot, screenshot_mime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.contactId,
      opts.waMediaId ?? null,
      opts.amount ?? null,
      opts.reference ?? null,
      opts.verified,
      JSON.stringify(opts.detail ?? {}),
      opts.screenshot ?? null,
      opts.screenshotMime ?? null,
    ],
  );
}

export async function recordCapiEvent(opts: {
  contactId: number;
  eventName: string;
  eventId: string;
  success: boolean;
  response?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO capi_events (contact_id, event_name, event_id, success, response)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.contactId, opts.eventName, opts.eventId, opts.success, JSON.stringify(opts.response ?? {})],
  );
}

export async function capiEventExists(eventId: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM capi_events WHERE event_id = $1 AND success LIMIT 1`, [eventId]);
  return (res.rowCount ?? 0) > 0;
}

// ── Team interface queries (read-only by design) ─────────────

export interface SaleRow {
  payment_id: number;
  amount: string | null;
  reference: string | null;
  paid_at: Date;
  name: string | null;
  wa_id: string;
  email: string | null;
  from_ad: boolean;
  has_screenshot: boolean;
}

export async function recentSales(days = 7): Promise<SaleRow[]> {
  const res = await pool.query(
    `SELECT p.id AS payment_id, p.amount::text AS amount, p.reference, p.created_at AS paid_at,
            c.name, c.wa_id, c.email, (c.ctwa_clid IS NOT NULL) AS from_ad,
            (p.screenshot IS NOT NULL) AS has_screenshot
     FROM payments p JOIN contacts c ON c.id = p.contact_id
     WHERE p.verified AND p.created_at > now() - make_interval(days => $1)
     ORDER BY p.created_at DESC LIMIT 20`,
    [days],
  );
  return res.rows;
}

export async function paymentScreenshot(paymentId: number): Promise<{ bytes: Buffer; mime: string } | null> {
  const res = await pool.query(`SELECT screenshot, screenshot_mime FROM payments WHERE id = $1`, [paymentId]);
  const row = res.rows[0];
  if (!row?.screenshot) return null;
  return { bytes: row.screenshot, mime: row.screenshot_mime ?? "image/jpeg" };
}

export interface ActionItem {
  kind: string;
  name: string | null;
  wa_id: string;
  note: string;
  at: Date | null;
}

export async function opsActionItems(): Promise<ActionItem[]> {
  const res = await pool.query(
    `SELECT 'payment_review' AS kind, c.name, c.wa_id,
            'Payment review pending' AS note,
            (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id) AS at
     FROM contacts c WHERE c.status = 'payment_review'
     UNION ALL
     SELECT 'stalled_checkout', c.name, c.wa_id,
            'Got bank details, no screenshot yet',
            (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id)
     FROM contacts c
     WHERE c.status = 'payment_pending'
       AND (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id) < now() - interval '2 hours'
     UNION ALL
     SELECT 'hot_lead_silent', c.name, c.wa_id,
            'Qualified lead, silent 6+ hours',
            (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id)
     FROM contacts c
     WHERE c.status = 'active' AND c.qualified
       AND (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id) < now() - interval '6 hours'
     ORDER BY at DESC NULLS LAST LIMIT 25`,
  );
  return res.rows;
}

export interface FunnelSummary {
  contacts: number;
  from_ads: number;
  qualified: number;
  payment_pending: number;
  purchases: number;
  revenue: string | null;
  sales_today: number;
  revenue_today: string | null;
}

export async function funnelSummary(): Promise<FunnelSummary> {
  const res = await pool.query(
    `SELECT (SELECT count(*)::int FROM contacts) AS contacts,
            (SELECT count(*)::int FROM contacts WHERE ctwa_clid IS NOT NULL) AS from_ads,
            (SELECT count(*)::int FROM contacts WHERE qualified) AS qualified,
            (SELECT count(*)::int FROM contacts WHERE status = 'payment_pending') AS payment_pending,
            (SELECT count(*)::int FROM payments WHERE verified) AS purchases,
            (SELECT sum(amount)::text FROM payments WHERE verified) AS revenue,
            (SELECT count(*)::int FROM payments WHERE verified
              AND created_at > (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi')) AS sales_today,
            (SELECT sum(amount)::text FROM payments WHERE verified
              AND created_at > (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi')) AS revenue_today`,
  );
  return res.rows[0];
}

export async function insertSupportQuery(contactId: number, summary: string): Promise<void> {
  await pool.query(`INSERT INTO support_queue (contact_id, summary) VALUES ($1, $2)`, [contactId, summary]);
}

export interface SupportQueryRow {
  name: string | null;
  wa_id: string;
  summary: string;
  created_at: Date;
}

export async function openSupportQueries(): Promise<SupportQueryRow[]> {
  const res = await pool.query(
    `SELECT c.name, c.wa_id, q.summary, q.created_at
     FROM support_queue q JOIN contacts c ON c.id = q.contact_id
     WHERE q.created_at > now() - interval '48 hours'
     ORDER BY q.created_at DESC LIMIT 20`,
  );
  return res.rows;
}

export async function contactByWaId(waId: string): Promise<Contact | null> {
  const res = await pool.query(`SELECT * FROM contacts WHERE wa_id = $1`, [waId]);
  return res.rows[0] ?? null;
}

export async function getState(key: string): Promise<string | null> {
  const res = await pool.query(`SELECT value FROM bot_state WHERE key = $1`, [key]);
  return res.rows[0]?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** Verified sales since a timestamp — the "what's new" half of the team brief. */
export async function salesSince(since: Date): Promise<SaleRow[]> {
  const res = await pool.query(
    `SELECT p.id AS payment_id, p.amount::text AS amount, p.reference, p.created_at AS paid_at,
            c.name, c.wa_id, c.email, (c.ctwa_clid IS NOT NULL) AS from_ad,
            (p.screenshot IS NOT NULL) AS has_screenshot
     FROM payments p JOIN contacts c ON c.id = p.contact_id
     WHERE p.verified AND p.created_at > $1 ORDER BY p.created_at`,
    [since],
  );
  return res.rows;
}

export async function supportQueriesSince(since: Date): Promise<SupportQueryRow[]> {
  const res = await pool.query(
    `SELECT c.name, c.wa_id, q.summary, q.created_at
     FROM support_queue q JOIN contacts c ON c.id = q.contact_id
     WHERE q.created_at > $1 ORDER BY q.created_at`,
    [since],
  );
  return res.rows;
}

/** Per-million-token USD pricing. Cache reads are 0.1x input; writes 1.25x. */
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
};

export async function recordUsage(opts: {
  kind: "chat" | "vision";
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null;
}): Promise<void> {
  const u = opts.usage;
  if (!u) return;
  try {
    await pool.query(
      `INSERT INTO api_usage (kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        opts.kind,
        opts.model,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      ],
    );
  } catch (err) {
    // Never let bookkeeping break a conversation
    console.error("recordUsage failed:", err);
  }
}

export interface UsageDay {
  day: string;
  calls: number;
  usd: number;
}

/** Cost per PKT day for the last N days, computed from the token ledger. */
export async function usageByDay(days = 7): Promise<UsageDay[]> {
  const res = await pool.query(
    `SELECT to_char(created_at AT TIME ZONE 'Asia/Karachi','YYYY-MM-DD') AS day,
            model, count(*)::int AS calls,
            sum(input_tokens)::bigint AS inp, sum(output_tokens)::bigint AS outp,
            sum(cache_read_tokens)::bigint AS cread, sum(cache_write_tokens)::bigint AS cwrite
     FROM api_usage WHERE created_at > now() - make_interval(days => $1)
     GROUP BY 1, 2 ORDER BY 1 DESC`,
    [days],
  );
  const byDay = new Map<string, UsageDay>();
  for (const r of res.rows) {
    const p = MODEL_PRICING[r.model] ?? { in: 3, out: 15 };
    const usd =
      (Number(r.inp) * p.in +
        Number(r.cread) * p.in * 0.1 +
        Number(r.cwrite) * p.in * 1.25 +
        Number(r.outp) * p.out) /
      1_000_000;
    const cur = byDay.get(r.day) ?? { day: r.day, calls: 0, usd: 0 };
    cur.calls += r.calls;
    cur.usd += usd;
    byDay.set(r.day, cur);
  }
  return [...byDay.values()];
}

/** One-row stats pack for the 11pm PKT daily report (today vs yesterday, PKT days). */
export interface OpsDailyStats {
  leads_t: number; leads_y: number;
  paystage_t: number; paystage_y: number;
  sales_t: number; sales_y: number;
  rev_t: string | null; rev_y: string | null;
  core_t: number; adv_t: number;
  capi_ok: number; capi_fail: number;
}
export async function opsDailyStats(): Promise<OpsDailyStats> {
  const res = await pool.query(
    `WITH b AS (
       SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') AS t0,
              (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') - interval '1 day' AS y0
     )
     SELECT
       (SELECT count(*)::int FROM contacts, b WHERE created_at >= b.t0) AS leads_t,
       (SELECT count(*)::int FROM contacts, b WHERE created_at >= b.y0 AND created_at < b.t0) AS leads_y,
       (SELECT count(*)::int FROM contacts, b WHERE created_at >= b.t0 AND status IN ('payment_pending','payment_review','purchased')) AS paystage_t,
       (SELECT count(*)::int FROM contacts, b WHERE created_at >= b.y0 AND created_at < b.t0 AND status IN ('payment_pending','payment_review','purchased')) AS paystage_y,
       (SELECT count(*)::int FROM payments, b WHERE verified AND created_at >= b.t0) AS sales_t,
       (SELECT count(*)::int FROM payments, b WHERE verified AND created_at >= b.y0 AND created_at < b.t0) AS sales_y,
       (SELECT sum(amount)::text FROM payments, b WHERE verified AND created_at >= b.t0) AS rev_t,
       (SELECT sum(amount)::text FROM payments, b WHERE verified AND created_at >= b.y0 AND created_at < b.t0) AS rev_y,
       (SELECT count(*)::int FROM payments, b WHERE verified AND created_at >= b.t0 AND amount < 8000) AS core_t,
       (SELECT count(*)::int FROM payments, b WHERE verified AND created_at >= b.t0 AND amount >= 8000) AS adv_t,
       (SELECT count(*)::int FROM capi_events, b WHERE created_at >= b.t0 AND success) AS capi_ok,
       (SELECT count(*)::int FROM capi_events, b WHERE created_at >= b.t0 AND NOT success) AS capi_fail`,
  );
  return res.rows[0];
}

/** Generic range stats for on-demand "week" / "all" ops commands. */
export async function opsRangeStats(days: number): Promise<{
  leads: number; paystage: number; sales: number; revenue: string | null;
}> {
  const res = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM contacts WHERE created_at > now() - ($1 || ' days')::interval) AS leads,
       (SELECT count(*)::int FROM contacts WHERE created_at > now() - ($1 || ' days')::interval
          AND status IN ('payment_pending','payment_review','purchased')) AS paystage,
       (SELECT count(*)::int FROM payments WHERE verified AND created_at > now() - ($1 || ' days')::interval) AS sales,
       (SELECT sum(amount)::text FROM payments WHERE verified AND created_at > now() - ($1 || ' days')::interval) AS revenue`,
    [days],
  );
  return res.rows[0];
}

/**
 * Sample of today's WON (purchased) and LOST (went quiet after a bot reply)
 * conversations for the nightly learning pass. Bodies truncated hard so the
 * whole sample stays small.
 */
export async function learningSamples(): Promise<Array<{ label: string; convo: string }>> {
  const pick = async (where: string, limit: number, label: string) => {
    const res = await pool.query(
      `SELECT c.id FROM contacts c
       WHERE c.created_at > now() - interval '24 hours' AND ${where}
       ORDER BY c.created_at DESC LIMIT ${limit}`,
    );
    const out: Array<{ label: string; convo: string }> = [];
    for (const row of res.rows) {
      const msgs = await pool.query(
        `SELECT direction, body FROM messages
         WHERE contact_id = $1 AND body IS NOT NULL
         ORDER BY created_at DESC LIMIT 12`,
        [row.id],
      );
      const lines = msgs.rows
        .reverse()
        .map((m: { direction: string; body: string }) => `${m.direction === "in" ? "Lead" : "Salman"}: ${String(m.body).slice(0, 180)}`);
      if (lines.length >= 3) out.push({ label, convo: lines.join("\n") });
    }
    return out;
  };
  const won = await pick(`c.status = 'purchased'`, 4, "WON");
  const lost = await pick(
    `c.status = 'active' AND (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id) < now() - interval '3 hours'`,
    8,
    "LOST",
  );
  return [...won, ...lost];
}
