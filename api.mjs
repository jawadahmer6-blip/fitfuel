// FIT FUEL API — Netlify Function (all routes under /api/*)
import crypto from 'node:crypto';
import { db, HttpErr, PCTS, DATE, today, adminConfigured, adminUser, mkToken, checkLogin, isAdmin, sessionCookie, safeEq,
         hit, isBlocked, clearHits, clientIp, uaeMobile, json } from '../lib/shared.mjs';

const getSetting = async (k, d) => { const r = await db().sql`select value from settings where key = ${k}`; return r.length ? r[0].value : d; };
const setSetting = (k, v) => db().sql`insert into settings (key, value) values (${k}, ${String(v)}) on conflict (key) do update set value = excluded.value`;

async function checkCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  const [c] = await db().sql`select * from codes where code = ${code}`;
  if (!c) return { err: 'Invalid promo code.' };
  if (!c.active) return { err: 'This code is not active.' };
  if (c.exp && c.exp < today()) return { err: 'This code has expired.' };
  if (c.max_uses && c.used >= c.max_uses) return { err: 'This code has reached its usage limit.' };
  return { c };
}
const pubCode = c => ({ code: c.code, sponsor: c.sponsor, pct: c.pct, max: c.max_uses, exp: c.exp, used: c.used, active: !!c.active });

function cleanDays(days) {
  if (!Array.isArray(days) || !days.length || days.length > 45) throw new HttpErr(400, 'Invalid delivery days.');
  return days.map(d => { if (!d || !DATE.test(d.d) || typeof d.picks !== 'object' || d.picks === null) throw new HttpErr(400, 'Invalid delivery day.'); return { d: d.d, skip: !!d.skip, picks: d.picks }; });
}
const publicSub = row => ({ ...row.data, id: row.id, status: row.status });

async function ownSub(req, id) {
  const [row] = await db().sql`select * from subs where id = ${id}`;
  if (!row || !safeEq(req.headers.get('x-sub') || '', row.token)) throw new HttpErr(404, 'Subscription not found.');
  return row;
}
function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpErr(401, 'Please log in.');
  if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'ff-admin') throw new HttpErr(403, 'Blocked.'); // CSRF guard
}

async function route(req, context, path, method, body) {
  const ip = clientIp(req, context);
  const str = (v, n) => String(v || '').trim().slice(0, n);

  /* ---------- public ---------- */
  if (path === '/health' && method === 'GET') return json(200, { ok: true });
  if (path === '/offers' && method === 'GET') return json(200, { pct: +(await getSetting('site_pct', 0)), scope: await getSetting('site_scope', 'first') });

  if (path === '/promo/validate' && method === 'POST') {
    if (await hit('promo:' + ip, 30, 600)) throw new HttpErr(429, 'Too many attempts. Try again in 10 minutes.');
    const x = await checkCode(body.code); if (x.err) throw new HttpErr(400, x.err);
    return json(200, { code: x.c.code, pct: x.c.pct });
  }

  if (path === '/subscriptions' && method === 'POST') {
    if (await hit('sub:' + ip, 40, 600)) throw new HttpErr(429, 'Too many attempts. Try again in 10 minutes.');
    const sub = body.sub || {};
    const name = str(sub.name, 80), phone = uaeMobile(sub.phone), address = str(sub.address, 300);
    if (name.length < 2 || !phone || address.length < 5) throw new HttpErr(400, 'Name, a valid UAE mobile number and address are required.');
    const days = cleanDays(sub.days);
    const id = 'FF-' + crypto.randomBytes(3).toString('hex').toUpperCase(), token = crypto.randomBytes(16).toString('hex');
    const sitePct = +(await getSetting('site_pct', 0));
    const client = await db().pool.connect();
    let pct = sitePct;
    try {
      await client.query('BEGIN');
      let code = '';
      if (body.promo) {
        const c = String(body.promo).trim().toUpperCase();
        const chk = await checkCode(c); if (chk.err) throw new HttpErr(400, chk.err);
        const u = await client.query('update codes set used = used + 1 where code = $1 and active and (max_uses = 0 or used < max_uses) returning pct, code', [c]);
        if (!u.rowCount) throw new HttpErr(400, 'This code has reached its usage limit.');
        pct = Math.max(sitePct, u.rows[0].pct); code = u.rows[0].code;
      }
      const data = { plan: +sub.plan, meals: +sub.meals, diet: str(sub.diet, 30), zone: str(sub.zone, 80), slot: str(sub.slot, 20),
        alg: (Array.isArray(sub.alg) ? sub.alg : []).map(a => str(a, 20)).slice(0, 10), excl: str(sub.excl, 200),
        total: +sub.total || 0, renewAmt: +sub.renewAmt || 0, pct, code, renew: true, paused: false, next: str(sub.next, 10),
        name, phone, address, days, created: new Date().toISOString() };
      await client.query('insert into subs (id, token, data) values ($1, $2, $3::jsonb)', [id, token, JSON.stringify(data)]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    return json(201, { id, token, pct });
  }

  let m;
  if ((m = path.match(/^\/subscriptions\/([A-Za-z0-9-]+)$/))) {
    if (method === 'GET') return json(200, { sub: publicSub(await ownSub(req, m[1])) });
    if (method === 'PUT') { // customers may only change days / renew / pause / cancel — never prices
      const row = await ownSub(req, m[1]), cur = row.data, b = body.sub || {};
      if (b.days) cur.days = cleanDays(b.days);
      if ('renew' in b) cur.renew = !!b.renew;
      if ('paused' in b) cur.paused = !!b.paused;
      const status = ['active', 'cancelled'].includes(b.status) ? b.status : row.status;
      await db().sql`update subs set data = ${JSON.stringify(cur)}::jsonb, status = ${status} where id = ${row.id}`;
      return json(200, { ok: true });
    }
  }

  /* ---------- admin ---------- */
  if (path === '/admin/login' && method === 'POST') {
    if (!adminConfigured()) throw new HttpErr(503, 'Admin is not configured. Set ADMIN_PASSWORD (10+ chars) and SECRET (20+ chars) in the Netlify environment variables.');
    if (await isBlocked('login:' + ip, 5, 600)) throw new HttpErr(429, 'Too many attempts. Try again in 10 minutes.');
    if (!checkLogin(body.user, body.password)) {
      await hit('login:' + ip, 5, 600);
      await new Promise(r => setTimeout(r, 500));
      throw new HttpErr(401, 'Wrong username or password.');
    }
    await clearHits('login:' + ip);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, mkToken(), 12 * 3600) });
  }
  if (path === '/admin/logout' && method === 'POST') return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  if (path === '/admin/me' && method === 'GET') { requireAdmin(req); return json(200, { ok: true, user: adminUser() }); }

  if (path === '/offers' && method === 'PUT') {
    requireAdmin(req);
    const pct = +body.pct, scope = body.scope;
    if (pct !== 0 && !PCTS.includes(pct)) throw new HttpErr(400, 'Discount must be 10, 15, 20 or 25.');
    if (!['first', 'all'].includes(scope)) throw new HttpErr(400, 'Invalid scope.');
    await setSetting('site_pct', pct); await setSetting('site_scope', scope);
    return json(200, { pct, scope });
  }
  if (path === '/codes' && method === 'GET') { requireAdmin(req); return json(200, { codes: (await db().sql`select * from codes order by created desc`).map(pubCode) }); }
  if (path === '/codes' && method === 'POST') {
    requireAdmin(req);
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), pct = +body.pct, max = Math.max(0, parseInt(body.max) || 0), exp = String(body.exp || '');
    if (code.length < 3 || code.length > 20) throw new HttpErr(400, 'Code must have 3–20 letters or numbers.');
    if (!PCTS.includes(pct)) throw new HttpErr(400, 'Discount must be 10, 15, 20 or 25.');
    if (exp && !DATE.test(exp)) throw new HttpErr(400, 'Invalid expiry date.');
    if ((await db().sql`select 1 from codes where code = ${code}`).length) throw new HttpErr(409, 'That code already exists.');
    await db().sql`insert into codes (code, sponsor, pct, max_uses, exp) values (${code}, ${String(body.sponsor || '').slice(0, 60)}, ${pct}, ${max}, ${exp})`;
    return json(201, { code });
  }
  if ((m = path.match(/^\/codes\/([A-Za-z0-9]+)$/))) {
    requireAdmin(req);
    const code = m[1].toUpperCase();
    if (method === 'PATCH') { await db().sql`update codes set active = ${!!body.active} where code = ${code}`; return json(200, { ok: true }); }
    if (method === 'DELETE') { await db().sql`delete from codes where code = ${code}`; return json(200, { ok: true }); }
  }
  if (path === '/subscriptions' && method === 'GET') { requireAdmin(req); return json(200, { subs: (await db().sql`select * from subs order by created desc limit 1000`).map(publicSub) }); }

  throw new HttpErr(404, 'Not found.');
}

export default async (req, context) => {
  try {
    const path = new URL(req.url).pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const method = req.method;
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      const text = await req.text();
      if (text.length > 200_000) throw new HttpErr(413, 'Request too large.');
      if (text) { try { body = JSON.parse(text); } catch { throw new HttpErr(400, 'Invalid JSON.'); } }
    }
    return await route(req, context, path, method, body);
  } catch (e) {
    if (!(e instanceof HttpErr)) console.error(e);
    return json(e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
};

export const config = { path: '/api/*' };
