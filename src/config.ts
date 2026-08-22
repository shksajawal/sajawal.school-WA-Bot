import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  whatsapp: {
    graphVersion: process.env.GRAPH_VERSION ?? "v23.0",
    phoneNumberId: required("WA_PHONE_NUMBER_ID"),
    wabaId: required("WA_WABA_ID"),
    accessToken: required("WA_ACCESS_TOKEN"),
    appSecret: required("WA_APP_SECRET"),
    webhookVerifyToken: required("WA_WEBHOOK_VERIFY_TOKEN"),
  },

  capi: {
    datasetId: required("META_DATASET_ID"),
    accessToken: process.env.META_CAPI_ACCESS_TOKEN || required("WA_ACCESS_TOKEN"),
    testEventCode: process.env.META_TEST_EVENT_CODE || undefined,
  },

  anthropic: {
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5",
  },

  ocr: {
    verifyUrl: process.env.OCR_VERIFY_URL || undefined,
    apiKey: process.env.OCR_API_KEY || undefined,
  },

  payment: {
    bankDetails: required("BANK_DETAILS").replace(/\\n/g, "\n"),
    validAmounts: (process.env.VALID_AMOUNTS ?? "3900,8700")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  },

  followup: {
    firstDelayMs: Number(process.env.FOLLOWUP_FIRST_DELAY_MS ?? 4 * 60 * 60 * 1000),
    templateName: process.env.FOLLOWUP_TEMPLATE_NAME ?? "course_followup",
    templateLanguage: process.env.FOLLOWUP_TEMPLATE_LANG ?? "en",
    maxTouches: Number(process.env.FOLLOWUP_MAX_TOUCHES ?? 2),
  },

  leads: {
    apiKey: required("LEADS_API_KEY"),
    openerTemplateName: process.env.LEAD_OPENER_TEMPLATE_NAME ?? "website_lead_opener",
    openerTemplateLang: process.env.LEAD_OPENER_TEMPLATE_LANG ?? "en",
  },

  opsAlertNumber: process.env.OPS_ALERT_NUMBER || undefined,
};
