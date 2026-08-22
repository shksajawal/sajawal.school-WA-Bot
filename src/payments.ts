import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "./config.js";

const client = new Anthropic();

export interface PaymentCheck {
  verified: boolean;
  amount: number | null;
  reference: string | null;
  suspicious: boolean;
  reason: string;
}

const ScreenshotSchema = z.object({
  is_payment_screenshot: z.boolean(),
  amount_pkr: z.number().nullable(),
  transaction_reference: z.string().nullable(),
  bank_or_app: z.string().nullable(),
  recipient_visible: z.string().nullable(),
  suspicious: z.boolean().describe("True if the image looks edited, cropped to hide fields, or otherwise doctored"),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string(),
});

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
    model: config.anthropic.model,
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
            text: "This image was sent as proof of a bank transfer payment for a course in Pakistan (bank app, JazzCash, Easypaisa, or Raast screenshot). Extract the payment facts. Be strict: if amount or transaction reference are not clearly legible, report them as null. Flag anything that looks edited or doctored.",
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ScreenshotSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    return { verified: false, amount: null, reference: null, suspicious: false, reason: "vision_parse_failed" };
  }

  const amountOk =
    parsed.amount_pkr !== null && config.payment.validAmounts.includes(parsed.amount_pkr);
  const verified =
    parsed.is_payment_screenshot &&
    !parsed.suspicious &&
    parsed.confidence === "high" &&
    amountOk &&
    parsed.transaction_reference !== null;

  return {
    verified,
    amount: parsed.amount_pkr,
    reference: parsed.transaction_reference,
    suspicious: parsed.suspicious,
    reason: verified ? "vision_verified" : `vision_rejected: ${parsed.notes}`,
  };
}

/**
 * Verify a payment screenshot: existing OCR service first, Claude vision as
 * fallback/second layer. Amount validity is enforced here; reference-reuse is
 * enforced by the caller against the payments table.
 */
export async function verifyPaymentScreenshot(image: Buffer, mimeType: string): Promise<PaymentCheck> {
  const ocr = await ocrServiceCheck(image, mimeType);
  if (ocr?.verified) {
    const amountOk = ocr.amount !== null && config.payment.validAmounts.includes(ocr.amount);
    if (amountOk) return ocr;
    return { ...ocr, verified: false, reason: `ocr_amount_invalid: ${ocr.amount}` };
  }
  return visionCheck(image, mimeType);
}
