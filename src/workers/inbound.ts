import { Worker } from "bullmq";
import { config } from "../config.js";
import {
  connection,
  enqueueReply,
  scheduleFollowup,
  type InboundJob,
  type ReplyJob,
} from "../queue.js";
import {
  getContact,
  getRecentMessages,
  insertMessage,
  insertPayment,
  latestInboundMessageId,
  updateContact,
  upsertContact,
  verifiedReferenceExists,
  type Contact,
} from "../db.js";
import { downloadMedia, markReadWithTyping, sendText, uploadMedia } from "../whatsapp.js";
import { sendCapiEvent } from "../capi.js";
import { verifyPaymentScreenshot } from "../payments.js";
import { handleOpsMessage, isOpsNumber, pingTeam, pingTeamAudio } from "../ops.js";
import { matchFaq } from "../faq.js";
import { generateReply } from "../agent/agent.js";

interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  referral?: {
    source_url?: string;
    source_type?: string;
    source_id?: string;
    headline?: string;
    ctwa_clid?: string;
  };
}

interface WebhookValue {
  contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
  messages?: WebhookMessage[];
  statuses?: unknown[];
}

async function handleInboundMessage(value: WebhookValue, m: WebhookMessage): Promise<void> {
  // Team numbers get the read-only ops interface — never the sales agent.
  if (isOpsNumber(m.from)) {
    if (m.type === "text" && m.text?.body) await handleOpsMessage(m.from, m.text.body);
    return;
  }

  const profileName = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;

  const contact = await upsertContact({
    waId: m.from,
    name: profileName,
    ctwaClid: m.referral?.ctwa_clid ?? null,
    ctwaSourceId: m.referral?.source_id ?? null,
    source: m.referral?.ctwa_clid ? "ctwa" : undefined,
  });

  const body =
    m.type === "text"
      ? m.text?.body ?? ""
      : m.type === "image"
        ? `[image]${m.image?.caption ? ` ${m.image.caption}` : ""}`
        : `[${m.type}]`;

  // Dedupe: Meta retries webhooks; a message we've stored is already handled
  const dbMsgId = await insertMessage({
    contactId: contact.id,
    waMessageId: m.id,
    direction: "in",
    msgType: m.type,
    body,
  });
  if (dbMsgId === null) return;

  await updateContact(contact.id, { last_user_msg_at: new Date(), followup_count: 0 });
  await markReadWithTyping(m.id);

  // First message from an ad click → LeadSubmitted seeds the dataset (the
  // messaging channel's own event name — see the note in capi.ts)
  if (m.referral?.ctwa_clid) {
    await sendCapiEvent(contact, "LeadSubmitted", { eventId: `leadsubmitted:${contact.id}` });
  }

  // Handoff-mute retired 2026-08-25: support lives on its own WhatsApp line and
  // the bot never goes silent. Payment disputes park in payment_review, where
  // the agent still replies but leaves the disputed payment to the team.

  if (m.type === "image" && m.image) {
    await handlePaymentScreenshot(contact, m.image.id, m.image.mime_type);
    return;
  }

  if (m.type === "text") {
    // Buyers send their email for the Skool invite — capture it directly,
    // no model call needed, and confirm so they know it registered.
    const emailMatch =
      (contact.status === "purchased" || contact.status === "payment_review") && !contact.email
        ? (m.text?.body ?? "").match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/)
        : null;
    if (emailMatch) {
      await updateContact(contact.id, { email: emailMatch[0].toLowerCase() });
      await pingTeam(`📧 Buyer email received — ${contact.name ?? "?"} (wa.me/${contact.wa_id}): ${emailMatch[0]}`);
      await sendBotText(contact, `Email mil gaya ✅ (${emailMatch[0]}) — course ka login isi pe aayega.`);
      return;
    }
    if (await runDrip(contact, m.text?.body ?? "")) return;

    // Known factual question with a fixed answer -> canned reply, no model call.
    // Skipped once a buyer is at the payment stage, where every message matters.
    if (contact.status === "active") {
      const faq = matchFaq(m.text?.body ?? "");
      if (faq) {
        await sendBotText(contact, faq.reply);
        await armFollowup(contact);
        return;
      }
    }

    await enqueueReply({ contactId: contact.id, afterMessageId: dbMsgId });
  } else if (m.type === "reaction" || m.type === "sticker") {
    // A gesture, not a question — stay silent.
  } else if (m.type === "audio") {
    // Voice notes killed ~20 conversations with the old "file type not
    // supported" line. The customer gets NO robot reply; the note is forwarded
    // to the team, who answer the customer directly from the support number.
    try {
      const audioId = (m as any).audio?.id;
      if (audioId) {
        const { buffer, mimeType } = await downloadMedia(audioId);
        const forwardId = await uploadMedia(buffer, mimeType);
        await pingTeam(
          `\u{1F3A4} Voice note from ${contact.name ?? "?"} (wa.me/${contact.wa_id}) \u2014 bot stays silent on voice notes. Please listen (forwarded next) and reply to the customer from the support number.`,
        );
        await pingTeamAudio(forwardId);
      }
    } catch (err) {
      console.error("Voice note forward failed:", err);
      await pingTeam(`\u{1F3A4} Voice note from wa.me/${contact.wa_id} could not be forwarded \u2014 please check the chat.`);
    }
  } else {
    // Other media (video, documents, locations): no robot line — flag for a human.
    await pingTeam(`\u{1F4CE} ${m.type} received from ${contact.name ?? "?"} (wa.me/${contact.wa_id}) \u2014 bot cannot read it; reply from the support number if it needs an answer.`);
  }
}

async function handlePaymentScreenshot(contact: Contact, mediaId: string, mimeType: string): Promise<void> {
  try {
    const { buffer, mimeType: actualMime } = await downloadMedia(mediaId);
    const check = await verifyPaymentScreenshot(buffer, actualMime || mimeType);

    if (check.verified && check.reference && (await verifiedReferenceExists(check.reference))) {
      await insertPayment({
        contactId: contact.id,
        waMediaId: mediaId,
        amount: check.amount,
        reference: check.reference,
        verified: false,
        detail: { ...check, rejected: "duplicate_reference" },
        screenshot: buffer,
        screenshotMime: actualMime || mimeType,
      });
      await updateContact(contact.id, { status: "payment_review" });
      await sendBotText(
        contact,
        "Is transaction reference ke against pehle se aik payment record hai. Team member abhi check kar ke aap se raabta karega. 🙏",
      );
      await alertOps(contact, `Duplicate payment reference submitted: ${check.reference}`);
      return;
    }

    await insertPayment({
      contactId: contact.id,
      waMediaId: mediaId,
      amount: check.amount,
      reference: check.reference,
      verified: check.verified,
      detail: check,
      screenshot: buffer,
      screenshotMime: actualMime || mimeType,
    });

    if (check.verified && check.amount) {
      await updateContact(contact.id, { status: "purchased" });
      contact.status = "purchased";
      await sendCapiEvent(contact, "Purchase", {
        value: check.amount,
        eventId: `purchase:${contact.id}:${check.reference ?? mediaId}`,
      });
      // Post-purchase: the thank-you page carries the onboarding instructions.
      // Organic buyers get amount+eid so the WEB pixel/gtag Purchase fires when
      // they open it (partial ad attribution via same-browser cookies). Ad-click
      // buyers already reported Purchase via messaging CAPI — their link carries
      // no params, so the page's guards keep it a pure instructions visit
      // (no double-count).
      const eid = `purchase:${contact.id}:${check.reference ?? mediaId}`;
      const thankYouUrl = contact.ctwa_clid
        ? "https://www.sajawal.school/thank-you"
        : `https://www.sajawal.school/thank-you?amount=${check.amount}&eid=${encodeURIComponent(eid)}`;
      await sendBotText(
        contact,
        `Payment verified ✅ Welcome to Sajawal.School! 🎉\n\nAap ki enrollment confirm ho gayi hai. Agla qadam yahan hai — access aur classroom ki poori instructions is page pe hain:\n${thankYouUrl}\n\nAur apna email address yahan bhej dein — course ka login isi pe aayega.`,
      );
      await alertOps(contact, `✅ Purchase verified: Rs ${check.amount} (ref ${check.reference ?? "n/a"})`);
    } else if (check.suspicious) {
      await updateContact(contact.id, { status: "payment_review" });
      await sendBotText(
        contact,
        "Shukriya! Aap ki payment team verify kar rahi hai, thori der mein confirm kar dete hain. 🙏",
      );
      await alertOps(contact, `⚠️ Suspicious payment screenshot flagged: ${check.reason}`);
    } else if (check.needsHuman) {
      // Amount + reference clean but recipient not visible on the receipt —
      // a human confirms instead of auto-approving or bouncing the buyer.
      await updateContact(contact.id, { status: "payment_review" });
      await sendBotText(
        contact,
        "Shukriya! Screenshot mil gaya hai, team abhi verify kar ke confirm karti hai. 🙏",
      );
      await alertOps(contact, `🔍 Payment needs manual check (recipient not visible): Rs ${check.amount ?? "?"} ref ${check.reference ?? "?"}`);
    } else {
      await sendBotText(
        contact,
        "Screenshot clearly read nahi ho raha 😕 Please poora screenshot bhejein jis mein amount aur transaction ID dono saaf nazar aayen.",
      );
    }
  } catch (err) {
    console.error("Payment screenshot handling failed:", err);
    await updateContact(contact.id, { status: "payment_review" });
    await sendBotText(
      contact,
      "Aap ka screenshot mil gaya hai — team verify kar ke jald confirm karegi. Shukriya! 🙏",
    );
    await alertOps(contact, `Payment verification errored — manual check needed: ${String(err)}`);
  }
}

/**
 * Deterministic opening drip — the human support team's proven script, mined
 * from their exported chats, played back verbatim at zero model cost. Any real
 * question (a "?" or a long message) exits to Claude permanently; the script
 * only ever advances on short low-signal replies, which is what most early
 * messages are. Claude therefore spends tokens only where a sale is actually
 * being reasoned about.
 */
// One consistent opener for cold CTWA leads. Owner's direction (2026-08-28):
// summarise the offer + both prices in relatable copy and let THEM ask the
// questions. No interrogation steps — the old 3-step script (beginner? / how
// much time daily?) was where 18% of dead conversations ended, and the answers
// were never used. After this single message Claude owns the conversation.
const OPENER =
  "Wslam! \u{1F642}\n\nAap ne bilkul sahi jagah message kia hai \u2014 yahan hum sikhate hain k digital marketing se earning kaise hoti hai: clients le kar, job, ya apna business barha kar.\n\nSirf videos nahi \u2014 paying clients tak pohanchne ka poora system, Sajawal ke live sessions, community aur support ke sath. 67,000+ students already isi se seekh rahe hain.\n\n2 plans: Core Rs 3,900 \u2022 Advance Rs 8,700\n\nFees, start, ya kuch bhi \u2014 seedha pooch lein \u{1F642}";

async function runDrip(contact: Contact, body: string): Promise<boolean> {
  // Contacts mid-way through the retired 3-step script fall through to Claude.
  if (contact.drip_step > 0) {
    await updateContact(contact.id, { drip_step: -1 });
    contact.drip_step = -1;
    return false;
  }
  if (contact.drip_step !== 0) return false;
  const text = body.trim();
  // A substantive first message (a question, anything long, anything about
  // price/payment) deserves a real answer, not a script — straight to Claude.
  const exits =
    text.includes("?") ||
    text.length > 70 ||
    /price|fee|fees|rate|charge|kitn|paise|pais|rupee|rs\b|discount|payment|pay\b|refund/i.test(text);
  await updateContact(contact.id, { drip_step: -1 });
  contact.drip_step = -1;
  if (exits && !/can i get more info|interested/i.test(text)) return false;
  await sendBotText(contact, OPENER);
  await armFollowup(contact);
  return true;
}

/**
 * Arm the gentle follow-up timer for a non-buyer. Called after scripted drip
 * and FAQ replies as well as Claude replies — a lead who goes quiet mid-script
 * used to be forgotten entirely.
 */
async function armFollowup(contact: Contact): Promise<void> {
  if (contact.status === "purchased" || contact.status === "payment_review") return;
  try {
    await scheduleFollowup(
      { contactId: contact.id, touch: 1, lastUserMsgAt: new Date().toISOString() },
      config.followup.firstDelayMs,
    );
  } catch (err) {
    console.error("Failed to arm follow-up:", err);
  }
}

async function sendBotText(contact: Contact, text: string): Promise<void> {
  const waMsgId = await sendText(contact.wa_id, text);
  await insertMessage({ contactId: contact.id, waMessageId: waMsgId, direction: "out", body: text });
}

async function alertOps(contact: Contact, note: string): Promise<void> {
  await pingTeam(`${note}\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})`);
}

export function startInboundWorker(): Worker {
  return new Worker<InboundJob>(
    "inbound",
    async (job) => {
      const value = job.data.value as WebhookValue;
      for (const m of value.messages ?? []) {
        await handleInboundMessage(value, m);
      }
      // Delivery/read statuses are ignored for now
    },
    { connection, concurrency: 8 },
  );
}

export function startReplyWorker(): Worker {
  return new Worker<ReplyJob>(
    "reply",
    async (job) => {
      const { contactId, afterMessageId } = job.data;

      // Debounce: if a newer inbound message arrived while this job waited,
      // skip — the newer message's own job will reply with full context.
      const newest = await latestInboundMessageId(contactId);
      if (newest !== null && newest > afterMessageId) return;

      const contact = await getContact(contactId);
      // payment_review still gets replies — only the disputed payment waits for the team
      if (!contact) return;

      const history = await getRecentMessages(contactId);
      const reply = await generateReply(contact, history);
      if (!reply) return;

      await sendBotText(contact, reply);

      // Every bot reply (re)arms the follow-up timer for non-buyers
      if (contact.status !== "purchased" && contact.last_user_msg_at) {
        await scheduleFollowup(
          {
            contactId: contact.id,
            touch: 1,
            lastUserMsgAt: new Date(contact.last_user_msg_at).toISOString(),
          },
          config.followup.firstDelayMs,
        );
      }
    },
    { connection, concurrency: 8 },
  );
}
