import { Worker } from "bullmq";
import { config } from "../config.js";
import { connection, scheduleFollowup, type FollowupJob } from "../queue.js";
import { getContact, getRecentMessages, insertMessage } from "../db.js";
import { sendTemplate, sendText } from "../whatsapp.js";
import { generateReply } from "../agent/agent.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Follow-up strategy:
 * - Inside the 24h customer-service window → a contextual, Claude-written nudge
 *   that references the actual conversation (free-form messages are allowed).
 * - Outside 24h → the pre-approved template (Meta requires templates there).
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
      if (contact.status === "purchased" || contact.status === "handoff") return;
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
      } else {
        // Outside the window → approved template only
        const waMsgId = await sendTemplate(
          contact.wa_id,
          config.followup.templateName,
          config.followup.templateLanguage,
        );
        await insertMessage({
          contactId,
          waMessageId: waMsgId,
          direction: "out",
          msgType: "template",
          body: `[template:${config.followup.templateName}]`,
        });
      }

      // Chain the next touch (24h later), still keyed to the same silence
      if (touch < config.followup.maxTouches) {
        await scheduleFollowup({ contactId, touch: touch + 1, lastUserMsgAt }, DAY_MS);
      }
    },
    { connection, concurrency: 4 },
  );
}
