import { config } from "./config.js";

const base = () => `https://graph.facebook.com/${config.whatsapp.graphVersion}`;

async function graphPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${base()}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Graph API ${res.status} on ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Send a free-form text message (only valid inside the 24h customer service window). */
export async function sendText(to: string, body: string): Promise<string | null> {
  const json = await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url: true },
  });
  return json.messages?.[0]?.id ?? null;
}

/** Send a pre-approved template message (required outside the 24h window). */
export async function sendTemplate(
  to: string,
  name: string,
  language: string,
  components?: unknown[],
): Promise<string | null> {
  const json = await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(components ? { components } : {}),
    },
  });
  return json.messages?.[0]?.id ?? null;
}

/** Mark an inbound message as read and show a typing indicator while the bot thinks. */
export async function markReadWithTyping(messageId: string): Promise<void> {
  try {
    await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    // Non-fatal — read receipts failing should never block a reply
    console.warn("markRead failed:", err);
  }
}

/** Download inbound media (e.g. a payment screenshot) by media ID. */
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaRes = await fetch(`${base()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  });
  if (!metaRes.ok) throw new Error(`Media metadata fetch failed: ${metaRes.status}`);
  const meta: any = await metaRes.json();

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  });
  if (!fileRes.ok) throw new Error(`Media download failed: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type ?? "image/jpeg" };
}

/** Upload media bytes to WhatsApp; returns a media id usable in an image message. */
export async function uploadMedia(buffer: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), "image");
  const res = await fetch(`${base()}/${config.whatsapp.phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    body: form,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new Error(`Media upload failed: ${res.status} ${JSON.stringify(json)}`);
  return json.id;
}

/**
 * Interactive list message: a native tap menu. Row title max 24 chars,
 * description max 72, button label max 20 — WhatsApp hard limits.
 */
export async function sendListMessage(
  to: string,
  body: string,
  buttonText: string,
  rows: Array<{ id: string; title: string; description?: string }>,
): Promise<string | null> {
  const json = await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button: buttonText, sections: [{ rows }] },
    },
  });
  return json.messages?.[0]?.id ??  null;
}

/** Send an audio message by media id (voice notes forwarded to the team). */
export async function sendAudio(to: string, mediaId: string): Promise<string | null> {
  const json = await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "audio",
    audio: { id: mediaId },
  });
  return json.messages?.[0]?.id ?? null;
}

/** Send an image by media id (e.g. a stored payment screenshot to the team). */
export async function sendImage(to: string, mediaId: string, caption?: string): Promise<string | null> {
  const json = await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId, ...(caption ? { caption } : {}) },
  });
  return json.messages?.[0]?.id ?? null;
}
