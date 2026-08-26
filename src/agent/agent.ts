import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { sendCapiEvent } from "../capi.js";
import { insertSupportQuery, recordUsage, type Contact, type StoredMessage, updateContact } from "../db.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { pingTeam } from "../ops.js";

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
    run: async (input) => {
      if (contact.qualified) return "Already recorded for this customer.";
      await updateContact(contact.id, { qualified: true });
      contact.qualified = true;
      await sendCapiEvent(contact, "QualifiedLead");
      await pingTeam(
        `🟢 Qualified lead — ${contact.name ?? "?"} (wa.me/${contact.wa_id})\n${input.reason}`,
      );
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
      await pingTeam(
        `🛒 Checkout started — Rs ${input.expected_amount_pkr.toLocaleString()} (${input.program})\n${contact.name ?? "?"} (wa.me/${contact.wa_id}) — bank details sent`,
      );
      return `Bank details to include in your reply:\n${config.payment.bankDetails}`;
    },
  });

  const requestHumanHandoff = betaZodTool({
    name: "request_human_handoff",
    description:
      "ONLY for payment disputes and refund claims. Flags the payment for team review and alerts the team — you KEEP replying to everything else. Never use for hiring, support, or unanswered questions; route those with the links in your instructions.",
    inputSchema: z.object({
      reason: z.string().describe("One sentence: why this needs a human"),
    }),
    run: async (input) => {
      try {
        await updateContact(contact.id, { status: "payment_review" });
        contact.status = "payment_review";
      } catch (err) {
        // A DB hiccup must never kill the customer's reply mid-conversation
        console.error("payment_review status update failed:", err);
      }
      await pingTeam(
        `🚨 Payment dispute\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})\nReason: ${input.reason}`,
      );
      return "Payment team has been alerted and will confirm in this chat. Keep helping the customer with everything else — do not go silent.";
    },
  });

  const notifySupport = betaZodTool({
    name: "notify_support",
    description:
      "Forward a support issue (access, classroom, community, account — anything the knowledge base can't solve) to the human support team. They get the summary + customer link instantly, and the query lands on the team's action list. Use once per issue, then tell the customer it's forwarded and keep answering their other questions.",
    inputSchema: z.object({
      summary: z.string().describe("One line: the customer's issue, specific enough for support to act without reading the chat"),
    }),
    run: async (input) => {
      try {
        await insertSupportQuery(contact.id, input.summary);
      } catch (err) {
        // Queue insert failing must not break the reply — the ping still goes out
        console.error("support_queue insert failed:", err);
      }
      await pingTeam(
        `📨 Support query\nCustomer: ${contact.name ?? "?"} (wa.me/${contact.wa_id})\nIssue: ${input.summary}`,
      );
      return "Forwarded to the human support team — they have the summary and the customer's contact. Tell the customer it's been forwarded and they'll be contacted shortly, and that you're here for any other questions meanwhile.";
    },
  });

  return [recordQualifiedLead, sendPaymentDetails, requestHumanHandoff, notifySupport];
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

  await recordUsage({ kind: "chat", model: config.anthropic.model, usage: finalMessage.usage as any });

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
