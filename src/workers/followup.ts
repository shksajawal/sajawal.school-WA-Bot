import { Worker } from "bullmq";
import { config } from "../config.js";
import { connection, scheduleFollowup, type FollowupJob } from "../queue.js";
import fs from "node:fs";
import {
  type Contact,
  getContact,
  getRecentMessages,
  getState,
  insertMessage,
  insertSupportQuery,
  setState,
} from "../db.js";
import { sendImage, sendText, uploadMedia } from "../whatsapp.js";
import { sendCapiEvent } from "../capi.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Owner's final-touch message (2026-08-29): the "Present Day vs After One Day"
// brain image with the Last Reminder caption. The uploaded media id is cached
// in bot_state and refreshed before WhatsApp's ~30 day media expiry. If the
// image file is missing, the caption still goes out as plain text.
const LAST_REMINDER_CAPTION =
  "Last Reminder \u{1F604} Join krne se phle koi bhe sawal ho to ap mere se puch skte hen.";
const REMINDER_IMAGE_PATH = "assets/followup-last-reminder.jpg";
const REMINDER_MEDIA_STATE_KEY = "followup_reminder_media";

async function sendLastReminder(contact: Contact): Promise<void> {
  let mediaId: string | null = null;
  try {
    const cached = await getState(REMINDER_MEDIA_STATE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { id?: string; at?: string };
      if (parsed.id && parsed.at && Date.now() - new Date(parsed.at).getTime() < 25 * DAY_MS) {
        mediaId = parsed.id;
      }
    }
    if (!mediaId && fs.existsSync(REMINDER_IMAGE_PATH)) {
      const buffer = fs.readFileSync(REMINDER_IMAGE_PATH);
      mediaId = await uploadMedia(buffer, "image/jpeg");
      await setState(
        REMINDER_MEDIA_STATE_KEY,
        JSON.stringify({ id: mediaId, at: new Date().toISOString() }),
      );
    }
  } catch (err) {
    console.error("Last-reminder image unavailable, sending text only:", err);
  }
  const waMsgId = mediaId
    ? await sendImage(contact.wa_id, mediaId, LAST_REMINDER_CAPTION)
    : await sendText(contact.wa_id, LAST_REMINDER_CAPTION);
  await insertMessage({
    contactId: contact.id,
    waMessageId: waMsgId,
    direction: "out",
    body: LAST_REMINDER_CAPTION,
  });
}

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
        // Still inside the free-form window (with a 30min safety margin).
        // Owner-approved fixed scripts (2026-08-29), zero model cost:
        //   touch 1, pre-payment:      decision-help one-liner
        //   touch 1, payment_pending:  the human team's proven fee check-in
        //   touch 2 (final, ~20h):     "Last Reminder" image + caption
        const isFinalTouch = touch >= config.followup.maxTouches;
        // A lead who took the payment details and went quiet is Meta's exact
        // definition of an abandoned cart. Idempotent per contact; organic
        // contacts (no ctwa_clid) are skipped inside sendCapiEvent.
        if (contact.status === "payment_pending") {
          await sendCapiEvent(contact, "CartAbandoned");
        }
        if (isFinalTouch) {
          await sendLastReminder(contact);
        } else {
          const nudge =
            contact.status === "payment_pending"
              ? "Thought to check \u{1F603} Did you get the chance to send the fee, or did something come up?"
              : "Anything I can answer for you to make the right decision?";
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
