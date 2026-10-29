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

// ---- Free guide signup -------------------------------------------------------
// The PDF lives in KV (key "guide.pdf"), not in the public site, so the email
// form is the only way to get it. Swap the guide with: wrangler kv key put
// guide.pdf --binding LEADS --remote --path <file>
const GUIDE_KEY = 'guide.pdf';
const GUIDE_FILENAME = 'Your-page-live-by-tonight.pdf';
const GUIDE_TITLE = 'Your page, live by tonight';
const GUIDE_FROM = 'Tamir Karp <guide@karpcommunications.com>';
const GUIDE_REPLY_TO = 'info@karpcommunications.com';
// Keep identical to the checkbox label on /creatives/. Stored in each signup notice as the record of what was agreed.
const CONSENT_WORDING =
  "Send me the free guide and add me to Tamir Karp's mailing list. I can unsubscribe at any time.";
const DAILY_CAP = 35; // signups per day; each uses two of Resend's 100 free emails a day
const COOLDOWN_SECONDS = 24 * 60 * 60;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function resendSend(env, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('resend failed', r.status, await r.text());
  return r.ok;
}

// Adds the person to the Resend mailing list (a segment of Shopfront guide signups, kept apart from the
// schools list). Needs RESEND_CONTACTS_KEY (a separate secret from the sending key) and, to keep the list
// separate, RESEND_SEGMENT_ID. Never fails the signup: the info@ notice says what happened.
async function addToList(env, email, name) {
  if (!env.RESEND_CONTACTS_KEY) return 'not set up yet, add by hand';
  try {
    const contact = { email, unsubscribed: false };
    if (name) contact.first_name = name;
    if (env.RESEND_SEGMENT_ID) contact.segments = [{ id: env.RESEND_SEGMENT_ID }];
    const r = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_CONTACTS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(contact),
    });
    if (r.ok) return 'yes';
    console.error('resend contact failed', r.status, await r.text());
  } catch (e) {
    console.error('resend contact error', e);
  }
  return 'FAILED, add by hand';
}

async function guideSignup(body, request, env, cors) {
  const email = String(body.email || '').trim();
  const name = String(body.name || '').trim();
  const emailOk = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email) && email.length <= 254;
  // One consent covers the guide and joining the mailing list; the form says so and the guide comes with the list.
  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on';
  if (!emailOk || !consent || name.length > 120) return reply(400, { ok: false, error: 'invalid' }, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (limited(ip)) return reply(429, { ok: false, error: 'rate' }, cors);
  if (!env.RESEND_API_KEY || !env.LEADS) return reply(500, { ok: false, error: 'config' }, cors);

  // Same address within a day: say yes but send nothing, so the form cannot be used to flood one inbox.
  const sentKey = 'sent:' + (await sha256Hex(email.toLowerCase()));
  if (await env.LEADS.get(sentKey)) return reply(200, { ok: true }, cors);

  const dayKey = 'day:' + new Date().toISOString().slice(0, 10);
  const today = parseInt((await env.LEADS.get(dayKey)) || '0', 10);
  if (today >= DAILY_CAP) return reply(429, { ok: false, error: 'busy' }, cors);

  const pdf = await env.LEADS.get(GUIDE_KEY, 'arrayBuffer');
  if (!pdf) {
    console.error('guide pdf missing from KV');
    return reply(500, { ok: false, error: 'config' }, cors);
  }

  const hello = name ? `Hi ${esc(name)},` : 'Hello,';
  const helloText = name ? `Hi ${name},` : 'Hello,';
  const listText =
    'Reply "stop" at any time and I will remove you.';
  const text =
    `${helloText}\n\nHere is the guide you asked for, attached as a PDF: ${GUIDE_TITLE}.\n\n` +
    'It walks you through getting a one-page website live on your own domain, using AI to write it. ' +
    'Allow three to five hours the first time. Your page can be visible on a free temporary address well before then.\n\n' +
    'If you get stuck, or want to tell me how it went, just reply to this email. It comes straight to me.\n\nTamir\n\n' +
    `--\nYou are getting this because you asked for the guide at karpcommunications.com/creatives and agreed to join my mailing list. ${listText}\n` +
    'Privacy policy: https://karpcommunications.com/privacy/\n';
  const html =
    `<p>${hello}</p><p>Here is the guide you asked for, attached as a PDF: <strong>${esc(GUIDE_TITLE)}</strong>.</p>` +
    '<p>It walks you through getting a one-page website live on your own domain, using AI to write it. ' +
    'Allow three to five hours the first time. Your page can be visible on a free temporary address well before then.</p>' +
    '<p>If you get stuck, or want to tell me how it went, just reply to this email. It comes straight to me.</p><p>Tamir</p>' +
    '<p style="color:#6B7280;font-size:13px;border-top:1px solid #E5E7EB;padding-top:12px">' +
    `You are getting this because you asked for the guide at karpcommunications.com/creatives and agreed to join my mailing list. ${esc(listText)} ` +
    '<a href="https://karpcommunications.com/privacy/">Privacy policy</a>.</p>';

  const sent = await resendSend(env, {
    from: GUIDE_FROM,
    to: [email],
    reply_to: GUIDE_REPLY_TO,
    subject: `Your guide: ${GUIDE_TITLE}`,
    text,
    html,
    attachments: [{ filename: GUIDE_FILENAME, content: toBase64(pdf) }],
  });
  if (!sent) return reply(502, { ok: false, error: 'send' }, cors);

  await env.LEADS.put(sentKey, '1', { expirationTtl: COOLDOWN_SECONDS });
  await env.LEADS.put(dayKey, String(today + 1), { expirationTtl: 2 * COOLDOWN_SECONDS });

  const listStatus = await addToList(env, email, name);

  // The lead record: one email to the inbox per signup, with the consent given. Best effort.
  await resendSend(env, {
    from: env.FORM_FROM || 'Karp Communications Website <forms@karpcommunications.com>',
    to: [env.FORM_TO || 'info@karpcommunications.com'],
    subject: `Guide signup: ${email}`.replace(/[\r\n]+/g, ' ').slice(0, 150),
    text:
      `New guide signup from karpcommunications.com/creatives\n\nEmail: ${email}\nName: ${name || '(not given)'}\n` +
      `Agreed to the guide AND to join the mailing list (marketing, including paid services): yes\n` +
      `Added to the Resend mailing list: ${listStatus}\n` +
      `Consent wording shown: "${CONSENT_WORDING}"\n` +
      `Time: ${new Date().toISOString()}\nGuide sent: ${GUIDE_FILENAME}\n`,
  });

  return reply(200, { ok: true }, cors);
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

    if (body.source === 'guide') return guideSignup(body, request, env, cors);

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
