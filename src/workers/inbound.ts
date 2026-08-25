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
import { downloadMedia, markReadWithTyping, sendText } from "../whatsapp.js";
import { sendCapiEvent } from "../capi.js";
import { verifyPaymentScreenshot } from "../payments.js";
import { handleOpsMessage, isOpsNumber, pingTeam } from "../ops.js";
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
        return;
      }
    }

    await enqueueReply({ contactId: contact.id, afterMessageId: dbMsgId });
  } else if (m.type === "reaction" || m.type === "sticker") {
    // A 👍 or sticker is a gesture, not a question. Replying "file type not
    // supported" to it is the loudest AI-tell we have — stay silent.
  } else {
    await sendBotText(
      contact,
      "Yeh file type abhi support nahi hoti — please apna sawal text mein likhein, ya payment ki soorat mein screenshot (image) bhejein. 🙂",
    );
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
const DRIP_LINES: Record<number, string> = {
  0: "Wslam! 🙂 Are you a complete beginner, or do you already have some experience with digital marketing?",
  1: "Great. If you are starting from zero there is no issue at all. I will guide you in the right direction first.\n\nJust tell me one thing. How much time can you give daily. 1 hour. 2 hours. Or more than that?",
  2: "Perfect. Every single person who is earning online today started without knowing anything as well.\n\nThe mistake most people make is they spend months learning random stuff and then wonder why no money is coming in.\n\nWhat usually works better is learning one skill first and then learning how to actually get clients for it. Because knowing something and getting paid for it are two different things.\n\nThat's exactly why we built the program. Everything is in one place so you don't have to figure out what to learn next.\n\nIf you want the details, just reply with the word \"details\" and I'll share everything with you. No pressure.",
};

async function runDrip(contact: Contact, body: string): Promise<boolean> {
  if (contact.drip_step < 0 || contact.drip_step > 2) return false;
  const text = body.trim();
  // Real engagement exits the script: questions, long messages, or anything
  // about price/payment goes straight to Claude with full history.
  const exits =
    text.includes("?") ||
    text.length > 70 ||
    /price|fee|fees|rate|charge|kitn|paise|pais|rupee|rs\b|discount|payment|pay\b|refund/i.test(text);
  if (exits && !(contact.drip_step === 0 && /can i get more info|interested/i.test(text))) {
    await updateContact(contact.id, { drip_step: -1 });
    contact.drip_step = -1;
    return false;
  }
  const line = DRIP_LINES[contact.drip_step];
  const next = contact.drip_step + 1;
  await updateContact(contact.id, { drip_step: next > 2 ? -1 : next });
  contact.drip_step = next > 2 ? -1 : next;
  await sendBotText(contact, line);
  return true;
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
