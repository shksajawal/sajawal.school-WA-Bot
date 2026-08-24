import "dotenv/config";

/** Strip whitespace, stray newlines, and accidental wrapping quotes from env values. */
function sanitize(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const cleaned = v.trim().replace(/^["']+|["']+$/g, "").trim();
  return cleaned === "" ? undefined : cleaned;
}

function required(name: string): string {
  const v = sanitize(process.env[name]);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  return sanitize(process.env[name]);
}

export const config = {
  port: Number(optional("PORT") ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: optional("REDIS_URL") ?? "redis://localhost:6379",

  whatsapp: {
    graphVersion: optional("GRAPH_VERSION") ?? "v23.0",
    phoneNumberId: required("WA_PHONE_NUMBER_ID"),
    wabaId: required("WA_WABA_ID"),
    accessToken: required("WA_ACCESS_TOKEN"),
    appSecret: required("WA_APP_SECRET"),
    webhookVerifyToken: required("WA_WEBHOOK_VERIFY_TOKEN"),
  },

  capi: {
    datasetId: required("META_DATASET_ID"),
    accessToken: optional("META_CAPI_ACCESS_TOKEN") ?? required("WA_ACCESS_TOKEN"),
    testEventCode: optional("META_TEST_EVENT_CODE"),
    // Meta rejects business_messaging events without it. Optional here on purpose:
    // a missing value must not crash a bot that is mid-conversation with buyers.
    pageId: optional("META_PAGE_ID"),
  },

  anthropic: {
    model: optional("CLAUDE_MODEL") ?? "claude-opus-5",
  },

  ocr: {
    verifyUrl: optional("OCR_VERIFY_URL"),
    apiKey: optional("OCR_API_KEY"),
  },

  payment: {
    bankDetails: required("BANK_DETAILS").replace(/\\n/g, "\n"),
    validAmounts: (optional("VALID_AMOUNTS") ?? "3900,8700")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  },

  followup: {
    firstDelayMs: Number(optional("FOLLOWUP_FIRST_DELAY_MS") ?? 4 * 60 * 60 * 1000),
    templateName: optional("FOLLOWUP_TEMPLATE_NAME") ?? "course_followup",
    templateLanguage: optional("FOLLOWUP_TEMPLATE_LANG") ?? "en",
    maxTouches: Number(optional("FOLLOWUP_MAX_TOUCHES") ?? 2),
  },

  leads: {
    apiKey: required("LEADS_API_KEY"),
    openerTemplateName: optional("LEAD_OPENER_TEMPLATE_NAME") ?? "website_lead_opener",
    openerTemplateLang: optional("LEAD_OPENER_TEMPLATE_LANG") ?? "en",
  },

  opsAlertNumber: optional("OPS_ALERT_NUMBER"),

  ops: {
    // WhatsApp numbers that get the read-only team interface instead of the
    // sales agent. Deliberately no write/admin commands — fetch only.
    adminNumber: optional("ADMIN_NUMBER"),
    supportNumber: optional("SUPPORT_NUMBER"),
  },
};
