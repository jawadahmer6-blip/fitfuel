// Shared helpers for the FIT FUEL Netlify functions
import crypto from 'node:crypto';
import { getDatabase } from '@netlify/database';

let _db;
/** Netlify Database client. (globalThis.__FF_DB__ is only a hook for automated tests.) */
export const db = () => globalThis.__FF_DB__ || (_db ??= getDatabase());

export class HttpErr extends Error { constructor(status, message) { super(message); this.status = status; } }

export const PCTS = [10, 15, 20, 25];
export const DATE = /^\d{4}-\d\d-\d\d$/;
export const today = () => new Date().toISOString().slice(0, 10);

/* ---------- admin auth (signed, expiring session in an HttpOnly cookie) ---------- */
const ADMIN_USER = () => process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = () => process.env.ADMIN_PASSWORD || '';
const SECRET = () => process.env.SECRET || '';
export const adminConfigured = () => ADMIN_PASSWORD().length >= 10 && SECRET().length >= 20;
export const adminUser = ADMIN_USER;

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
export const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = t => crypto.createHmac('sha256', SECRET()).update(t + '|' + ADMIN_USER() + '|' + sha(ADMIN_PASSWORD()).toString('hex')).digest('hex');
export const mkToken = () => { const t = Date.now() + '.' + crypto.randomBytes(8).toString('hex'); return t + '.' + sign(t); };
export const checkLogin = (user, password) => (safeEq(user, ADMIN_USER()) & safeEq(password, ADMIN_PASSWORD())) === 1;

export const cookie = (req, name) => {
  const m = ('; ' + (req.headers.get('cookie') || '')).split('; ' + name + '=');
  return m.length > 1 ? decodeURIComponent(m[1].split(';')[0]) : '';
};
export const isAdmin = req => {
  if (!adminConfigured()) return false;
  const p = cookie(req, 'ff_admin').split('.');
  if (p.length !== 3) return false;
  return Date.now() - +p[0] < 12 * 3600e3 && safeEq(p[2], sign(p[0] + '.' + p[1]));
};
export const sessionCookie = (req, value, maxAge) =>
  'ff_admin=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge +
  (new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https' ? '; Secure' : '');

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
};

/* ---------- rate limiting (stored in the database: works across serverless instances) ---------- */
export const clientIp = (req, context) => (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
/** count a hit; returns true when `max` is exceeded within the window */
export async function hit(key, max, windowSec) {
  const [r] = await db().sql`
    insert into rate_limits (key, n, window_start) values (${key}, 1, now())
    on conflict (key) do update set
      n = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.n + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.window_start end
    returning n`;
  return r.n > max;
}
export async function isBlocked(key, max, windowSec) {
  const rows = await db().sql`select n from rate_limits where key = ${key} and window_start > now() - make_interval(secs => ${windowSec})`;
  return rows.length > 0 && rows[0].n >= max;
}
export const clearHits = key => db().sql`delete from rate_limits where key = ${key}`;

/* ---------- UAE mobile numbers ---------- */
/** 05X XXX XXXX / +971 5X XXX XXXX → '+971 5X XXX XXXX' (null if invalid) */
export function uaeMobile(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00971')) d = d.slice(5); else if (d.startsWith('971')) d = d.slice(3); else if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? '+971 ' + d.slice(0, 2) + ' ' + d.slice(2, 5) + ' ' + d.slice(5) : null;
}

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra } });
}
