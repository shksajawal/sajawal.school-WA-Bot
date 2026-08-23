import { createHash } from "crypto";
import { config } from "./config.js";
import { type Contact, capiEventExists, recordCapiEvent } from "./db.js";

function sha256(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export type CapiEventName = "LeadSubmitted" | "QualifiedLead" | "InitiateCheckout" | "Purchase";

/**
 * Send a Conversions API event with action_source=business_messaging.
 * These events are what unlock (and then feed) conversion optimization
 * on click-to-WhatsApp campaigns in Ads Manager.
 *
 * Never throws — ad reporting must not break the chat flow.
 */
export async function sendCapiEvent(
  contact: Contact,
  eventName: CapiEventName,
  opts: { value?: number; currency?: string; eventId?: string } = {},
): Promise<boolean> {
  const eventId = opts.eventId ?? `${eventName.toLowerCase()}:${contact.id}`;

  // Meta hard-requires ctwa_clid on business_messaging events (subcode 2804071).
  // Organic contacts have none, so their events can never land — skip the call.
  if (!contact.ctwa_clid) return false;

  try {
    // Idempotency: one success per event_id (e.g. one QualifiedLead per contact)
    if (await capiEventExists(eventId)) return true;

    const body: any = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          event_id: eventId,
          user_data: {
            whatsapp_business_account_id: config.whatsapp.wabaId,
            ...(config.capi.pageId ? { page_id: config.capi.pageId } : {}),
            ...(contact.ctwa_clid ? { ctwa_clid: contact.ctwa_clid } : {}),
            ph: [sha256(contact.wa_id)],
          },
          ...(opts.value !== undefined
            ? { custom_data: { value: opts.value, currency: opts.currency ?? "PKR" } }
            : {}),
        },
      ],
      ...(config.capi.testEventCode ? { test_event_code: config.capi.testEventCode } : {}),
    };

    const res = await fetch(
      `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.capi.datasetId}/events?access_token=${encodeURIComponent(config.capi.accessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json: any = await res.json().catch(() => ({}));
    const success = res.ok;
    await recordCapiEvent({ contactId: contact.id, eventName, eventId, success, response: json });
    if (!success) console.error(`CAPI ${eventName} failed:`, JSON.stringify(json));
    return success;
  } catch (err) {
    console.error(`CAPI ${eventName} error:`, err);
    try {
      await recordCapiEvent({
        contactId: contact.id,
        eventName,
        eventId,
        success: false,
        response: { error: String(err) },
      });
    } catch {
      // swallow — never let event logging break the conversation
    }
    return false;
  }
}
