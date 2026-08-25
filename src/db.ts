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
  fields: Partial<Pick<Contact, "status" | "qualified" | "followup_count" | "last_user_msg_at" | "name" | "drip_step">>,
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
  from_ad: boolean;
  has_screenshot: boolean;
}

export async function recentSales(days = 7): Promise<SaleRow[]> {
  const res = await pool.query(
    `SELECT p.id AS payment_id, p.amount::text AS amount, p.reference, p.created_at AS paid_at,
            c.name, c.wa_id, (c.ctwa_clid IS NOT NULL) AS from_ad,
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
