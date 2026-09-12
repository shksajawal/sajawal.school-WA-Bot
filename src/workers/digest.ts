import {
  adviceSamples,
  apiUsageTwoDays,
  followupsSentToday,
  getHandledMap,
  getState,
  learningSamples,
  opsActionItems,
  opsDailyStats,
  setState,
  supportQueriesSince,
} from "../db.js";
import { config } from "../config.js";
import { sendText } from "../whatsapp.js";
import { analyzeText } from "../agent/agent.js";

/**
 * Reporting layer, owner's spec (2026-09-12):
 * - OWNER gets ONE brief numbers-only message at 23:50 PKT: sales, leads,
 *   conversion, API cost, each vs yesterday, plus a one-line pipeline pulse.
 *   No screenshots, no till-date, no walls of text.
 * - SALMAN (support) gets the working pack at 23:50 PKT (action items with
 *   links + money at stake + carryover age, knowledge gaps, learnings,
 *   advice insights) and a fresh morning action list at 10:00 PKT.
 * - Real-time pings (sales, disputes, handoffs) are unchanged.
 * - Ranged/till-date data only on demand, never pushed.
 */
const OWNER_STATE_KEY = "last_owner_daily_date";
const MORNING_STATE_KEY = "last_salman_morning_date";

const PRICE: Record<string, [number, number, number, number]> = {
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-sonnet-5": [3, 15, 0.3, 3.75],
};

function pktNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
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
  const pkt = pktNow();
  const dayMs = pkt.getHours() * 3600_000 + pkt.getMinutes() * 60_000 + pkt.getSeconds() * 1000;
  return new Date(now.getTime() - dayMs);
}

const pct = (a: number, b: number): string => (b > 0 ? ((a / b) * 100).toFixed(2) + "%" : "0%");

async function apiCostTodayYesterday(): Promise<{ t: number; y: number }> {
  const rows = await apiUsageTwoDays();
  const out = { t: 0, y: 0 };
  for (const r of rows) {
    const [pi, po, pcr, pcw] = PRICE[r.model] ?? [3, 15, 0.3, 3.75];
    out[r.day] += (r.inp / 1e6) * pi + (r.outp / 1e6) * po + (r.cr / 1e6) * pcr + (r.cw / 1e6) * pcw;
  }
  return out;
}

/** The owner's entire daily update. Five lines of numbers, one pulse line. */
async function buildOwnerBrief(): Promise<string> {
  const [s, cost, rawItems, handled] = await Promise.all([
    opsDailyStats(),
    apiCostTodayYesterday(),
    opsActionItems(),
    getHandledMap(),
  ]);
  const items = rawItems.filter((i) => !handled[i.wa_id]);
  const arrow = (t: number, y: number) => (t > y ? "▲" : t < y ? "▼" : "=");
  // Carryover: items whose wa_id already appeared in yesterday's list.
  let carried = 0;
  try {
    const prev = JSON.parse((await getState(`salman_items_${yesterdayKey()}`)) ?? "[]") as string[];
    carried = items.filter((i) => prev.includes(i.wa_id)).length;
  } catch {
    /* first run */
  }
  return (
    `\u{1F4CA} ${pktDateStr()}\n` +
    `Sales: ${s.sales_t} = Rs ${Number(s.rev_t ?? 0).toLocaleString()} (yday ${s.sales_y} = Rs ${Number(s.rev_y ?? 0).toLocaleString()}) ${arrow(s.sales_t, s.sales_y)}\n` +
    `Leads: ${s.leads_t} (yday ${s.leads_y}) ${arrow(s.leads_t, s.leads_y)}${s.advice_t || s.advice_y ? ` | Advice: ${s.advice_t} (yday ${s.advice_y})` : ""}\n` +
    `Conv: ${pct(s.sales_t, s.leads_t)} (yday ${pct(s.sales_y, s.leads_y)})\n` +
    `Payment stage: ${s.paystage_t} (yday ${s.paystage_y}) ${arrow(s.paystage_t, s.paystage_y)}\n` +
    `API: $${cost.t.toFixed(2)} (yday $${cost.y.toFixed(2)})\n` +
    `Pipeline: ${items.length} open${carried ? `, ${carried} carried from yesterday` : ""}${s.capi_fail ? ` | ⚠ ${s.capi_fail} tracking events FAILED` : ""}`
  );
}

function yesterdayKey(): string {
  const d = new Date(Date.now() - 24 * 3600_000);
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short" });
}

const AOV = 4890;

/** Salman's action list with money at stake and carryover age. */
async function buildSalmanList(): Promise<string> {
  const handled = await getHandledMap();
  const items = (await opsActionItems()).filter((i) => !handled[i.wa_id]);
  if (!items.length) return "✅ Pipeline clear. Nothing pending.";
  let prev: string[] = [];
  try {
    prev = JSON.parse((await getState(`salman_items_${yesterdayKey()}`)) ?? "[]") as string[];
  } catch {
    /* first run */
  }
  const atStake = items.length * AOV;
  const tier: Record<number, string> = { 1: "\u{1F534}", 2: "\u{1F7E0}", 3: "\u{1F7E1}", 4: "\u{26AA}" };
  const lines = items.slice(0, 10).map((i, n) => {
    const old = prev.includes(i.wa_id) ? " (PENDING SINCE YESTERDAY)" : "";
    return `${tier[i.priority] ?? ""} ${n + 1}. ${i.name ?? "?"}: ${i.note}${old}\n   wa.me/${i.wa_id}`;
  });
  try {
    await setState(`salman_items_${pktDateStr()}`, JSON.stringify(items.map((i) => i.wa_id)));
  } catch {
    /* non-fatal */
  }
  return (
    `\u{1F3AF} Action list (${items.length} leads, ~Rs ${atStake.toLocaleString()} on the table)\n` +
    `\u{1F534} verify payment | \u{1F7E0} hot today | \u{1F7E1} cooling (1-3d) | \u{26AA} warm re-open\n` +
    lines.join("\n") +
    (items.length > 10 ? `\n(+${items.length - 10} more, reply "leads")` : "") +
    `\n\nClosed ones show up as sale pings automatically. Dead ones, skip. Everything else needs a touch today.\n\nAfter working a lead, reply: done 92300xxxxxxx\nWhen EVERY item is handled and nothing is left, confirm with: ALL DONE\n\nOther commands: "leads" full list | "sales" last 7d with screenshots | "update" today's report | "chat 92300xxxxxxx" that customer's conversation`
  );
}

/** Salman's EOD pack: action list + gaps + learnings + advice intel. */
async function buildSalmanPack(): Promise<string> {
  const parts: string[] = [await buildSalmanList()];

  const queries = await supportQueriesSince(pktDayStartUtc());
  const gaps = queries.filter((q) => !q.summary.startsWith("Follow-up needed")).slice(0, 5);
  if (gaps.length) {
    parts.push(
      `\u{1F534} Bot needed human help today:\n` +
        gaps.map((q) => `• ${q.name ?? "?"}: ${q.summary.slice(0, 80)}\n  wa.me/${q.wa_id}`).join("\n"),
    );
  }

  try {
    const fu = await followupsSentToday();
    parts.push(`Follow-ups delivered today: ${fu.nudges} nudges, ${fu.reminders} reminders`);
    if (fu.nudges + fu.reminders === 0) parts.push("⚠ ZERO follow-ups today - tell the owner, system may be broken");
  } catch {
    /* non-fatal */
  }

  try {
    const samples = await learningSamples();
    if (samples.length >= 3) {
      const lessons = await analyzeText(
        "You review today's WhatsApp sales chats for Sajawal.School (the bot poses as Salman). Compare WON and LOST conversations. Reply with 3 short bullets only, max 70 words, no preamble: what worked, what killed the lost chats, one concrete change for tomorrow.",
        samples.map((c, i) => `#${i + 1} [${c.label}]\n${c.convo}`).join("\n\n"),
      );
      if (lessons) {
        parts.push(`\u{1F9E0} Learnings:\n${lessons.slice(0, 600)}`);
        await setState(`learnings_${pktDateStr()}`, lessons);
      }
    }
  } catch (err) {
    console.error("Learning section failed:", err);
  }

  try {
    const adv = await adviceSamples();
    if (adv.length >= 3) {
      const insights = await analyzeText(
        "You review today's FREE ADVICE conversations for Sajawal.School. Reply with 3 short bullets, max 60 words, no preamble: top themes people brought, how many showed course interest on their own, one strategic opportunity (ad angle, content idea, or offer gap).",
        adv.map((c, i) => `#${i + 1}\n${c}`).join("\n\n"),
      );
      if (insights) parts.push(`\u{1F4A1} Advice-funnel intel:\n${insights.slice(0, 500)}`);
    }
  } catch (err) {
    console.error("Advice insights failed:", err);
  }

  return parts.join("\n\n");
}

const ownerTargets = (): string[] => [config.ops.adminNumber].filter((n): n is string => Boolean(n));
const supportOnly = (): string[] => [
  ...new Set([config.ops.supportNumber, config.opsAlertNumber].filter((n): n is string => Boolean(n))),
];

/** On-demand "update": owner number gets the brief, support gets the pack. */
export async function sendTeamBrief(_force = false, requester?: string): Promise<boolean> {
  if (requester && requester === config.ops.adminNumber) {
    await sendText(requester, await buildOwnerBrief());
    return true;
  }
  if (requester) {
    await sendText(requester, await buildSalmanPack());
    return true;
  }
  // Scheduled EOD: both, each their own format.
  const brief = await buildOwnerBrief();
  for (const to of ownerTargets()) {
    try {
      await sendText(to, brief);
    } catch (err) {
      console.error("Owner daily failed:", err);
    }
  }
  const pack = await buildSalmanPack();
  for (const to of supportOnly()) {
    try {
      await sendText(to, pack);
    } catch (err) {
      console.error("Salman pack failed:", err);
    }
  }
  return true;
}

/** 23:50 PKT: EOD for both. 10:00 PKT: fresh morning action list for Salman. */
export function startBriefScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const now = pktNow();
      const h = now.getHours();
      const min = now.getMinutes();

      if (h === 23 && min >= 50) {
        const last = await getState(OWNER_STATE_KEY);
        if (last !== pktDateStr()) {
          await sendTeamBrief();
          await setState(OWNER_STATE_KEY, pktDateStr());
          console.log("EOD reports sent");
        }
      }

      if (h === 10) {
        const last = await getState(MORNING_STATE_KEY);
        if (last !== pktDateStr()) {
          const list = await buildSalmanList();
          for (const to of supportOnly()) {
            try {
              await sendText(to, `☀️ Good morning. ${list}`);
            } catch (err) {
              console.error("Morning list failed:", err);
            }
          }
          await setState(MORNING_STATE_KEY, pktDateStr());
          console.log("Morning action list sent");
        }
      }
    } catch (err) {
      console.error("Report scheduler failed:", err);
    }
  };
  void tick();
  return setInterval(tick, 5 * 60 * 1000);
}
