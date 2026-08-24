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
import { handleOpsMessage, isOpsNumber } from "../ops.js";
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

  // First contact from an ad click → LeadSubmitted seeds the dataset immediately
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
    await enqueueReply({ contactId: contact.id, afterMessageId: dbMsgId });
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
      await sendBotText(
        contact,
        `Payment verified ✅ Welcome to Sajawal.School! 🎉\n\nAap ki enrollment confirm ho gayi hai — onboarding details aap ko shortly isi chat mein mil jayengi. Koi bhi sawal ho to yahin poochein.`,
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

async function sendBotText(contact: Contact, text: string): Promise<void> {
  const waMsgId = await sendText(contact.wa_id, text);
  await insertMessage({ contactId: contact.id, waMessageId: waMsgId, direction: "out", body: text });
}

async function alertOps(contact: Contact, note: string): Promise<void> {
  const targets = [
    ...new Set(
      [config.opsAlertNumber, config.ops.adminNumber, config.ops.supportNumber].filter(
        (n): n is string => Boolean(n),
      ),
    ),
  ];
  for (const to of targets) {
    try {
      await sendText(to, `${note}\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})`);
    } catch (err) {
      console.error("Ops alert failed:", err);
    }
  }
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
