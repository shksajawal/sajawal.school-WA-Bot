import type { Worker } from "bullmq";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { buildServer } from "./server.js";
import { startInboundWorker, startReplyWorker } from "./workers/inbound.js";
import { startFollowupWorker } from "./workers/followup.js";
import { startBriefScheduler } from "./workers/digest.js";

function loud(worker: Worker): Worker {
  worker.on("failed", (job, err) => {
    console.error(`[${worker.name}] job ${job?.id} FAILED:`, err);
  });
  worker.on("error", (err) => {
    console.error(`[${worker.name}] worker error:`, err);
  });
  return worker;
}

/**
 * CAPI failures are deliberately non-fatal so ad reporting can never break a live
 * sales conversation. The cost is silence — a misconfigured dataset drops every
 * event for days without a symptom. Say it once, loudly, at boot.
 */
function checkCapiConfig(): void {
  const problems: string[] = [];
  if (!config.capi.pageId) {
    problems.push("META_PAGE_ID is not set — Meta rejects business_messaging events without a page_id");
  }
  if (config.capi.testEventCode) {
    problems.push(`META_TEST_EVENT_CODE is set (${config.capi.testEventCode}) — events go to Test Events, NOT live reporting`);
  }
  if (problems.length) {
    console.warn("\n=== CAPI CONFIG WARNING ===");
    for (const p of problems) console.warn(`  ! ${p}`);
    console.warn("  Conversion tracking is degraded. Chat still works.");
    console.warn("  Diagnose with: npm run verify:capi\n");
  } else {
    console.log(`CAPI configured — dataset ${config.capi.datasetId}, page ${config.capi.pageId}`);
  }
}

async function main() {
  await initDb();
  console.log("Database ready");

  checkCapiConfig();

  // Self-healing recovery sweep: every 15 minutes, any contact whose last
  // inbound text is unanswered and still inside the free 24h window gets a
  // reply enqueued. Boot-only was not enough — the 2026-09-14 credit lapse
  // stranded 34 conversations because nothing retried after the outage ended.
  const recoverySweep = async () => {
    try {
      const { pool } = await import("./db.js");
      // Outage guard (2026-10-11): while Meta is failing deliveries broadly
      // (billing blocks on Oct 2 and Oct 9), retrying only burns attempts.
      // Pause until delivery recovers, then everyone in-window gets retried.
      const health = await pool.query(
        `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*)::int AS total
         FROM message_status
         WHERE created_at > now() - interval '30 minutes'
           AND status IN ('delivered', 'read', 'failed')
           AND coalesce(error_code, 0) <> 131047`,
      );
      const { failed, total } = health.rows[0] ?? { failed: 0, total: 0 };
      if (failed >= 5 && failed / Math.max(total, 1) >= 0.25) {
        console.warn(`Recovery sweep paused: Meta failed ${failed}/${total} deliveries in 30 min`);
        return;
      }
      const res = await pool.query(
        `WITH last_in AS (
           SELECT DISTINCT ON (m.contact_id) m.contact_id, m.id, m.created_at
           FROM messages m
           WHERE m.direction='in' AND m.msg_type='text'
             AND m.created_at > now() - interval '23 hours'
           ORDER BY m.contact_id, m.created_at DESC)
         SELECT li.contact_id, li.id,
           EXISTS (SELECT 1 FROM messages f JOIN message_status s ON s.wa_message_id = f.wa_message_id
                   WHERE f.contact_id = li.contact_id AND f.direction='out'
                     AND f.created_at > li.created_at AND s.status='failed') AS recovered
         FROM last_in li
         WHERE li.created_at < now() - interval '5 minutes'
           -- A reply Meta failed to deliver (2026-10 billing outage) is not an
           -- answer. Only replies with no 'failed' receipt count.
           AND NOT EXISTS (
             SELECT 1 FROM messages o WHERE o.contact_id = li.contact_id
               AND o.direction='out' AND o.created_at > li.created_at
               AND NOT EXISTS (SELECT 1 FROM message_status s
                               WHERE s.wa_message_id = o.wa_message_id AND s.status='failed'))
           -- Cap per contact: 3 failed attempts in the last 2 hours. Counting
           -- only recent failures means an outage that has ended (guard above)
           -- no longer blocks the retry; a contact Meta keeps rejecting still stops.
           AND (SELECT count(*) FROM messages f JOIN message_status s ON s.wa_message_id = f.wa_message_id
                WHERE f.contact_id = li.contact_id AND f.direction='out'
                  AND f.created_at > li.created_at AND s.status='failed'
                  AND f.created_at > now() - interval '2 hours') < 3
         LIMIT 300`,
      );
      if (!res.rows.length) return;
      const { enqueueReply } = await import("./queue.js");
      for (const row of res.rows) {
        await enqueueReply({ contactId: row.contact_id, afterMessageId: row.id, recovered: row.recovered });
      }
      console.log(`Recovery sweep: enqueued replies for ${res.rows.length} hanging conversations`);
    } catch (err) {
      console.error("Recovery sweep failed:", err);
    }
  };
  void recoverySweep();
  setInterval(recoverySweep, 15 * 60 * 1000);

  loud(startInboundWorker());
  loud(startReplyWorker());
  loud(startFollowupWorker());
  startBriefScheduler();
  const { startOpsKeepalive } = await import("./ops.js");
  startOpsKeepalive();
  const { startOwnerAlerts } = await import("./workers/alerts.js");
  startOwnerAlerts();
  console.log("Workers started (team brief scheduler armed)");

  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
