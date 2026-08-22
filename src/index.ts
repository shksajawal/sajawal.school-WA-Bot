import { config } from "./config.js";
import { initDb } from "./db.js";
import { buildServer } from "./server.js";
import { startInboundWorker, startReplyWorker } from "./workers/inbound.js";
import { startFollowupWorker } from "./workers/followup.js";

async function main() {
  await initDb();
  console.log("Database ready");

  startInboundWorker();
  startReplyWorker();
  startFollowupWorker();
  console.log("Workers started");

  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
