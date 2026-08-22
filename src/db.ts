import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export type ContactStatus = "active" | "payment_pending" | "handoff" | "purchased";

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
  fields: Partial<Pick<Contact, "status" | "qualified" | "followup_count" | "last_user_msg_at" | "name">>,
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

export async function getRecentMessages(contactId: number, limit = 40): Promise<StoredMessage[]> {
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
}): Promise<void> {
  await pool.query(
    `INSERT INTO payments (contact_id, wa_media_id, amount, reference, verified, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      opts.contactId,
      opts.waMediaId ?? null,
      opts.amount ?? null,
      opts.reference ?? null,
      opts.verified,
      JSON.stringify(opts.detail ?? {}),
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
