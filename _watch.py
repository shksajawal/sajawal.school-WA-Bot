import re, ssl, time, urllib.parse
env = dict(l.strip().split("=",1) for l in open("/Users/user/sajawal-whatsapp-bot/.env") if "=" in l and not l.startswith("#"))
m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", env["DATABASE_URL"].strip())
user, pw, host, port, db = m.groups(); pw = urllib.parse.unquote(pw)
import pg8000.native
def connect():
    ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
    return pg8000.native.Connection(user, host=host, port=int(port), database=db, password=pw, ssl_context=ctx)
con = connect(); last = con.run("SELECT coalesce(max(id),0) FROM capi_events")[0][0]
fails = 0
while True:
    try:
        rows = con.run("SELECT id, event_name, success, left(response::text,140) FROM capi_events WHERE id > :l ORDER BY id", l=last)
        for rid, name, ok, resp in rows:
            last = rid
            if ok: print(f"CAPI OK — {name} delivered from Railway", flush=True)
            else:  print(f"CAPI FAIL — {name}: {resp}", flush=True)
        fails = 0
    except Exception as e:
        fails += 1
        try: con.close()
        except Exception: pass
        try: con = connect()
        except Exception: pass
        if fails == 10: print(f"watcher: repeated DB errors — {str(e)[:80]}", flush=True)
    time.sleep(45)
