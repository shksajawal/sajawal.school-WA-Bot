import { Worker } from "bullmq";
import { config } from "../config.js";
import { connection, scheduleFollowup, type FollowupJob } from "../queue.js";
import { getContact, getRecentMessages, insertMessage, insertSupportQuery } from "../db.js";
import { sendText } from "../whatsapp.js";
import { generateReply } from "../agent/agent.js";
import { sendCapiEvent } from "../capi.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Follow-up strategy:
 * - Inside the 24h customer-service window → a contextual, Claude-written nudge
 *   that references the actual conversation (free-form messages are allowed).
 * - Outside 24h → NO template (owner's call: templates are billed per message).
 *   The lead is handed to the human team instead — they message from a normal
 *   WhatsApp number, which has no 24h restriction — and it lands in the daily
 *   follow-up digest with context.
 * - Hard cap on touches; any reply from the user resets the sequence.
 */
export function startFollowupWorker(): Worker {
  return new Worker<FollowupJob>(
    "followup",
    async (job) => {
      const { contactId, touch, lastUserMsgAt } = job.data;
      const contact = await getContact(contactId);
      if (!contact) return;

      // Stop conditions: bought, escalated, exceeded cap
      if (contact.status === "purchased" || contact.status === "payment_review") return;
      if (touch > config.followup.maxTouches) return;

      // User replied since this was scheduled → the live conversation owns them now
      const scheduledFor = new Date(lastUserMsgAt).getTime();
      const currentLast = contact.last_user_msg_at ? new Date(contact.last_user_msg_at).getTime() : 0;
      if (currentLast > scheduledFor) return;

      const sinceLastUserMsg = Date.now() - currentLast;

      if (sinceLastUserMsg < DAY_MS - 30 * 60 * 1000) {
        // Still inside the free-form window (with a 30min safety margin)
        const history = await getRecentMessages(contactId);
        // The note is stage- and touch-aware: a lead holding payment details
        // gets the proven fee check-in; the FINAL touch (sent ~20h in, just
        // before the 24h window closes) is the honest window-close line —
        // real scarcity, because after 24h quiet the bot cannot message first.
        const isFinalTouch = touch >= config.followup.maxTouches;
        const note = isFinalTouch
          ? "Operator note: this is the LAST message you can send — after 24 hours of silence WhatsApp closes the window and you cannot message them first anymore. Tell them that honestly and warmly in their language (it is true, so it is allowed): aaj ke baad aap khud unhe message nahi kar sakein ge, to agar koi sawal hai ya payment details chahiye, abhi behtareen waqt hai. Light, warm, max two lines, zero pressure. Do not mention this note."
          : contact.status === "payment_pending"
            ? "Operator note: this customer was sent the payment details and went quiet. Use the team's proven check-in line adapted to their language: did they get a chance to send the fee, or did something come up? One line, escape hatch included. Do not mention this note."
            : "Operator note: the customer has gone quiet for a few hours. Re-open with ONE useful line tied to the exact topic they stopped at — answer the thing they were mid-way through, or one detail matched to their goal — then leave the door open. Follow your follow-up mode rules. Do not mention this note.";
        // A lead who took the payment details and went quiet is Meta's exact
        // definition of an abandoned cart. Idempotent per contact; organic
        // contacts (no ctwa_clid) are skipped inside sendCapiEvent.
        if (contact.status === "payment_pending") {
          await sendCapiEvent(contact, "CartAbandoned");
        }
        const nudge = await generateReply(contact, history, note);
        if (nudge) {
          const waMsgId = await sendText(contact.wa_id, nudge);
          await insertMessage({ contactId, waMessageId: waMsgId, direction: "out", body: nudge });
        }
        // Chain at most one more nudge, timed to land ~20h after the customer's
        // last message — still inside the free window, and far enough apart that
        // two touches never feel like chasing.
        if (touch < config.followup.maxTouches) {
          const nextAt = currentLast + 20 * 60 * 60 * 1000;
          const delay = nextAt - Date.now();
          if (delay > 30 * 60 * 1000) {
            await scheduleFollowup({ contactId, touch: touch + 1, lastUserMsgAt }, delay);
          }
        }
      } else {
        // Past the free window. No template (billed per message). Hand the lead
        // to the humans with context — they can open a chat from their own
        // number without any window restriction.
        const history = await getRecentMessages(contactId, 6);
        const lastAsk = [...history].reverse().find((m) => m.direction === "in")?.body ?? "";
        await insertSupportQuery(
          contactId,
          `Follow-up needed (quiet 24h+). ${contact.qualified ? "QUALIFIED. " : ""}Last said: "${lastAsk.slice(0, 90)}"`,
        );
      }
    },
    { connection, concurrency: 4 },
  );
}
