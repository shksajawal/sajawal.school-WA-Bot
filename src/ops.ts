import { config } from "./config.js";
import { sendImage, sendAudio, sendText, uploadMedia } from "./whatsapp.js";
import { contactByWaId, funnelSummary, getHandledMap, getRecentMessages, getState, markHandled, openSupportQueries, opsActionItems, opsRangeStats, paymentScreenshot, recentSales, setState } from "./db.js";
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

/** Remember when a team number last messaged us — their 24h window clock. */
export async function noteOpsInbound(from: string): Promise<void> {
  try {
    await setState(`ops_last_in_${from}`, new Date().toISOString());
  } catch (err) {
    console.error("ops window note failed:", err);
  }
}

/**
 * Owner's rule (2026-09-12): at ~23h since a team number's last message, send
 * a one-line reminder so a quick reply keeps their WhatsApp window open and
 * pings/reports never silently bounce. Sent once per window.
 */
export function startOpsKeepalive(): NodeJS.Timeout {
  const tick = async () => {
    for (const to of allTargets()) {
      try {
        const raw = await getState(`ops_last_in_${to}`);
        if (!raw) continue;
        const age = Date.now() - new Date(raw).getTime();
        if (age < 23 * 3600_000 || age > 24 * 3600_000) continue;
        if ((await getState(`ops_keepalive_${to}`)) === raw) continue;
        await sendText(
          to,
          "Session reminder: this window expires in ~1 hour. Reply anything (ok works) to keep bot updates flowing for the next 24h 🙂",
        );
        await setState(`ops_keepalive_${to}`, raw);
      } catch (err) {
        console.error("ops keepalive failed:", err);
      }
    }
  };
  void tick();
  return setInterval(tick, 10 * 60 * 1000);
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
    // Commands must be deliberate: a short message that STARTS with the
    // command word. A keyword buried in a normal sentence is not a command —
    // that was dumping 7-day sales reports on the owner uninvited.
    const isCmd = (re: RegExp): boolean => t.length <= 30 && re.test(t);
    if (isCmd(/^(all ?done|sab ?done)$/)) {
      const handled = await getHandledMap();
      const open = (await opsActionItems()).filter((i) => !handled[i.wa_id]);
      const n = await markHandled(open.map((i) => i.wa_id));
      await sendText(from, `✅ ${n} item${n === 1 ? "" : "s"} marked handled. List is clear; only new work will appear.`);
    }
    else if (isCmd(/^done\b/) && num.length >= 10) {
      const waId = num.startsWith("0") ? "92" + num.slice(1) : num;
      await markHandled([waId]);
      await sendText(from, `✅ Marked handled: wa.me/${waId}`);
    }
    else if (/^(chat|history|transcript)\b/.test(t) && num.length >= 10) await replyChat(from, num);
    else if (num.length >= 11 && num.length <= 15 && /^\d+$/.test(t.replace(/[\s+-]/g, ""))) await replyChat(from, num);
    else if (isCmd(/^(cost|spend|usage|api)/)) await replyCost(from);
    else if (isCmd(/^(week|hafta|7 ?d)/)) await replyRange(from, 7, "Last 7 days");
    else if (isCmd(/^(all|total|till ?date|overall)/)) await replyAllTime(from);
    else if (isCmd(/^(update|brief|report|latest|abhi)/)) await sendTeamBrief(true, from);
    else if (isCmd(/^(sales?|sold|revenue)/)) await replySales(from);
    else if (isCmd(/^(leads?|pending|actions?|follow)/)) await replyLeads(from);
    else if (isCmd(/^(summary|digest|stats)/)) await replyDigest(from);
    else await replyHelp(from);
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
  const handled = await getHandledMap();
  const items = (await opsActionItems()).filter((i) => !handled[i.wa_id]);
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
    stalled_hot: "🟠 CHECKOUT INCOMPLETE (today)",
    stalled_cooling: "🟡 CHECKOUT INCOMPLETE (1-3 days)",
    hot_lead_silent: "⚪ HOT LEAD SILENT",
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
    `Commands (message must start with the word):\n\n"update" - today\'s report\n"leads" - everyone needing action\n"done 92300xxxxxxx" - mark that lead handled\n"ALL DONE" - mark the whole list handled\n"sales" - last 7 days sales with screenshots\n"cost" - API spend\n"week" - 7 day summary\n"all" - till-date totals\na phone number - that customer\'s chat`,
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
