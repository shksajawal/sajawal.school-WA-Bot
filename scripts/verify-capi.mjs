/**
 * Meta CAPI access diagnostic.
 *
 * Answers the one question the Graph error refuses to: is the dataset ID wrong,
 * or does the token lack permission on it? Never prints token values.
 *
 *   node scripts/verify-capi.mjs           read-only checks
 *   node scripts/verify-capi.mjs --send    also fires one real test event
 */
import "dotenv/config";

const clean = (v) => {
  if (!v) return undefined;
  const s = v.trim().replace(/^["']+|["']+$/g, "").trim();
  return s === "" ? undefined : s;
};

const GRAPH = clean(process.env.GRAPH_VERSION) ?? "v23.0";
const DATASET = clean(process.env.META_DATASET_ID);
const CAPI_TOKEN = clean(process.env.META_CAPI_ACCESS_TOKEN);
const WA_TOKEN = clean(process.env.WA_ACCESS_TOKEN);
const TOKEN = CAPI_TOKEN ?? WA_TOKEN;
const WABA = clean(process.env.WA_WABA_ID);
const TEST_CODE = clean(process.env.META_TEST_EVENT_CODE);
const SEND = process.argv.includes("--send");

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const warn = (m) => console.log(`  \x1b[33mWARN\x1b[0m  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const get = async (path) => {
  const url = `https://graph.facebook.com/${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};

console.log(`\nMeta CAPI diagnostic — Graph ${GRAPH}`);

// ---------------------------------------------------------------- env presence
head("1. Environment");
if (!TOKEN) {
  fail("No token found. Set META_CAPI_ACCESS_TOKEN (preferred) or WA_ACCESS_TOKEN in .env");
  process.exit(1);
}
if (!DATASET) {
  fail("META_DATASET_ID is not set in .env");
  process.exit(1);
}
pass(`META_DATASET_ID = ${DATASET}`);
if (CAPI_TOKEN) {
  pass("Using a dedicated META_CAPI_ACCESS_TOKEN");
} else {
  warn("META_CAPI_ACCESS_TOKEN is NOT set — falling back to WA_ACCESS_TOKEN.");
  warn("The WhatsApp token usually lacks ads_management on the dataset. This is the most likely root cause.");
}
if (WABA) pass(`WA_WABA_ID = ${WABA}`); else warn("WA_WABA_ID not set — business_messaging events need it");

// ------------------------------------------------------------------ token info
head("2. Token identity and scopes");
const me = await get("me?fields=id,name");
if (me.ok) {
  pass(`Token is valid. Identity: ${me.json.name ?? "(unnamed)"} (id ${me.json.id})`);
} else {
  fail(`Token rejected: ${JSON.stringify(me.json?.error?.message ?? me.json)}`);
  console.log("\n  → Token is expired or malformed. Generate a new System User token.\n");
  process.exit(1);
}

const dbg = await get(`debug_token?input_token=${encodeURIComponent(TOKEN)}`);
if (dbg.ok && dbg.json?.data) {
  const d = dbg.json.data;
  const scopes = d.scopes ?? [];
  pass(`Token type: ${d.type ?? "unknown"}${d.expires_at === 0 ? " (never expires)" : d.expires_at ? ` (expires ${new Date(d.expires_at * 1000).toISOString()})` : ""}`);
  if (scopes.length) {
    console.log(`        scopes: ${scopes.join(", ")}`);
    for (const need of ["ads_management", "business_management"]) {
      scopes.includes(need) ? pass(`scope ${need} present`) : fail(`scope ${need} MISSING — required to post to a dataset`);
    }
  } else {
    warn("Could not read scopes from debug_token");
  }
  if (d.expires_at && d.expires_at !== 0 && d.expires_at * 1000 < Date.now()) fail("TOKEN HAS EXPIRED");
} else {
  warn("debug_token unavailable with this token (not fatal)");
}

// --------------------------------------------------------------- dataset check
head("3. Dataset reachability");
const ds = await get(`${DATASET}?fields=id,name,owner_business{id,name}`);
if (ds.ok) {
  pass(`Dataset reachable: "${ds.json.name}" (id ${ds.json.id})`);
  if (ds.json.owner_business) {
    pass(`Owned by Business: ${ds.json.owner_business.name} (id ${ds.json.owner_business.id})`);
  } else {
    warn("No owner_business returned — token may see it without asset assignment");
  }
} else {
  const e = ds.json?.error ?? {};
  fail(`Cannot read dataset ${DATASET}: [${e.code}/${e.error_subcode ?? "-"}] ${e.message}`);
  console.log("\n  → Either this ID is not a Dataset, or the token has no asset access to it.");
  console.log("    Events Manager → Data sources → click the dataset → the ID under its name is the correct one.");
  console.log("    Then: Business Settings → Users → System users → your user → Add assets → Data sources → select it → enable Manage.\n");
}

// ----------------------------------------------------- WABA linkage (best effort)
if (WABA) {
  head("4. WhatsApp account linkage");
  const waba = await get(`${WABA}?fields=id,name,owner_business_info`);
  if (waba.ok) {
    pass(`WABA reachable: ${waba.json.name ?? WABA}`);
    const wb = waba.json.owner_business_info;
    if (wb && ds.ok && ds.json.owner_business && wb.id !== ds.json.owner_business.id) {
      fail(`WABA business (${wb.id}) differs from dataset business (${ds.json.owner_business.id}) — cross-business CAPI will be rejected`);
    } else if (wb) {
      pass(`WABA business: ${wb.name ?? wb.id}`);
    }
  } else {
    warn(`Cannot read WABA: ${waba.json?.error?.message}`);
  }
}

// ------------------------------------------------------------------ live send
head(SEND ? "5. Live test event" : "5. Live test event (skipped)");
if (!SEND) {
  console.log("  Re-run with --send to fire one real event and confirm end to end.");
} else {
  const body = {
    data: [{
      event_name: "Contact",
      event_time: Math.floor(Date.now() / 1000),
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      event_id: `diagnostic:${Math.floor(Date.now() / 1000)}`,
      user_data: {
        ...(WABA ? { whatsapp_business_account_id: WABA } : {}),
        ...(clean(process.env.META_PAGE_ID) ? { page_id: clean(process.env.META_PAGE_ID) } : {}),
        ph: ["0000000000000000000000000000000000000000000000000000000000000000"],
      },
    }],
    ...(TEST_CODE ? { test_event_code: TEST_CODE } : {}),
  };
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH}/${DATASET}/events?access_token=${encodeURIComponent(TOKEN)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = await res.json().catch(() => ({}));
  if (res.ok) {
    pass(`Event accepted. events_received=${json.events_received}`);
    console.log("  → CAPI is working. Restart the Railway service and real events will flow.");
  } else {
    fail(`Event rejected [${json?.error?.code}/${json?.error?.error_subcode ?? "-"}]: ${json?.error?.message}`);
  }
  if (!TEST_CODE) warn("No META_TEST_EVENT_CODE set — this event landed in live data, not Test Events");
}

console.log("");
