import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { sendCapiEvent } from "../capi.js";
import { type Contact, type StoredMessage, updateContact } from "../db.js";
import { sendText } from "../whatsapp.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const client = new Anthropic();

function historyToMessages(history: StoredMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    if (!m.body) continue;
    // Consecutive same-role messages are allowed — the API merges them into one turn
    messages.push({ role: m.direction === "in" ? "user" : "assistant", content: m.body });
  }
  // The API requires the first message to be from the user
  while (messages.length > 0 && messages[0].role !== "user") messages.shift();
  return messages;
}

function buildTools(contact: Contact) {
  const recordQualifiedLead = betaZodTool({
    name: "record_qualified_lead",
    description:
      "Record that this customer is a qualified lead: they understand the program, know the price, and are engaging with genuine buying intent. Call at most once per customer.",
    inputSchema: z.object({
      reason: z.string().describe("One sentence: why this person qualifies"),
    }),
    run: async () => {
      if (contact.qualified) return "Already recorded for this customer.";
      await updateContact(contact.id, { qualified: true });
      contact.qualified = true;
      await sendCapiEvent(contact, "QualifiedLead");
      return "Qualified lead recorded.";
    },
  });

  const sendPaymentDetails = betaZodTool({
    name: "send_payment_details",
    description:
      "Get the official bank transfer details to share with a customer who has decided to buy. Include the returned details verbatim in your reply, then ask for the payment screenshot in this chat.",
    inputSchema: z.object({
      program: z.string().describe("Which program they are buying, as discussed"),
      expected_amount_pkr: z.number().describe("The exact price of that program in PKR"),
    }),
    run: async (input) => {
      if (contact.status !== "purchased") {
        await updateContact(contact.id, { status: "payment_pending" });
        contact.status = "payment_pending";
      }
      await sendCapiEvent(contact, "InitiateCheckout", {
        value: input.expected_amount_pkr,
        eventId: `initiatecheckout:${contact.id}`,
      });
      return `Bank details to include in your reply:\n${config.payment.bankDetails}`;
    },
  });

  const requestHumanHandoff = betaZodTool({
    name: "request_human_handoff",
    description:
      "Escalate this conversation to a human team member. The bot will stop replying until a human takes over. Use for anger, refunds, payment disputes, blocked sales questions, or explicit requests for a human.",
    inputSchema: z.object({
      reason: z.string().describe("One sentence: why this needs a human"),
    }),
    run: async (input) => {
      await updateContact(contact.id, { status: "handoff" });
      contact.status = "handoff";
      if (config.opsAlertNumber) {
        try {
          await sendText(
            config.opsAlertNumber,
            `🚨 Handoff needed\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})\nReason: ${input.reason}`,
          );
        } catch (err) {
          console.error("Ops alert failed:", err);
        }
      }
      return "A human team member has been notified and will take over this chat.";
    },
  });

  return [recordQualifiedLead, sendPaymentDetails, requestHumanHandoff];
}

/**
 * Generate the bot's next reply for a conversation.
 * Returns null if the model produced no text (should be rare).
 */
export async function generateReply(
  contact: Contact,
  history: StoredMessage[],
  operatorNote?: string,
): Promise<string | null> {
  const messages = historyToMessages(history);
  if (operatorNote) {
    // Mid-conversation system message: operator-authority instruction that
    // does not invalidate the cached system-prompt prefix.
    messages.push({ role: "system" as any, content: operatorNote } as any);
  }
  if (messages.length === 0) return null;

  const finalMessage = await client.beta.messages.toolRunner({
    model: config.anthropic.model,
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // 1h TTL: the frozen system prompt + tools prefix is shared by every
        // conversation, so at volume nearly all input tokens are cache reads.
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: buildTools(contact),
    messages,
  });

  const text = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    // Hard guarantee, independent of the prompt: no em/en dashes ever reach
    // a customer — the #1 "this is AI" tell. Replaced with a comma pause.
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ", ")
    .trim();

  if (!text) {
    console.error(
      `generateReply produced no text for contact ${contact.id} (stop_reason=${finalMessage.stop_reason})`,
    );
  }
  return text || null;
}
