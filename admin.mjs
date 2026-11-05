// Admin page: the dashboard code is only sent to a logged-in admin. Everyone else gets a small login form.
import { isAdmin, SECURITY_HEADERS } from '../lib/shared.mjs';
import { APP_HTML, LOGIN_HTML } from '../lib/admin-html.mjs';

export default async (req) => new Response(isAdmin(req) ? APP_HTML : LOGIN_HTML, {
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', ...SECURITY_HEADERS }
});

export const config = { path: ['/admin', '/admin/'] };
