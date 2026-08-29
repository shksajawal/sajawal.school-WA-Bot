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
import { handleOpsMessage, isOpsNumber, pingSupport, pingTeam, pingTeamAudio } from "../ops.js";
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
      await pingSupport(`📧 Buyer email received — ${contact.name ?? "?"} (wa.me/${contact.wa_id}): ${emailMatch[0]}`);
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
        await pingSupport(
          `\u{1F3A4} Voice note from ${contact.name ?? "?"} (wa.me/${contact.wa_id}) \u2014 bot stays silent on voice notes. Please listen (forwarded next) and reply to the customer from the support number.`,
        );
        await pingTeamAudio(forwardId);
      }
    } catch (err) {
      console.error("Voice note forward failed:", err);
      await pingSupport(`\u{1F3A4} Voice note from wa.me/${contact.wa_id} could not be forwarded \u2014 please check the chat.`);
    }
  } else {
    // Other media (video, documents, locations): no robot line — flag for a human.
    await pingSupport(`\u{1F4CE} ${m.type} received from ${contact.name ?? "?"} (wa.me/${contact.wa_id}) \u2014 bot cannot read it; reply from the support number if it needs an answer.`);
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
      await pingTeam(
        `✅ SALE: Rs ${check.amount} (ref ${check.reference ?? "n/a"})\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})`,
      );
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
// Owner's opener, verbatim (2026-08-29). Salman persona + 1-4 stage menu; the
// lead replies with a number and Claude pitches to that segment. Only edit
// this text on the owner's explicit instruction.
const OPENER =
  "Salam! \u{1F44B} Sajawal.School se Salman baat kar raha hoon.\n\nHum Pakistan ki sab se bari digital marketing community hain, 67,000+ students. Yahan sirf course nahi milta, zero se le kar apna kaam ya clients tak ka poora system milta hai, har step k lie practical knowledge, guidance, live sessions aur ek aisi community jahan roz koi na koi apni pehli sale ya pehla client share karta hai.\n\nAap kis stage pe hain, taake main sahi guide kar sakoon:\n1. Bilkul zero se seekhna hai\n2. Freelancing kar rahe hain, clients/income barhani hai\n3. Apna business hai, ads khud chalani hain\n4. Abhi clear nahi ke kya karna chahiye\n\nBas number reply karein. Zyada tar log hamara Advance plan lete hain, lekin aapke liye kya sahi hai wo aapke jawab pe depend karta hai \u{1F642}";

// Owner-approved segment replies (2026-08-29), played verbatim when a lead
// answers the opener menu with a bare 1-4. Zero model cost. Only edit these
// on the owner's explicit instruction.
const MENU_WEBSITE_LINE =
  "Aik dafa beshak hamari website www.sajawal.school pe bhi saari details check kar lein, students ke reviews bhi www.sajawal.school/reviews pe dekh sakte hain, phir jo bhi sawal ho yahan aa kar pooch lein.";
const MENU_PRICES_LINE = "Advance Rs 8,700, Core Rs 3,900, dono lifetime access.";
const MENU_CORE_FALLBACK =
  "Agar ap ko saray advance modules filhal ni chaien or sirf basics strong krna chahtay hen to core plan join kr skte hen.";
const MENU_REPLIES: Record<string, string> = {
  "1": [
    "Perfect. Hamare 70% students bilkul zero se start karte hain, aur yahin se grow karte hain, to ye aapke liye sab se best starting point hai.",
    `Zero walon ko main seedha Advance plan recommend karta hoon: basics se le kar ads aur clients tak sara path, plus live sessions. ${MENU_CORE_FALLBACK}`,
    MENU_PRICES_LINE,
    MENU_WEBSITE_LINE,
    "Start karna chahein to batayein, main payment details bhej deta hoon \u{1F642}",
  ].join("\n\n"),
  "2": [
    "Got it. Freelancers ke liye hamara focus do cheezon pe hai: high-value skills (ads jo actual result dein) aur clear direction ke behtar clients kaise milen aur unhe behtar service kaise di jaye. or long term career growth kase kren.",
    `Aapke liye Advance plan recommended hai, ${MENU_CORE_FALLBACK}`,
    MENU_PRICES_LINE,
    MENU_WEBSITE_LINE,
    "Start karna chahein to batayein, main payment details bhej deta hoon or Koi sawal ho to pooch lein \u{1F642}",
  ].join("\n\n"),
  "3": [
    "Got it. Business owners yahan mainly do cheezein seekhte hain: social media pe strategic content se grow karna, tamaam business basics and essentials, aur Meta/Google ads se scale karna, kisi bhi type ke business ke liye.",
    `Aapke liye Advance plan recommended ha. ${MENU_CORE_FALLBACK}`,
    MENU_PRICES_LINE,
    MENU_WEBSITE_LINE,
    "Jab ready hon batayein, payment details bhej deta hoon. Koi bhi sawal ho to seedha poochein \u{1F642}",
  ].join("\n\n"),
  "4": [
    "Koi masla nahi, bohat log yahin se start karte hain. Yahan aapko saari options aur unki direction samajh aa jati hai, to aap confuse hone ke bajaye apna raasta confidence se choose karte hain.",
    `Aapke liye Advance plan recommended ha. ${MENU_CORE_FALLBACK}`,
    MENU_PRICES_LINE,
    MENU_WEBSITE_LINE,
    "Start karna chahein to batayein, main payment details bhej deta hoon \u{1F642}",
  ].join("\n\n"),
};

async function runDrip(contact: Contact, body: string): Promise<boolean> {
  const text = body.trim();
  // The opener's stage menu is pending: a bare 1-4 plays the owner's scripted
  // segment reply; anything else hands the lead to Claude with full history.
  if (contact.drip_step === 5) {
    await updateContact(contact.id, { drip_step: -1 });
    contact.drip_step = -1;
    const pick = text.match(/^([1-4])[).\s]*$/)?.[1];
    if (!pick) return false;
    await sendBotText(contact, MENU_REPLIES[pick]);
    await armFollowup(contact);
    return true;
  }
  // Contacts mid-way through retired scripts fall through to Claude.
  if (contact.drip_step > 0) {
    await updateContact(contact.id, { drip_step: -1 });
    contact.drip_step = -1;
    return false;
  }
  if (contact.drip_step !== 0) return false;
  // A substantive first message (a question, anything long, anything about
  // price/payment) deserves a real answer, not a script. Straight to Claude.
  const exits =
    text.includes("?") ||
    text.length > 70 ||
    /price|fee|fees|rate|charge|kitn|paise|pais|rupee|rs\b|discount|payment|pay\b|refund/i.test(text);
  if (exits && !/can i get more info|interested/i.test(text)) {
    await updateContact(contact.id, { drip_step: -1 });
    contact.drip_step = -1;
    return false;
  }
  await updateContact(contact.id, { drip_step: 5 });
  contact.drip_step = 5;
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
  await pingSupport(`${note}\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})`);
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
