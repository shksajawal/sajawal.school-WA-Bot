import { config } from "../config.js";
import { openSupportQueries, opsActionItems, funnelSummary, recentSales } from "../db.js";
import { pingTeam } from "../ops.js";

/**
 * Daily follow-up digest for the human team.
 *
 * Replaces paid re-engagement templates: instead of the bot paying Meta to
 * message a cold lead, the humans get one structured list each day with enough
 * context to open the conversation themselves from their own number (no 24h
 * window applies to a normal WhatsApp account).
 *
 * Sent once a day at DIGEST_HOUR_PKT. Idempotent per day, so a redeploy or a
 * restart cannot double-send.
 */
const HOUR = Number(process.env.DIGEST_HOUR_PKT ?? 11); // 11am PKT default
let lastSentDay = "";

function pktDayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
}
function pktHour(): number {
  return Number(
    new Date().toLocaleString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", hour12: false }),
  );
}
const fmt = (d: Date | string | null): string =>
  d
    ? new Date(d).toLocaleString("en-GB", {
        timeZone: "Asia/Karachi",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "?";

export async function sendDailyDigest(): Promise<void> {
  const [f, items, queries, sales] = await Promise.all([
    funnelSummary(),
    opsActionItems(),
    openSupportQueries(),
    recentSales(1),
  ]);

  const followUps = queries.filter((q) => q.summary.startsWith("Follow-up needed"));
  const otherQueries = queries.filter((q) => !q.summary.startsWith("Follow-up needed"));

  const sections: string[] = [
    `📅 Daily brief — Sajawal.School bot\n\nYesterday/today: ${f.sales_today} sale${f.sales_today === 1 ? "" : "s"}, Rs ${Number(f.revenue_today ?? 0).toLocaleString()}\nAll-time: ${f.purchases} sales, Rs ${Number(f.revenue ?? 0).toLocaleString()}\nContacts ${f.contacts} (${f.from_ads} from ads) · qualified ${f.qualified} · at checkout ${f.payment_pending}`,
  ];

  if (sales.length) {
    sections.push(
      `💰 Sales in last 24h (${sales.length})\n` +
        sales
          .map(
            (r) =>
              `• ${r.name ?? "?"} — Rs ${Number(r.amount ?? 0).toLocaleString()} (ref ${r.reference ?? "?"})\n  Email: ${r.email ?? "❌ ask in chat"}\n  wa.me/${r.wa_id}`,
          )
          .join("\n"),
    );
  }

  if (followUps.length) {
    sections.push(
      `📞 Needs YOUR message (bot can't reach them, 24h+ quiet) — ${followUps.length}\n` +
        followUps
          .map((q) => `• ${q.name ?? "?"} — ${q.summary.replace("Follow-up needed (quiet 24h+). ", "")}\n  wa.me/${q.wa_id}`)
          .join("\n"),
    );
  }

  if (otherQueries.length) {
    sections.push(
      `📨 Support queries — ${otherQueries.length}\n` +
        otherQueries.map((q) => `• ${q.name ?? "?"}: ${q.summary}\n  wa.me/${q.wa_id}`).join("\n"),
    );
  }

  if (items.length) {
    const label: Record<string, string> = {
      payment_review: "🔴 payment review",
      stalled_checkout: "🟠 got details, no screenshot",
      hot_lead_silent: "🟡 qualified but quiet",
    };
    sections.push(
      `📋 Other actions — ${items.length}\n` +
        items
          .map((r) => `• ${label[r.kind] ?? r.kind} — ${r.name ?? "?"} (${fmt(r.at)})\n  wa.me/${r.wa_id}`)
          .join("\n"),
    );
  }

  if (sections.length === 1) sections.push("Nothing needs action right now. ✅");

  await pingTeam(sections.join("\n\n"));
}

/** Checks every 10 minutes; fires once when the PKT hour matches. */
export function startDigestScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const day = pktDayKey();
      if (day === lastSentDay || pktHour() !== HOUR) return;
      lastSentDay = day;
      await sendDailyDigest();
      console.log(`Daily digest sent (${day})`);
    } catch (err) {
      console.error("Daily digest failed:", err);
    }
  };
  void tick();
  return setInterval(tick, 10 * 60 * 1000);
}
