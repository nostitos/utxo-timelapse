// Anonymous feedback is delivered only to the configured project mailbox.
// No visitor messages, reply addresses or IP addresses are persisted or logged.
const ORIGINS = new Set(['https://bitcointimelapse.com', 'https://www.bitcointimelapse.com', 'https://utxo.aiception.ai', 'https://nostitos.github.io']);
const categories = { idea: 'Feature idea', bug: 'Bug report', other: 'Feedback' };
const recent = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_BODY = 20000;
const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

function allowedOrigin(origin) {
  if (ORIGINS.has(origin)) return true;
  // The native explorer is served by a loopback HTTP server.
  try { const u = new URL(origin); return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.origin === origin; }
  catch { return false; }
}

async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new Error('large');
  if (!request.body) throw new Error('invalid');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new Error('large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
}

function allowMessage(ip) {
  const now = Date.now();
  for (const [key, entry] of recent) if (now - entry.at >= WINDOW) recent.delete(key);
  let entry = recent.get(ip);
  if (!entry) {
    if (recent.size >= 10000) return false;
    entry = {at:now, count:0};
    recent.set(ip, entry);
  }
  return ++entry.count <= 4;
}

export async function feedbackResponse(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {'Content-Type':'application/json', 'Cache-Control':'no-store', Vary:'Origin'};
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {status, headers:{...headers, ...extra}});
  if (!allowedOrigin(origin)) return reply(403, {error:'Please send feedback from the website.'});
  headers['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS') return reply(204, null, {'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Max-Age':'600'});
  if (request.method !== 'POST') return reply(405, {error:'Method not allowed.'}, {Allow:'POST, OPTIONS'});
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return reply(415, {error:'Please send feedback using the form.'});
  let data;
  try { data = await readBody(request); }
  catch (e) { return reply(e.message === 'large' ? 413 : 400, {error:'Please keep your message under 4,000 characters.'}); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400, {error:'Invalid feedback.'});
  if (data.website) return reply(200, {ok:true}); // Quiet honeypot; no email is sent.
  const category = typeof data.category === 'string' && Object.hasOwn(categories, data.category) ? data.category : null;
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  if (data.email != null && typeof data.email !== 'string') return reply(400, {error:'Please check your email address, or leave it blank.'});
  if (!category || !message || message.length > 4000 || /\u0000/.test(message)) return reply(400, {error:'Please write a message of 1–4,000 characters.'});
  if (email && (email.length > 254 || !emailPattern.test(email))) return reply(400, {error:'Please check your email address, or leave it blank.'});
  if (data.source !== 'guide' && data.source !== 'explorer') return reply(400, {error:'Invalid feedback source.'});
  if (data.block != null && (!Number.isSafeInteger(data.block) || data.block < 0 || data.block > 10000000)) return reply(400, {error:'Invalid block number.'});
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!allowMessage(ip)) return reply(429, {error:'Please wait a few minutes before sending another message.'}, {'Retry-After':'600'});
  if (!env.FEEDBACK_EMAIL || !emailPattern.test(env.FEEDBACK_TO || '') || !emailPattern.test(env.FEEDBACK_FROM || '')) return reply(503, {error:'Feedback delivery is temporarily unavailable. Your message is still here; please try again later.'});
  const view = data.source === 'explorer' && data.block != null
    ? `https://bitcointimelapse.com/explorer?block=${data.block}&autoplay=0`
    : 'https://bitcointimelapse.com/guide/';
  try {
    await env.FEEDBACK_EMAIL.send({
      from:env.FEEDBACK_FROM, to:env.FEEDBACK_TO,
      subject:`[Bitcoin Timelapse] ${categories[category]}`,
      text:`${message}\n\n---\nFrom: ${data.source}\nView: ${view}\nReply address: ${email || 'Not provided'}\nSent: ${new Date().toISOString()}\n\nThis message was submitted by a visitor through the feedback form.`,
      ...(email ? {replyTo:email} : {}),
    });
    return reply(200, {ok:true});
  } catch {
    // Provider errors can contain addresses: never log or echo them to visitors.
    console.error('Feedback email delivery failed');
    return reply(502, {error:'Could not send right now. Your message is still here; please try again.'});
  }
}
