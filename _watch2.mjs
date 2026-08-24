import "dotenv/config";
import pg from "pg";
// Failures-only watcher: silent unless a CAPI event fails.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
  max: 2,
});
pool.on("error", () => {});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
let last = 0;
for (let i = 0; i < 5; i++) {
  try { last = Number((await q(`SELECT coalesce(max(id),0) a FROM capi_events`))[0].a); break; }
  catch { await new Promise(r => setTimeout(r, 3000)); }
}
let fails = 0;
while (true) {
  try {
    for (const row of await q(
      `SELECT id, event_name, left(response::text,150) r FROM capi_events WHERE id > $1 AND success = false ORDER BY id`, [last])) {
      console.log(`CAPI FAIL — ${row.event_name}: ${row.r}`);
    }
    const mx = await q(`SELECT coalesce(max(id),0) a FROM capi_events`);
    last = Math.max(last, Number(mx[0].a));
    fails = 0;
  } catch (err) {
    if (++fails === 10) console.log(`watcher: repeated DB errors — ${String(err).slice(0, 80)}`);
  }
  await new Promise(r => setTimeout(r, 60000));
}
