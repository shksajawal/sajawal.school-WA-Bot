import type { Worker } from "bullmq";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { buildServer } from "./server.js";
import { startInboundWorker, startReplyWorker } from "./workers/inbound.js";
import { startFollowupWorker } from "./workers/followup.js";

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

  loud(startInboundWorker());
  loud(startReplyWorker());
  loud(startFollowupWorker());
  console.log("Workers started");

  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
