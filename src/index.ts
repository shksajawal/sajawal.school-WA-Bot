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

  // Recovery sweep: any contact whose last inbound text is unanswered and
  // still inside the free 24h window gets a reply enqueued on boot. Added
  // after the operator-note bug silenced advice leads (2026-09-10).
  void (async () => {
    try {
      const { pool } = await import("./db.js");
      const res = await pool.query(
        `WITH last_in AS (
           SELECT DISTINCT ON (m.contact_id) m.contact_id, m.id, m.created_at
           FROM messages m
           WHERE m.direction='in' AND m.msg_type='text'
             AND m.created_at > now() - interval '23 hours'
           ORDER BY m.contact_id, m.created_at DESC)
         SELECT li.contact_id, li.id FROM last_in li
         WHERE NOT EXISTS (
           SELECT 1 FROM messages o WHERE o.contact_id = li.contact_id
             AND o.direction='out' AND o.created_at > li.created_at)
         LIMIT 300`,
      );
      const { enqueueReply } = await import("./queue.js");
      for (const row of res.rows) {
        await enqueueReply({ contactId: row.contact_id, afterMessageId: row.id });
      }
      if (res.rows.length) console.log(`Recovery: enqueued replies for ${res.rows.length} hanging conversations`);
    } catch (err) {
      console.error("Recovery sweep failed:", err);
    }
  })();

  loud(startInboundWorker());
  loud(startReplyWorker());
  loud(startFollowupWorker());
  startBriefScheduler();
  console.log("Workers started (team brief scheduler armed)");

  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
