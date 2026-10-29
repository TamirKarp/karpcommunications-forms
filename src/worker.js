// Receives the Contact and ClearSite order forms from karpcommunications.com
// and emails them to the inbox through Resend. The API key is a Worker secret
// (RESEND_API_KEY) and never reaches the browser.

const ALLOWED_ORIGINS = ['https://karpcommunications.com', 'https://www.karpcommunications.com'];
const SOURCES = { contact: 'Contact form', 'clearsite-order': 'ClearSite order' };

// Best-effort limit per running isolate. Isolates come and go, so this only
// slows a flood; Resend's own limits and the fixed recipient cap the damage.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function reply(status, body, cors) {
  const headers = { ...cors };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed
      ? {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      : {};

    if (request.method === 'OPTIONS') return reply(204, undefined, cors);
    if (request.method !== 'POST') return reply(405, { ok: false, error: 'method' }, cors);
    if (!allowed) return reply(403, { ok: false, error: 'origin' }, cors);

    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return reply(400, { ok: false, error: 'invalid' }, cors);
    }
    if (!body || typeof body !== 'object') return reply(400, { ok: false, error: 'invalid' }, cors);

    // Hidden field a person never fills in. Pretend success so bots move on.
    if (body._gotcha) return reply(200, { ok: true }, cors);

    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const message = String(body.message || '').trim();
    const source = String(body.source || '');

    const emailOk = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email) && email.length <= 254;
    if (!emailOk || !message || message.length > 5000 || name.length > 120 || !SOURCES[source]) {
      return reply(400, { ok: false, error: 'invalid' }, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (limited(ip)) return reply(429, { ok: false, error: 'rate' }, cors);

    if (!env.RESEND_API_KEY) return reply(500, { ok: false, error: 'config' }, cors);

    const to = env.FORM_TO || 'info@karpcommunications.com';
    const from = env.FORM_FROM || 'Karp Communications Website <forms@karpcommunications.com>';
    const label = SOURCES[source];
    const html =
      `<p><strong>${esc(label)}</strong> from karpcommunications.com</p>` +
      `<p><strong>Name:</strong> ${esc(name) || '(not given)'}<br>` +
      `<strong>Email:</strong> ${esc(email)}</p>` +
      `<p style="white-space:pre-wrap">${esc(message)}</p>`;
    const text = `${label} from karpcommunications.com\n\nName: ${name || '(not given)'}\nEmail: ${email}\n\n${message}\n`;

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [to],
          reply_to: email,
          subject: `${label}: ${name || email}`.replace(/[\r\n]+/g, ' ').slice(0, 150),
          html,
          text,
        }),
      });
      if (!r.ok) {
        console.error('resend failed', r.status, await r.text());
        return reply(502, { ok: false, error: 'send' }, cors);
      }
      return reply(200, { ok: true }, cors);
    } catch (e) {
      console.error('resend error', e);
      return reply(502, { ok: false, error: 'send' }, cors);
    }
  },
};
