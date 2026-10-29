// Receives the Contact and ClearSite order forms from karpcommunications.com
// and emails them to the inbox through Resend. The API key stays here, in the
// RESEND_API_KEY environment variable, and never reaches the browser.

const ALLOWED_ORIGINS = ['https://karpcommunications.com', 'https://www.karpcommunications.com'];
const SOURCES = { contact: 'Contact form', 'clearsite-order': 'ClearSite order' };

const TO = process.env.FORM_TO || 'info@karpcommunications.com';
const FROM = process.env.FORM_FROM || 'Karp Communications Website <forms@karpcommunications.com>';

// Best-effort limit per warm instance. Instances are short-lived, so this only
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

function send(res, status, body) {
  res.status(status).json(body);
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
  if (!ALLOWED_ORIGINS.includes(origin)) return send(res, 403, { ok: false, error: 'origin' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const message = String(body.message || '').trim();
  const source = String(body.source || '');

  // Hidden field a person never fills in. Pretend success so bots move on.
  if (body._gotcha) return send(res, 200, { ok: true });

  const emailOk = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email) && email.length <= 254;
  if (!emailOk || !message || message.length > 5000 || name.length > 120 || !SOURCES[source]) {
    return send(res, 400, { ok: false, error: 'invalid' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return send(res, 429, { ok: false, error: 'rate' });

  if (!process.env.RESEND_API_KEY) return send(res, 500, { ok: false, error: 'config' });

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
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email,
        subject: `${label}: ${name || email}`.replace(/[\r\n]+/g, ' ').slice(0, 150),
        html,
        text,
      }),
    });
    if (!r.ok) {
      console.error('resend failed', r.status, await r.text());
      return send(res, 502, { ok: false, error: 'send' });
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('resend error', e);
    return send(res, 502, { ok: false, error: 'send' });
  }
};

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}
