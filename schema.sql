CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  ctwa_clid TEXT,
  ctwa_source_id TEXT,
  source TEXT NOT NULL DEFAULT 'organic',   -- ctwa | website_lead | organic
  status TEXT NOT NULL DEFAULT 'active',    -- active | payment_pending | handoff | purchased
  qualified BOOLEAN NOT NULL DEFAULT FALSE,
  followup_count INT NOT NULL DEFAULT 0,
  last_user_msg_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  contact_id INT NOT NULL REFERENCES contacts(id),
  wa_message_id TEXT UNIQUE,
  direction TEXT NOT NULL,                  -- in | out
  msg_type TEXT NOT NULL DEFAULT 'text',    -- text | image | template
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, id);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  contact_id INT NOT NULL REFERENCES contacts(id),
  wa_media_id TEXT,
  amount NUMERIC,
  reference TEXT,
  verified BOOLEAN NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A verified transaction reference can only be claimed once (blocks reused screenshots)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reference
  ON payments(reference) WHERE reference IS NOT NULL AND verified;

CREATE TABLE IF NOT EXISTS capi_events (
  id SERIAL PRIMARY KEY,
  contact_id INT NOT NULL REFERENCES contacts(id),
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Persist the payment screenshot itself: WhatsApp deletes media after ~30 days,
-- and the screenshot is the audit trail for every sale.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot BYTEA;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot_mime TEXT;

-- 'handoff' retired 2026-08-25: human support lives on a separate WhatsApp line
-- now and the bot never goes mute. Release legacy rows each boot (no-op once drained).
UPDATE contacts SET status = CASE
  WHEN EXISTS (SELECT 1 FROM payments p WHERE p.contact_id = contacts.id AND p.verified)
  THEN 'purchased' ELSE 'active' END
WHERE status = 'handoff';
