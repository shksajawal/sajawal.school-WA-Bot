import { config } from "../config.js";
import { pool, getState, setState } from "../db.js";
import { sendText } from "../whatsapp.js";

/**
 * Owner alerts (2026-09-13): WhatsApp the owner ONLY when something genuinely
 * needs his eyes. Everything routine lives in the 23:50 brief.
 *
 * Design rules:
 * - Each alert fires at most once per PKT day (cooldown key in bot_state).
 * - Quiet hours: nothing before 09:00 or after 23:00 PKT except system-down.
 * - Thresholds are deliberately conservative; a noisy alert channel is a
 *   channel that gets ignored, which is worse than no channel.
 */

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

async function fireOnce(key: string, message: string): Promise<void> {
  const stamp = `${key}_${pktDateStr()}`;
  if ((await getState(stamp)) === "sent") return;
  const to = config.ops.adminNumber;
  if (!to) return;
  try {
    await sendText(to, message);
    await setState(stamp, "sent");
    console.log(`Owner alert sent: ${key}`);
  } catch (err) {
    console.error(`Owner alert failed (${key}):`, err);
  }
}

async function num(sql: string): Promise<number> {
  const res = await pool.query(sql);
  return Number(res.rows[0]?.n ?? 0);
}

async function checkAll(): Promise<void> {
  const hour = pktHour();

  // 1. SYSTEM DOWN — customers texting, bot not replying. Any hour.
  const hanging = await num(`
    WITH tin AS (
      SELECT m.contact_id, m.created_at FROM messages m
      WHERE m.direction='in' AND m.msg_type='text'
        AND m.created_at BETWEEN now() - interval '90 minutes' AND now() - interval '15 minutes')
    SELECT count(*)::int AS n FROM tin
    WHERE NOT EXISTS (
      SELECT 1 FROM messages o WHERE o.contact_id = tin.contact_id
        AND o.direction='out' AND o.created_at > tin.created_at)`);
  if (hanging >= 15) {
    await fireOnce(
      "alert_system_down",
      `\u{1F6A8} BOT NOT REPLYING: ${hanging} customer messages in the last hour got no response. Something is broken, tell Claude now.`,
    );
  }

  // 2. TRACKING BROKEN — Meta events failing.
  const capiFail = await num(`
    SELECT count(*)::int AS n FROM capi_events
    WHERE NOT success AND created_at > now() - interval '3 hours'`);
  if (capiFail >= 5) {
    await fireOnce(
      "alert_capi",
      `\u{26A0} TRACKING: ${capiFail} Meta conversion events failed in the last 3 hours. Campaign optimisation is losing signal.`,
    );
  }

  if (hour < 9 || hour >= 23) return;

  // 3. BIG SALE — Advance plan closed. Good news deserves a ping.
  const advance = await pool.query(`
    SELECT c.name, p.amount::int AS amt, p.created_at FROM payments p
    JOIN contacts c ON c.id = p.contact_id
    WHERE p.verified AND p.amount >= 8000 AND p.created_at > now() - interval '2 hours'
    ORDER BY p.created_at DESC LIMIT 1`);
  if (advance.rows[0]) {
    const r = advance.rows[0];
    await fireOnce(
      `alert_advance_${r.created_at.toISOString().slice(0, 13)}`,
      `\u{1F389} ADVANCE SALE: Rs ${Number(r.amt).toLocaleString()} closed by the bot (${r.name ?? "?"}).`,
    );
  }

  // 4. FOLLOW-UPS DEAD — the system that recovers 30% of leads is silent.
  if (hour >= 18) {
    const fu = await num(`
      WITH b AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') AS t0)
      SELECT count(*)::int AS n FROM messages, b
      WHERE direction='out' AND created_at >= b.t0
        AND (body LIKE 'Anything I can answer%' OR body LIKE 'Thought to check%' OR body LIKE 'Last Reminder%')`);
    const leads = await num(`
      WITH b AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') AS t0)
      SELECT count(*)::int AS n FROM contacts, b WHERE created_at >= b.t0`);
    if (fu === 0 && leads > 50) {
      await fireOnce(
        "alert_followups_dead",
        `\u{26A0} ZERO follow-ups sent today despite ${leads} leads. The follow-up system may be broken again.`,
      );
    }
  }

  // 5. DRY DAY — real volume, no sales, late in the day.
  if (hour >= 21) {
    const sales = await num(`
      WITH b AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') AS t0)
      SELECT count(*)::int AS n FROM payments, b WHERE verified AND created_at >= b.t0`);
    const leads = await num(`
      WITH b AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') AS t0)
      SELECT count(*)::int AS n FROM contacts, b
      WHERE created_at >= b.t0 AND COALESCE(funnel,'course') <> 'advice'`);
    if (sales === 0 && leads >= 120) {
      await fireOnce(
        "alert_dry_day",
        `\u{26A0} ${leads} leads today, zero sales so far. Worth a look at traffic quality or a check that nothing is stuck.`,
      );
    }
  }

  // 6. MONEY PILING UP — unworked payment-stage leads.
  const stalled = await num(`
    SELECT count(*)::int AS n FROM contacts c
    WHERE c.status = 'payment_pending'
      AND (SELECT max(created_at) FROM messages m WHERE m.contact_id = c.id)
          BETWEEN now() - interval '72 hours' AND now() - interval '2 hours'`);
  if (stalled >= 45) {
    await fireOnce(
      "alert_pipeline",
      `\u{1F4B0} ${stalled} leads have payment details and haven't paid (~Rs ${(stalled * 4890).toLocaleString()} in pipeline). Worth checking the team is working the list.`,
    );
  }

  // 7. COST SPIKE — API spend well above its own recent normal.
  const spike = await pool.query(`
    WITH b AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi') AS t0),
    today AS (
      SELECT coalesce(sum(input_tokens)/1e6*3 + sum(output_tokens)/1e6*15
             + sum(cache_read_tokens)/1e6*0.3 + sum(cache_write_tokens)/1e6*3.75, 0) AS usd
      FROM api_usage, b WHERE created_at >= b.t0),
    prior AS (
      SELECT coalesce(sum(input_tokens)/1e6*3 + sum(output_tokens)/1e6*15
             + sum(cache_read_tokens)/1e6*0.3 + sum(cache_write_tokens)/1e6*3.75, 0) / 7 AS usd
      FROM api_usage, b WHERE created_at >= b.t0 - interval '7 days' AND created_at < b.t0)
    SELECT (SELECT usd FROM today) AS t, (SELECT usd FROM prior) AS p`);
  const t = Number(spike.rows[0]?.t ?? 0);
  const p = Number(spike.rows[0]?.p ?? 0);
  if (p > 1 && t > p * 1.8 && hour >= 14) {
    await fireOnce(
      "alert_cost",
      `\u{26A0} API spend today $${t.toFixed(2)} vs $${p.toFixed(2)}/day average. Something is driving unusual volume.`,
    );
  }
}

/** Checks every 20 minutes. Silent unless something genuinely matters. */
export function startOwnerAlerts(): NodeJS.Timeout {
  const tick = async () => {
    try {
      await checkAll();
    } catch (err) {
      console.error("Owner alerts check failed:", err);
    }
  };
  void tick();
  return setInterval(tick, 20 * 60 * 1000);
}
