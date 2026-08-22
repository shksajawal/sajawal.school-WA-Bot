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

async function main() {
  await initDb();
  console.log("Database ready");

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
