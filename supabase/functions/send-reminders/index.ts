// @ts-nocheck
// Supabase Edge Function "send-reminders": sends due planner reminders as Web Push notifications.
// Runs every minute via pg_cron (supabase/reminders.sql); ?test=1 from the signed-in owner sends a test notification.
// Secrets (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK. SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY are built in.

// Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID) on plain WebCrypto, so it runs in Node and Deno alike.
const te = new TextEncoder();
const b64u = {
  enc: b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)),
};
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));

async function vapidHeader(endpoint, vapid) {
  const head = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey('jwk', { ...vapid.jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

async function encrypt(p256dh, authSecret, payload) {
  const ua = b64u.dec(p256dh), auth = b64u.dec(authSecret);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hmac(await hmac(auth, shared), cat(te.encode('WebPush: info\0'), ua, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(payload, new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);   // header: salt · rs=4096 · keyid len · keyid
}

async function sendPush(sub, data, vapid) {
  const body = await encrypt(sub.p256dh, sub.auth, te.encode(JSON.stringify(data)));
  return fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { Authorization: await vapidHeader(sub.endpoint, vapid), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
  });
}

// ───────── reminders
const BASE = Deno.env.get('SUPABASE_URL'), SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), ANON = Deno.env.get('SUPABASE_ANON_KEY');
const VAPID = { publicKey: Deno.env.get('VAPID_PUBLIC_KEY'), jwk: JSON.parse(Deno.env.get('VAPID_PRIVATE_JWK') || '{}'), subject: 'https://0c2l2.github.io' };
const TZ = 'Asia/Seoul', TZ_MIN = 540;   // ponytail: fixed UTC+9 for repeat maths (Korea has no DST); store a tz per task if you move

const db = async (path, method = 'GET', body = undefined) => {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  });
  if (!r.ok) throw new Error(`${method} ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
  return method === 'GET' ? r.json() : null;
};

// next occurrence of a repeating start, stepping by Seoul calendar days
const step = (iso, repeat) => {
  const d = new Date(Date.parse(iso) + TZ_MIN * 6e4);   // UTC getters now read Seoul wall time
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === 'weekdays') do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return new Date(+d - TZ_MIN * 6e4).toISOString();
};
const hm = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const before = m => m >= 1440 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m >= 60 ? `${m / 60} h` : `${m} min`;

async function sendAll(subs, data) {
  let sent = 0;
  for (const s of subs) {
    const r = await sendPush(s, data, VAPID);
    if (r.status === 404 || r.status === 410) await db(`push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, 'DELETE');   // device unsubscribed
    else if (r.ok) sent++;
    else console.error('push failed', r.status, await r.text());
  }
  return sent;
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const subs = await db('push_subs?select=endpoint,p256dh,auth');
    if (new URL(req.url).searchParams.has('test')) {   // "Send a test" from the planner: signed-in owner only
      const r = await fetch(`${BASE}/rest/v1/rpc/is_admin`, { method: 'POST', body: '{}', headers: { apikey: ANON, Authorization: req.headers.get('Authorization') || '', 'Content-Type': 'application/json' } });
      if (!r.ok || (await r.json()) !== true) return json({ error: 'owner only' }, 403);
      return json({ sent: await sendAll(subs, { title: 'Planner', body: 'Reminders are working ✓', url: 'planner.html', tag: 'test' }) });
    }
    const now = Date.now();
    const due = await db(`tasks?select=id,kind,title,status,start_at,due_date,repeat,repeat_until,remind_min,remind_at&status=neq.done&remind_at=lte.${new Date(now).toISOString()}`);
    let sent = 0;
    for (const t of due) {
      const m = t.remind_min || 0, occ = new Date(Date.parse(t.remind_at) + m * 6e4).toISOString();
      if (now - Date.parse(t.remind_at) < 6 * 36e5 && subs.length) {   // skip reminders more than 6 h late (e.g. after an outage)
        const body = t.start_at ? (m ? `In ${before(m)} · ${hm(occ)}` : `Starting now · ${hm(occ)}`) : (m >= 1440 ? `Due in ${before(m)}` : 'Due today');
        sent += await sendAll(subs, { title: t.title, body, url: 'planner.html', tag: t.id });
      }
      let next = null;   // repeating events roll on to the next occurrence; tasks get a new one when completed
      if (t.kind === 'event' && t.repeat !== 'none') {
        let o = step(occ, t.repeat);
        while (Date.parse(o) - m * 6e4 <= now) o = step(o, t.repeat);
        const day = new Date(Date.parse(o) + TZ_MIN * 6e4).toISOString().slice(0, 10);
        next = t.repeat_until && day > t.repeat_until ? null : new Date(Date.parse(o) - m * 6e4).toISOString();
      }
      await db(`tasks?id=eq.${t.id}`, 'PATCH', { remind_at: next });
    }
    return json({ due: due.length, sent });
  } catch (e) {
    console.error(e);
    return json({ error: String(e && e.message || e) }, 500);
  }
});
