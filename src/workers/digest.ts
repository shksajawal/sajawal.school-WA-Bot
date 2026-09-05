import {
  followupsSentToday,
  getState,
  learningSamples,
  opsActionItems,
  opsDailyStats,
  setState,
  supportQueriesSince,
} from "../db.js";
import { pingTeam } from "../ops.js";
import { analyzeText } from "../agent/agent.js";

/**
 * Daily team report, owner's spec (2026-08-29):
 * - ONE report at 23:00 PKT to both admin and support numbers, covering the
 *   whole day: funnel numbers vs yesterday, what's good / what's bad, the
 *   questions the bot could not handle (knowledge to feed), and Salman's
 *   action list.
 * - No rolling 2-hourly brief any more; urgent and big things ping in real
 *   time from where they happen (sales, disputes, handoffs).
 * - "update" sends the same report on demand. Weekly / till-date views exist
 *   only on demand ("week" command), never pushed.
 */
const STATE_KEY = "last_daily_report_date";

function pktHour(): number {
  return Number(
    new Date().toLocaleString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", hour12: false }),
  );
}

function pktDateStr(): string {
  return new Date().toLocaleDateString("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
  });
}

function pktDayStartUtc(): Date {
  const now = new Date();
  const pkt = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
  const dayMs = pkt.getHours() * 3600_000 + pkt.getMinutes() * 60_000 + pkt.getSeconds() * 1000;
  return new Date(now.getTime() - dayMs);
}

const pct = (a: number, b: number): string => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "0%");

/** Builds and sends the daily report. Also used by the on-demand "update" command. */
export async function sendTeamBrief(_force = false): Promise<boolean> {
  const [s, queries, items] = await Promise.all([
    opsDailyStats(),
    supportQueriesSince(pktDayStartUtc()),
    opsActionItems(),
  ]);

  const convT = pct(s.sales_t, s.leads_t);
  const convY = pct(s.sales_y, s.leads_y);
  const rev = Number(s.rev_t ?? 0).toLocaleString();
  const revY = Number(s.rev_y ?? 0).toLocaleString();

  const parts: string[] = [
    `\u{1F4CA} Daily Report, ${pktDateStr()}\n` +
      `Leads: ${s.leads_t} (kal ${s.leads_y})\n` +
      `Payment stage: ${s.paystage_t} (kal ${s.paystage_y})\n` +
      `Sales: ${s.sales_t} = Rs ${rev} (Core ${s.core_t} / Advance ${s.adv_t}), kal ${s.sales_y} = Rs ${revY}\n` +
      `Lead to sale: ${convT} (kal ${convY})\n` +
      `Tracking: ${s.capi_ok} events ok${s.capi_fail ? `, ${s.capi_fail} FAILED` : ""}`,
  ];

  // Auto insight lines: one good, one bad, derived from the day's numbers.
  const good: string[] = [];
  const bad: string[] = [];
  if (s.leads_t > s.leads_y) good.push(`lead volume up (${s.leads_y} -> ${s.leads_t})`);
  if (s.sales_t > s.sales_y) good.push(`sales up (${s.sales_y} -> ${s.sales_t})`);
  if (s.sales_t < s.sales_y) bad.push(`sales down (${s.sales_y} -> ${s.sales_t})`);
  if (s.paystage_t < s.paystage_y) bad.push(`fewer leads reaching payment (${s.paystage_y} -> ${s.paystage_t})`);
  if (s.capi_fail > 0) bad.push(`${s.capi_fail} tracking events failed`);
  // Tripwire: follow-ups claiming to work is not the same as follow-ups
  // delivered. Zero sends on a day with real lead volume is an alarm.
  try {
    const fu = await followupsSentToday();
    parts[0] += `\nFollow-ups sent: ${fu.nudges} nudges, ${fu.reminders} reminders`;
    if (fu.nudges + fu.reminders === 0 && s.leads_t > 50) {
      bad.push("ZERO follow-ups delivered today - follow-up system may be broken, tell Claude");
    }
  } catch (err) {
    console.error("followup tripwire failed:", err);
  }
  if (good.length) parts.push(`\u{1F44D} Good: ${good.join("; ")}`);
  if (bad.length) parts.push(`\u{26A0} Watch: ${bad.join("; ")}`);

  // Questions the bot handed to humans today = knowledge gaps worth feeding.
  const gaps = queries.filter((q) => !q.summary.startsWith("Follow-up needed")).slice(0, 6);
  if (gaps.length) {
    parts.push(
      `\u{1F534} Bot needed human help today (feed answers if repeating):\n` +
        gaps.map((q) => `• ${q.name ?? "?"}: ${q.summary.slice(0, 90)}`).join("\n"),
    );
  }

  // Salman's action list: pending items with instant links.
  if (items.length) {
    parts.push(
      `✅ Salman action items (${items.length}):\n` +
        items
          .slice(0, 8)
          .map((i) => `• ${i.name ?? "?"}: ${i.note}\n  wa.me/${i.wa_id}`)
          .join("\n") +
        (items.length > 8 ? `\n(+${items.length - 8} more, reply "leads")` : ""),
    );
  }

  // Nightly self-review: ONE model call comparing today's won vs lost chats.
  // The lessons go in the report (owner decides what gets baked into the
  // prompt) and are archived in bot_state for the weekly review.
  try {
    const samples = await learningSamples();
    if (samples.length >= 3) {
      const convos = samples.map((c, i) => `#${i + 1} [${c.label}]\n${c.convo}`).join("\n\n");
      const lessons = await analyzeText(
        "You review today's WhatsApp sales chats for Sajawal.School (the bot poses as Salman). Compare the WON and LOST conversations. Reply with 3-5 short bullets only, max 90 words total, no preamble: what is working, what exactly killed the lost chats (the specific message or moment), one concrete change to close more tomorrow, and whether the bot's tone drifted from casual Pakistani Roman Urdu texting style.",
        convos,
      );
      if (lessons) {
        parts.push(`\u{1F9E0} Aaj ki learnings:\n${lessons.slice(0, 900)}`);
        await setState(`learnings_${pktDateStr()}`, lessons);
      }
    }
  } catch (err) {
    console.error("Learning section failed:", err);
  }

  parts.push(`Reply "sales", "leads", "cost" ya "update" kisi bhi waqt.`);

  await pingTeam(parts.join("\n\n"));
  await setState(STATE_KEY, pktDateStr());
  return true;
}

/** Fires the daily report once, at or after 23:00 PKT, exactly once per PKT day. */
export function startBriefScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      if (pktHour() < 23) return;
      const last = await getState(STATE_KEY);
      if (last === pktDateStr()) return;
      await sendTeamBrief();
      console.log("Daily report sent");
    } catch (err) {
      console.error("Daily report failed:", err);
    }
  };
  void tick();
  return setInterval(tick, 5 * 60 * 1000);
}
