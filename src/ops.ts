import { config } from "./config.js";
import { sendImage, sendText, uploadMedia } from "./whatsapp.js";
import { funnelSummary, opsActionItems, paymentScreenshot, recentSales } from "./db.js";

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

export function isOpsNumber(from: string): boolean {
  return [config.ops.adminNumber, config.ops.supportNumber, config.opsAlertNumber]
    .filter((n): n is string => Boolean(n))
    .includes(from);
}

export async function handleOpsMessage(from: string, text: string): Promise<void> {
  const t = text.trim().toLowerCase();
  try {
    if (/sale|sold|revenue|payment|paisa/.test(t)) await replySales(from);
    else if (/lead|pending|action|follow|kaam/.test(t)) await replyLeads(from);
    else if (/help|command|option/.test(t)) await replyHelp(from);
    else await replyDigest(from);
  } catch (err) {
    console.error("Ops reply failed:", err);
    try {
      await sendText(from, "Report banate hue error aya — thori dair mein dubara try karein.");
    } catch {
      /* window closed or send failed — nothing else to do */
    }
  }
}

async function replySales(to: string): Promise<void> {
  const sales = await recentSales(7);
  if (!sales.length) {
    await sendText(to, "Pichle 7 din mein koi verified sale nahi.");
    return;
  }
  const total = sales.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const lines = sales.map(
    (r, i) =>
      `${i + 1}. Rs ${Number(r.amount ?? 0).toLocaleString()} — ref ${r.reference ?? "?"} — ${r.name ?? "?"}\n   ${fmtPKT(r.paid_at)} · ${r.from_ad ? "ad" : "organic"} · wa.me/${r.wa_id}`,
  );
  await sendText(to, `💰 Sales (7 din) — ${sales.length} sale, Rs ${total.toLocaleString()}\n\n${lines.join("\n")}\n\nScreenshots aa rahe hain…`);
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
  if (sent === 0) await sendText(to, "In sales ke screenshots store mein nahi hain (purani sales, persistence se pehle ki).");
}

async function replyLeads(to: string): Promise<void> {
  const items = await opsActionItems();
  if (!items.length) {
    await sendText(to, "Abhi koi pending action nahi. Sab clear. ✅");
    return;
  }
  const label: Record<string, string> = {
    payment_review: "🔴 PAYMENT REVIEW",
    stalled_checkout: "🟠 CHECKOUT ADHURA",
    hot_lead_silent: "🟡 HOT LEAD SILENT",
  };
  const lines = items.map(
    (r) => `${label[r.kind] ?? r.kind} — ${r.name ?? "?"}\n${r.note} · last msg ${fmtPKT(r.at)}\n→ wa.me/${r.wa_id}`,
  );
  await sendText(to, `📋 Action list (${items.length})\n\n${lines.join("\n\n")}`);
}

async function replyDigest(to: string): Promise<void> {
  const f = await funnelSummary();
  const items = await opsActionItems();
  await sendText(
    to,
    `📊 Sajawal.School bot\n\nAaj: ${f.sales_today} sale${f.sales_today === 1 ? "" : "s"}, Rs ${Number(f.revenue_today ?? 0).toLocaleString()}\nTotal: ${f.purchases} sales, Rs ${Number(f.revenue ?? 0).toLocaleString()}\n\nContacts ${f.contacts} (ads se ${f.from_ads}) · qualified ${f.qualified} · checkout pe ${f.payment_pending}\nPending actions: ${items.length}\n\nCommands: "sales" · "leads" · "help"`,
  );
}

async function replyHelp(to: string): Promise<void> {
  await sendText(
    to,
    `Commands:\n\n"sales" — pichle 7 din ki verified sales, screenshots ke sath\n"leads" — jin logon pe action chahiye (payment review, adhura checkout, silent hot leads)\nkuch bhi aur — aaj ka summary\n\nYe interface sirf dekh sakta hai — koi record change/delete nahi hota.`,
  );
}
