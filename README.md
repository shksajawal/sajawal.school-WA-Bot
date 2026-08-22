# Sajawal.School WhatsApp Sales Bot

AI sales agent for click-to-WhatsApp (CTWA) conversion campaigns. Handles the full funnel in-chat: qualification → objection handling → payment (bank transfer + screenshot verification) → Meta Conversions API events so Ads Manager can optimize on real purchases.

## Architecture

```
Meta webhook ──► Fastify server ──► BullMQ (Redis) ──► workers:
                                        │
                    inbound: store msg, capture ctwa_clid, route
                    reply:   Claude sales agent → WhatsApp reply
                    followup: contextual nudge (<24h) / template (>24h)
                                        │
                              Postgres (contacts, messages, payments, capi_events)
                                        │
                              Meta CAPI  (LeadSubmitted / QualifiedLead /
                                          InitiateCheckout / Purchase,
                                          action_source: business_messaging)
```

## The event ladder (why this exists)

| Event | Fired when | Purpose |
|---|---|---|
| `LeadSubmitted` | First message arrives with a `ctwa_clid` | Seeds the dataset so the event dropdown appears in Ads Manager |
| `QualifiedLead` | Bot's rubric says real buying intent | Early optimization signal before purchase volume exists |
| `InitiateCheckout` | Bank details sent | Funnel diagnostics |
| `Purchase` (+ value) | Screenshot verified | The real optimization target for the Sales campaign |

## Setup

1. **Install**: `npm install`
2. **Provision**: Postgres + Redis (Railway gives you both). Schema auto-applies on boot.
3. **Configure**: `cp .env.example .env` and fill everything in. The WhatsApp values come from the Meta developer app (see the setup checklist you already have).
4. **Fill the knowledge base**: edit `src/agent/knowledge.md` — every `TODO` in that file directly costs conversions. This is the highest-leverage file in the repo.
5. **Bank details**: set `BANK_DETAILS` in `.env` — the bot only ever sends payment details from there.
6. **OCR adapter**: point `OCR_VERIFY_URL` at your website's screenshot-verification service, or adjust the request shape in `src/payments.ts` → `ocrServiceCheck()` to match its actual contract. If unset, Claude vision verifies alone.
7. **Run**: `npm run dev` (local) or deploy to Railway and set `npm start`.
8. **Webhook**: in the Meta app → WhatsApp → Configuration, set the callback URL to `https://<your-domain>/webhook`, the verify token to your `WA_WEBHOOK_VERIFY_TOKEN`, and subscribe to the `messages` field.

## Testing before spending ad money

- Set `META_TEST_EVENT_CODE` (Events Manager → Test events) — CAPI events show up live there. **Remove it in production.**
- Message the bot from a personal number and run the full flow: questions → objections → "kaise pay karun" → send a real screenshot → confirm the Purchase event lands in Events Manager with `business_messaging` as the action source.
- Try to break it: ask for discounts, income guarantees, tell it to ignore its instructions, send a doctored screenshot. It should refuse, stay on-script, and flag suspicious payments to a human.

## Website leads (abandoned signups)

Your website backend calls:

```
POST /leads
Authorization: Bearer <LEADS_API_KEY>
{ "phone": "9230xxxxxxxx", "name": "Ali" }
```

This sends the approved opener template; when the person replies, the bot takes over with website-lead context. Requires the `website_lead_opener` template to be approved in WhatsApp Manager first.

## Human handoff

When the bot escalates (anger, refunds, disputed/suspicious payments, explicit request), the contact's status becomes `handoff`, the bot goes silent for that thread, and `OPS_ALERT_NUMBER` gets a WhatsApp ping. To hand back to the bot: `UPDATE contacts SET status = 'active' WHERE wa_id = '...';` (a proper inbox — e.g. Chatwoot — can be wired in later).

## Templates to create in WhatsApp Manager (before launch)

| Template | Used for |
|---|---|
| `course_followup` | Re-engaging non-buyers after the 24h window closes |
| `website_lead_opener` | First outreach to website signups who didn't pay |

## Operational notes

- **Debounce**: replies wait 6s so people who send 4 short messages get one coherent answer.
- **Dedupe**: webhook retries are dropped on `wa_message_id`; CAPI events are idempotent on `event_id`; a verified transaction reference can only be claimed once.
- **Cost**: the system prompt is cached (1h TTL) — at volume, most input tokens are 90% discounted. Switch `CLAUDE_MODEL` if you want to trade quality for cost later.
- **Scale**: BullMQ concurrency handles 10k msgs/day easily; raise worker `concurrency` numbers if queues back up.
