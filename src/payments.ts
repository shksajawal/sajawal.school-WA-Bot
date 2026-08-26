import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "./config.js";
import { recordUsage } from "./db.js";

const client = new Anthropic();

export interface PaymentCheck {
  verified: boolean;
  amount: number | null;
  reference: string | null;
  suspicious: boolean;
  /** Amount+reference look right but the recipient isn't visible — a human should confirm. */
  needsHuman: boolean;
  reason: string;
}

const ScreenshotSchema = z.object({
  is_payment_screenshot: z.boolean(),
  amount_pkr: z.number().nullable(),
  transaction_reference: z.string().nullable(),
  bank_or_app: z.string().nullable(),
  recipient_name: z
    .string()
    .nullable()
    .describe("Receiver's name/title EXACTLY as shown (may be partial, e.g. 'Shazal A.' or 'SAJAWAL.SCHOOL')"),
  recipient_number: z
    .string()
    .nullable()
    .describe("Receiver's account/IBAN/wallet number EXACTLY as shown, including masking (e.g. '0300*****2773')"),
  suspicious: z.boolean().describe("True if the image looks edited, cropped to hide fields, or otherwise doctored"),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string(),
});

/**
 * Real receipts rarely show full recipient details — Easypaisa/JazzCash mask
 * the wallet ('0300*****2773'), banks truncate titles, some apps show only a
 * first name. Match on partial anchors, the same approach as the website's
 * OCR keyword list. Result: "match" (an anchor hit), "mismatch" (recipient
 * clearly someone else), or "unknown" (nothing legible either way).
 */
function recipientCheck(name: string | null, number: string | null): "match" | "mismatch" | "unknown" {
  const nameNorm = (name ?? "").toLowerCase();
  const digits = (number ?? "").replace(/\D/g, "");

  const nameHit =
    nameNorm.includes("sajawal") || nameNorm.includes("school") || nameNorm.includes("shazal");

  const numberHit =
    // Allied Bank account / IBAN — full or trailing digits
    digits.includes("82980035") ||
    // Easypaisa/JazzCash wallet — full, unmasked
    digits.includes("03000132773") ||
    digits.includes("923000132773") ||
    // Masked wallet: prefix + suffix pair survives '0300*****2773'
    (digits.includes("0300") && digits.endsWith("2773"));

  if (nameHit || numberHit) return "match";

  const somethingVisible = nameNorm.trim().length >= 3 || digits.length >= 4;
  return somethingVisible ? "mismatch" : "unknown";
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function toImageMediaType(mime: string): ImageMediaType {
  const supported: ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return (supported as string[]).includes(mime) ? (mime as ImageMediaType) : "image/jpeg";
}

/**
 * Adapter for the existing website OCR verification service.
 * Expected contract (adjust to match your actual service):
 *   POST OCR_VERIFY_URL  { image_base64, mime_type }
 *   → { verified: boolean, amount?: number, reference?: string }
 */
async function ocrServiceCheck(image: Buffer, mimeType: string): Promise<PaymentCheck | null> {
  if (!config.ocr.verifyUrl) return null;
  try {
    const res = await fetch(config.ocr.verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.ocr.apiKey ? { Authorization: `Bearer ${config.ocr.apiKey}` } : {}),
      },
      body: JSON.stringify({ image_base64: image.toString("base64"), mime_type: mimeType }),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return {
      verified: Boolean(json.verified),
      amount: typeof json.amount === "number" ? json.amount : null,
      reference: typeof json.reference === "string" ? json.reference : null,
      suspicious: false,
      needsHuman: false,
      reason: "ocr_service",
    };
  } catch (err) {
    console.warn("OCR service check failed, falling back to vision:", err);
    return null;
  }
}

/** Claude vision layer — handles the screenshots OCR chokes on, and flags doctored images. */
async function visionCheck(image: Buffer, mimeType: string): Promise<PaymentCheck> {
  const response = await client.messages.parse({
    model: config.anthropic.visionModel,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: toImageMediaType(mimeType),
              data: image.toString("base64"),
            },
          },
          {
            type: "text",
            text: "This image was sent as proof of a bank transfer payment for a course in Pakistan (bank app, JazzCash, Easypaisa, SadaPay, or Raast screenshot). Extract the payment facts. Be strict: if amount or transaction reference are not clearly legible, report them as null. Copy the recipient name and recipient account/wallet number EXACTLY as displayed, including masking asterisks and partial text — do not guess or complete them. Flag anything that looks edited or doctored.",
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ScreenshotSchema) },
  });

  await recordUsage({ kind: "vision", model: config.anthropic.visionModel, usage: (response as any).usage });

  const parsed = response.parsed_output;
  if (!parsed) {
    return {
      verified: false,
      amount: null,
      reference: null,
      suspicious: false,
      needsHuman: false,
      reason: "vision_parse_failed",
    };
  }

  const amountOk = amountWithinTolerance(parsed.amount_pkr);
  const recipient = recipientCheck(parsed.recipient_name, parsed.recipient_number);
  const isPayment = parsed.is_payment_screenshot;

  // Deliberately lenient: the check's job is "a real payment, into OUR
  // accounts" — not OCR perfection. Reference and high confidence are NOT
  // required to approve; anything ambiguous goes to a human instead of
  // bouncing a paying customer.
  //  - payment screenshot + our account + right amount → auto-verify
  //  - payment screenshot + our account, but amount unreadable/odd or low
  //    confidence → human confirms
  //  - recipient illegible entirely → human confirms
  //  - visibly paid to someone else, or looks doctored → suspicious, never approved
  //  - not a payment screenshot at all → rejected (ask for the actual receipt)
  const verified =
    isPayment && !parsed.suspicious && recipient === "match" && amountOk && parsed.confidence !== "low";
  const needsHuman =
    isPayment &&
    !parsed.suspicious &&
    !verified &&
    (recipient === "match" || recipient === "unknown");
  const suspicious = parsed.suspicious || (isPayment && recipient === "mismatch");

  return {
    verified,
    amount: parsed.amount_pkr,
    reference: parsed.transaction_reference,
    suspicious,
    needsHuman,
    reason: verified
      ? "vision_verified"
      : recipient === "mismatch"
        ? `recipient_mismatch: paid to "${parsed.recipient_name ?? parsed.recipient_number}"`
        : needsHuman
          ? "recipient_not_visible"
          : `vision_rejected: ${parsed.notes}`,
  };
}

/**
 * Verify a payment screenshot: existing OCR service first, Claude vision as
 * fallback/second layer. Amount validity is enforced here; reference-reuse is
 * enforced by the caller against the payments table.
 */
/**
 * True when the paid amount lands within the configured tolerance of ANY
 * valid amount. Rs 3,750 against a Rs 3,900 plan is a sale, not a rejection.
 */
function amountWithinTolerance(amount: number | null): boolean {
  if (amount === null || amount <= 0) return false;
  const pct = config.payment.amountTolerancePct / 100;
  return config.payment.validAmounts.some(
    (valid) => Math.abs(amount - valid) <= valid * pct,
  );
}

export async function verifyPaymentScreenshot(image: Buffer, mimeType: string): Promise<PaymentCheck> {
  const ocr = await ocrServiceCheck(image, mimeType);
  if (ocr?.verified) {
    if (amountWithinTolerance(ocr.amount)) return ocr;
    return { ...ocr, verified: false, reason: `ocr_amount_invalid: ${ocr.amount}` };
  }
  return visionCheck(image, mimeType);
}
