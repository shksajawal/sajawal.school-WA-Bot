import { config } from "./config.js";
import { sendImage, sendAudio, sendText, uploadMedia } from "./whatsapp.js";
import { contactByWaId, funnelSummary, getRecentMessages, openSupportQueries, opsActionItems, opsRangeStats, paymentScreenshot, recentSales } from "./db.js";
import { sendTeamBrief } from "./workers/digest.js";
import { usageByDay } from "./db.js";

/**
 * Read-only WhatsApp interface for the team. Admin and support numbers text the
 * bot's line and get sales/leads reports back. Deliberately NO write commands —
 * nothing here can delete, verify, refund, or change any record.
 *
 * Side benefit: every team message opens WhatsApp's 24h service window, so
 * push alerts (purchase pings, disputes) keep flowing to whoever checks in.
 */

const fmtPKT = (d: Date | string | null): string =>
  d
    ? new Date(d).toLocaleString("en-GB", {
        timeZone: "Asia/Karachi",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "?";

/**
 * Brief real-time ping to every team number. Fire-and-forget: if a number's
 * 24h window is closed the send just fails — the "leads" report is the backstop,
 * and any team message to the bot reopens their window.
 */
const supportTargets = (): string[] => [
  ...new Set(
    [config.ops.supportNumber, config.opsAlertNumber].filter((n): n is string => Boolean(n)),
  ),
];

const allTargets = (): string[] => [
  ...new Set(
    [config.ops.supportNumber, config.ops.adminNumber, config.opsAlertNumber].filter(
      (n): n is string => Boolean(n),
    ),
  ),
];

/**
 * Lead-level operational ping: goes to the SUPPORT number only (owner's spec
 * 2026-08-29: admin gets the daily report and big news, not per-lead chatter).
 */
export async function pingSupport(note: string): Promise<void> {
  for (const to of supportTargets()) {
    try {
      await sendText(to, note);
    } catch (err) {
      console.error("Support ping failed (window likely closed):", err);
    }
  }
}

/** Voice notes are lead-level work: forwarded to the support number only. */
export async function pingTeamAudio(mediaId: string): Promise<void> {
  for (const to of supportTargets()) {
    try {
      await sendAudio(to, mediaId);
    } catch (err) {
      console.error("Team audio forward failed (window likely closed):", err);
    }
  }
}

/** Big news for everyone: sales, the daily report, anything the owner should see. */
export async function pingTeam(note: string): Promise<void> {
  for (const to of allTargets()) {
    try {
      await sendText(to, note);
    } catch (err) {
      console.error("Team ping failed (window likely closed):", err);
    }
  }
}

export function isOpsNumber(from: string): boolean {
  return [config.ops.adminNumber, config.ops.supportNumber, config.opsAlertNumber]
    .filter((n): n is string => Boolean(n))
    .includes(from);
}

export async function handleOpsMessage(from: string, text: string): Promise<void> {
  const t = text.trim().toLowerCase();
  try {
    const num = t.replace(/[^0-9]/g, "");
    if (/chat|history|transcript/.test(t) && num.length >= 10) await replyChat(from, num);
    else if (num.length >= 11 && num.length <= 15 && /^\d+$/.test(t.replace(/[\s+-]/g, ""))) await replyChat(from, num);
    else if (/cost|spend|usage|api|credit/.test(t)) await replyCost(from);
    else if (/week|hafta|7 ?d/.test(t)) await replyRange(from, 7, "Last 7 days");
    else if (/\ball\b|total|till date|overall|abtak|ab tak/.test(t)) await replyAllTime(from);
    else if (/update|brief|latest|abhi|now/.test(t)) await sendTeamBrief(true);
    else if (/sale|sold|revenue|payment|paisa/.test(t)) await replySales(from);
    else if (/lead|pending|action|follow|kaam/.test(t)) await replyLeads(from);
    else if (/help|command|option/.test(t)) await replyHelp(from);
    else await replyDigest(from);
  } catch (err) {
    console.error("Ops reply failed:", err);
    try {
      await sendText(from, "Something went wrong building the report — try again in a minute.");
    } catch {
      /* window closed or send failed — nothing else to do */
    }
  }
}

/** "chat 92300xxxxxxx" (or just the number) — the recent transcript, so a
 * handover ping can be followed by reading the actual conversation. */
async function replyChat(to: string, digits: string): Promise<void> {
  const waId = digits.startsWith("0") ? "92" + digits.slice(1) : digits;
  const contact = await contactByWaId(waId);
  if (!contact) {
    await sendText(to, `No conversation found for ${waId}.`);
    return;
  }
  const history = await getRecentMessages(contact.id, 20);
  const lines = history.map(
    (m) => `${m.direction === "in" ? "👤" : "🤖"} ${(m.body ?? "").slice(0, 160)}`,
  );
  await sendText(
    to,
    `💬 ${contact.name ?? "?"} (wa.me/${contact.wa_id}) — ${contact.status}${contact.email ? ` — ${contact.email}` : ""}\n\n${lines.join("\n")}`,
  );
}

/** "cost" — measured Anthropic spend per day, from our own token ledger. */
async function replyCost(to: string): Promise<void> {
  const days = await usageByDay(7);
  if (!days.length) {
    await sendText(to, "No API usage recorded yet.");
    return;
  }
  const total = days.reduce((s, d) => s + d.usd, 0);
  const lines = days.map((d) => `${d.day}: $${d.usd.toFixed(2)} (${d.calls} calls)`);
  await sendText(to, `🧮 Claude API spend (7 days)\n\n${lines.join("\n")}\n\nTotal: $${total.toFixed(2)}`);
}

async function replySales(to: string): Promise<void> {
  const sales = await recentSales(7);
  if (!sales.length) {
    await sendText(to, "No verified sales in the last 7 days.");
    return;
  }
  const total = sales.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const lines = sales.map(
    (r, i) =>
      `${i + 1}. ${r.name ?? "?"} — Rs ${Number(r.amount ?? 0).toLocaleString()} (ref ${r.reference ?? "?"})\n   Email: ${r.email ?? "❌ not received yet — ask in chat"}\n   Chat: wa.me/${r.wa_id}\n   ${fmtPKT(r.paid_at)} · ${r.from_ad ? "ad" : "organic"}`,
  );
  await sendText(to, `💰 Sales (last 7 days) — ${sales.length} sales, Rs ${total.toLocaleString()}\n\n${lines.join("\n")}\n\nSending screenshots…`);
  let sent = 0;
  for (const r of sales) {
    if (sent >= 5 || !r.has_screenshot) continue;
    const shot = await paymentScreenshot(r.payment_id);
    if (!shot) continue;
    try {
      const mediaId = await uploadMedia(shot.bytes, shot.mime);
      await sendImage(to, mediaId, `Rs ${Number(r.amount ?? 0).toLocaleString()} — ref ${r.reference ?? "?"} — ${r.name ?? "?"}`);
      sent++;
    } catch (err) {
      console.error("Screenshot send failed:", err);
    }
  }
  if (sent === 0) await sendText(to, "No stored screenshots for these sales (they predate screenshot persistence).");
}

async function replyLeads(to: string): Promise<void> {
  const items = await opsActionItems();
  const queries = await openSupportQueries();
  if (!items.length && !queries.length) {
    await sendText(to, "No pending actions. All clear. ✅");
    return;
  }
  const queryLines = queries.map(
    (q) => `🔵 SUPPORT QUERY — ${q.name ?? "?"}\n${q.summary} · ${fmtPKT(q.created_at)}\n→ wa.me/${q.wa_id}`,
  );
  const label: Record<string, string> = {
    payment_review: "🔴 PAYMENT REVIEW",
    stalled_checkout: "🟠 CHECKOUT INCOMPLETE",
    hot_lead_silent: "🟡 HOT LEAD SILENT",
  };
  const lines = items.map(
    (r) => `${label[r.kind] ?? r.kind} — ${r.name ?? "?"}\n${r.note} · last msg ${fmtPKT(r.at)}\n→ wa.me/${r.wa_id}`,
  );
  const all = [...queryLines, ...lines];
  await sendText(to, `📋 Action list (${all.length})\n\n${all.join("\n\n")}`);
}

async function replyDigest(to: string): Promise<void> {
  const f = await funnelSummary();
  const items = await opsActionItems();
  await sendText(
    to,
    `📊 Sajawal.School bot\n\nToday: ${f.sales_today} sale${f.sales_today === 1 ? "" : "s"}, Rs ${Number(f.revenue_today ?? 0).toLocaleString()}\nAll-time: ${f.purchases} sales, Rs ${Number(f.revenue ?? 0).toLocaleString()}\n\nContacts ${f.contacts} (${f.from_ads} from ads) · qualified ${f.qualified} · at checkout ${f.payment_pending}\nPending actions: ${items.length}\n\nCommands: "sales" · "leads" · "help"`,
  );
}

async function replyHelp(to: string): Promise<void> {
  await sendText(
    to,
    `Commands:\n\n"sales" — verified sales from the last 7 days, with screenshots\n"leads" — everyone needing action (payment reviews, incomplete checkouts, silent hot leads)\n"update" — what\u2019s new since the last brief\na phone number — that customer` + "\u2019" + `s recent chat transcript\nanything else — today` + "\u2019" + `s summary\n\nThis interface is read-only — nothing can be changed or deleted from here.`,
  );
}


/** On-demand range summary: "week" -> last 7 days. Never pushed automatically. */
async function replyRange(to: string, days: number, label: string): Promise<void> {
  const r = await opsRangeStats(days);
  const conv = r.leads > 0 ? ((r.sales / r.leads) * 100).toFixed(1) + "%" : "0%";
  await sendText(
    to,
    `\u{1F4C8} ${label}\nLeads: ${r.leads}\nPayment stage: ${r.paystage}\nSales: ${r.sales} = Rs ${Number(r.revenue ?? 0).toLocaleString()}\nLead to sale: ${conv}`,
  );
}

/** On-demand till-date totals. Never pushed automatically. */
async function replyAllTime(to: string): Promise<void> {
  const f = await funnelSummary();
  await sendText(
    to,
    `\u{1F4C8} Till date\nLeads: ${f.contacts} (${f.from_ads} from ads)\nQualified: ${f.qualified}\nSales: ${f.purchases} = Rs ${Number(f.revenue ?? 0).toLocaleString()}`,
  );
}
