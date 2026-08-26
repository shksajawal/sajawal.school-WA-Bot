import { Worker } from "bullmq";
import { config } from "../config.js";
import { connection, scheduleFollowup, type FollowupJob } from "../queue.js";
import { getContact, getRecentMessages, insertMessage, insertSupportQuery } from "../db.js";
import { sendText } from "../whatsapp.js";
import { generateReply } from "../agent/agent.js";

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
        const nudge = await generateReply(
          contact,
          history,
          "Operator note: the customer has gone quiet for a few hours. Write ONE short, natural follow-up message per your follow-up mode rules. Do not mention this note.",
        );
        if (nudge) {
          const waMsgId = await sendText(contact.wa_id, nudge);
          await insertMessage({ contactId, waMessageId: waMsgId, direction: "out", body: nudge });
        }
        // Chain one more nudge only while the free window is still open
        if (touch < config.followup.maxTouches) {
          await scheduleFollowup({ contactId, touch: touch + 1, lastUserMsgAt }, DAY_MS);
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
