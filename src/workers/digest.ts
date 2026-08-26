import {
  funnelSummary,
  getState,
  opsActionItems,
  salesSince,
  setState,
  supportQueriesSince,
} from "../db.js";
import { pingTeam } from "../ops.js";

/**
 * Rolling team brief.
 *
 * Replaces paid re-engagement templates: the bot never messages a cold lead
 * past the free 24h window. Instead the team gets a brief every couple of
 * hours — but ONLY when something new has happened since the last one, so
 * frequent updates never turn into noise the team learns to ignore.
 *
 * Cadence and quiet hours are env-tunable. State lives in Postgres, so the
 * frequent redeploys on this project can't double-send or skip a brief.
 */
const INTERVAL_HOURS = Number(process.env.BRIEF_INTERVAL_HOURS ?? 2);
const START_HOUR = Number(process.env.BRIEF_START_HOUR_PKT ?? 9);
const END_HOUR = Number(process.env.BRIEF_END_HOUR_PKT ?? 23);
const STATE_KEY = "last_team_brief_at";

function pktHour(): number {
  return Number(
    new Date().toLocaleString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", hour12: false }),
  );
}

/** Builds and sends the brief if anything is new. Returns true when sent. */
export async function sendTeamBrief(force = false): Promise<boolean> {
  const raw = await getState(STATE_KEY);
  const since = raw ? new Date(raw) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [sales, queries, f, items] = await Promise.all([
    salesSince(since),
    supportQueriesSince(since),
    funnelSummary(),
    opsActionItems(),
  ]);

  const followUps = queries.filter((q) => q.summary.startsWith("Follow-up needed"));
  const other = queries.filter((q) => !q.summary.startsWith("Follow-up needed"));

  // Nothing new -> stay silent. This is what keeps a 2-hourly brief useful.
  if (!force && sales.length === 0 && queries.length === 0) {
    await setState(STATE_KEY, new Date().toISOString());
    return false;
  }

  const parts: string[] = [
    `🔔 Update — ${f.sales_today} sale${f.sales_today === 1 ? "" : "s"} today (Rs ${Number(f.revenue_today ?? 0).toLocaleString()}) · ${f.payment_pending} at checkout · ${items.length} pending action${items.length === 1 ? "" : "s"}`,
  ];

  if (sales.length) {
    parts.push(
      `💰 NEW SALES (${sales.length})\n` +
        sales
          .map(
            (r) =>
              `• ${r.name ?? "?"} — Rs ${Number(r.amount ?? 0).toLocaleString()} (ref ${r.reference ?? "?"})\n  Email: ${r.email ?? "❌ ask in chat"}\n  wa.me/${r.wa_id}`,
          )
          .join("\n"),
    );
  }

  if (followUps.length) {
    parts.push(
      `📞 MESSAGE THESE (bot can't — 24h+ quiet) — ${followUps.length}\n` +
        followUps
          .map(
            (q) =>
              `• ${q.name ?? "?"} — ${q.summary.replace("Follow-up needed (quiet 24h+). ", "")}\n  wa.me/${q.wa_id}`,
          )
          .join("\n"),
    );
  }

  if (other.length) {
    parts.push(
      `📨 SUPPORT (${other.length})\n` +
        other.map((q) => `• ${q.name ?? "?"}: ${q.summary}\n  wa.me/${q.wa_id}`).join("\n"),
    );
  }

  parts.push(`Reply "leads" or "sales" any time for the full list.`);

  await pingTeam(parts.join("\n\n"));
  await setState(STATE_KEY, new Date().toISOString());
  return true;
}

/**
 * Checks every 10 minutes: inside working hours, and at least INTERVAL_HOURS
 * since the last brief, send one if there is anything new.
 */
export function startBriefScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const hour = pktHour();
      if (hour < START_HOUR || hour >= END_HOUR) return;

      const raw = await getState(STATE_KEY);
      if (raw) {
        const elapsedH = (Date.now() - new Date(raw).getTime()) / 3_600_000;
        if (elapsedH < INTERVAL_HOURS) return;
      }
      const sent = await sendTeamBrief();
      if (sent) console.log("Team brief sent");
    } catch (err) {
      console.error("Team brief failed:", err);
    }
  };
  void tick();
  return setInterval(tick, 10 * 60 * 1000);
}
