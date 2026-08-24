import "dotenv/config";
import pg from "pg";
// Pool + per-query connections: Supabase's pooler drops idle sockets, so a
// long-lived Client dies. A pool reconnects transparently.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
  max: 2,
});
pool.on("error", () => {});
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

let lastEv = 0, lastMsg = 0;
for (let i = 0; i < 5; i++) {
  try {
    lastEv = Number((await q(`SELECT coalesce(max(id),0) a FROM capi_events`))[0].a);
    lastMsg = Number((await q(`SELECT coalesce(max(id),0) a FROM messages`))[0].a);
    console.log(`watcher armed (capi_event>${lastEv}, message>${lastMsg})`);
    break;
  } catch { await new Promise(r => setTimeout(r, 3000)); }
}

let fails = 0;
while (true) {
  try {
    for (const row of await q(`SELECT id,event_name,success,left(response::text,140) r FROM capi_events WHERE id>$1 ORDER BY id`, [lastEv])) {
      lastEv = Number(row.id);
      console.log(row.success
        ? `CAPI OK — ${row.event_name} fired from RAILWAY (row ${row.id})`
        : `CAPI FAIL — ${row.event_name}: ${row.r}`);
    }
    for (const row of await q(`SELECT id,direction,left(coalesce(body,''),70) b FROM messages WHERE id>$1 ORDER BY id`, [lastMsg])) {
      lastMsg = Number(row.id);
      if (row.direction === 'in') console.log(`INBOUND: ${row.b}`);
    }
    fails = 0;
  } catch (err) {
    if (++fails === 6) console.log(`watcher: 6 consecutive DB failures — ${String(err).slice(0, 70)}`);
  }
  await new Promise(r => setTimeout(r, 20000));
}
