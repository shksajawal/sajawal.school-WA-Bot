import { createHmac, timingSafeEqual } from "crypto";
import Fastify from "fastify";
import { config } from "./config.js";
import { inboundQueue } from "./queue.js";
import { insertMessage, upsertContact } from "./db.js";
import { sendTemplate } from "./whatsapp.js";

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export async function buildServer() {
  const app = Fastify({ logger: true });

  // Keep the raw body for webhook HMAC verification
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => ({ ok: true }));

  // Meta webhook verification handshake
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.whatsapp.webhookVerifyToken) {
      return reply.status(200).send(q["hub.challenge"]);
    }
    return reply.status(403).send("Forbidden");
  });

  // Inbound events: verify signature, enqueue, ack fast (Meta expects <5s)
  app.post("/webhook", async (req, reply) => {
    const raw = req.body as Buffer;
    if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
      return reply.status(401).send("Invalid signature");
    }

    let payload: any;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply.status(400).send("Bad JSON");
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === "messages" && change.value) {
          await inboundQueue.add("inbound", { value: change.value }, {
            removeOnComplete: 1000,
            removeOnFail: 5000,
          });
        }
      }
    }
    return reply.status(200).send("OK");
  });

  // Website lead import: your site backend calls this when someone signs up
  // but doesn't complete payment. Sends the approved opener template.
  app.post("/leads", async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.leads.apiKey}`) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    let body: { phone?: string; name?: string; components?: unknown[] };
    try {
      body = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return reply.status(400).send({ error: "bad json" });
    }

    const phone = body.phone?.replace(/[^0-9]/g, "");
    if (!phone || phone.length < 10) {
      return reply.status(400).send({ error: "valid phone required" });
    }

    const contact = await upsertContact({ waId: phone, name: body.name, source: "website_lead" });
    const waMsgId = await sendTemplate(
      phone,
      config.leads.openerTemplateName,
      config.leads.openerTemplateLang,
      body.components,
    );
    await insertMessage({
      contactId: contact.id,
      waMessageId: waMsgId,
      direction: "out",
      msgType: "template",
      body: `[template:${config.leads.openerTemplateName}] (website lead opener)`,
    });

    return reply.status(200).send({ ok: true, contact_id: contact.id });
  });

  return app;
}
