import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { feedbackResponse } from '../cloudflare/utxo-video-worker/src/feedback.js';

let serial = 1;
const origin = 'https://bitcointimelapse.com';
const valid = {category:'idea', message:'Let me bookmark a block. Thank you! ₿', email:'', source:'explorer', block:314000};
const sent = [];
const env = {FEEDBACK_FROM:'feedback@bitcointimelapse.com', FEEDBACK_TO:'owner@example.com', FEEDBACK_EMAIL:{async send(message) { sent.push(message); }}};
function request(data = valid, options = {}) {
  const {method = 'POST', headers = {}, body = JSON.stringify(data)} = options;
  return new Request(origin + '/api/feedback', {method, headers:{Origin:origin, 'Content-Type':'application/json', 'CF-Connecting-IP':`test-${serial++}`, ...headers}, ...(method === 'POST' ? {body} : {})});
}
async function status(expected, data, options, environment = env) {
  const response = await feedbackResponse(request(data, options), environment);
  assert.equal(response.status, expected);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return response;
}
const delivered = await status(200, valid);
assert.equal((await delivered.json()).ok, true);
assert.equal(sent.length, 1);
assert.equal(sent[0].to, env.FEEDBACK_TO);
assert.equal(sent[0].from, env.FEEDBACK_FROM);
assert.match(sent[0].text, /block=314000&autoplay=0/);
assert.ok(!('replyTo' in sent[0]));
await status(200, {...valid, category:'bug', email:'visitor@example.org', to:'attacker@example.org'});
assert.equal(sent[1].to, env.FEEDBACK_TO, 'recipient is never visitor-controlled');
assert.equal(sent[1].replyTo, 'visitor@example.org');
assert.equal(sent[1].subject, '[Bitcoin Timelapse] Bug report');
await status(200, {...valid, source:'guide', block:null});
assert.match(sent[2].text, /https:\/\/bitcointimelapse.com\/guide\//);
const before = sent.length;
await status(403, valid, {headers:{Origin:'https://evil.example'}});
await status(403, valid, {headers:{Origin:'null'}});
await status(405, valid, {method:'GET'});
await status(415, valid, {headers:{'Content-Type':'text/plain'}});
await status(413, valid, {body:'x'.repeat(20001)});
await status(400, valid, {body:'not json'});
await status(400, {...valid, category:'__proto__'});
await status(400, {...valid, category:{toString:null}});
await status(400, {...valid, email:'a@example.org\r\nBcc: b@example.org'});
await status(400, {...valid, email:123});
await status(400, {...valid, message:'   '});
await status(400, {...valid, message:'x'.repeat(4001)});
await status(400, {...valid, block:-1});
await status(400, {...valid, source:'https://evil.example/'});
await status(200, {...valid, website:'spam'});
assert.equal(sent.length, before, 'rejected and honeypot submissions do not send');
for (const allowed of [origin, 'https://nostitos.github.io', 'https://utxo.aiception.ai', 'http://127.0.0.1:8080']) {
  const cors = await status(204, valid, {method:'OPTIONS', headers:{Origin:allowed}});
  assert.equal(cors.headers.get('Access-Control-Allow-Origin'), allowed);
  assert.equal(cors.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.ok(!cors.headers.has('Access-Control-Allow-Credentials'));
}
await status(503, valid, {}, {});
const failed = await status(502, valid, {}, {...env, FEEDBACK_EMAIL:{async send() {throw Error('private email provider detail');}}});
assert.ok(!(await failed.text()).includes('private email'));
for (let i = 0; i < 4; i++) await status(200, valid, {headers:{'CF-Connecting-IP':'same-visitor'}});
const limited = await status(429, valid, {headers:{'CF-Connecting-IP':'same-visitor'}});
assert.equal(limited.headers.get('Retry-After'), '600');
let finish;
let settled = false;
const waiting = feedbackResponse(request(), {...env, FEEDBACK_EMAIL:{send:() => new Promise(resolve => {finish = resolve;})}}).then(r => {settled = true; return r;});
while (!finish) await new Promise(resolve => setImmediate(resolve));
assert.equal(settled, false, 'success must wait for email provider acceptance');
finish();
assert.equal((await waiting).status, 200);
for (const path of ['cloudflare/utxo-video-worker/static/explorer.html','src/cpp/app/explorer_ui/explorer.html']) {
  const html = readFileSync(path, 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (match[1].trim()) new vm.Script(match[1]);
  assert.match(html, /id="feedbackBtn"[^>]*data-feedback/);
  assert.match(html, /shareDialog.open \|\| document.getElementById\('feedbackDialog'\)\?\.open/);
}
console.log('Feedback: email delivery, validation, CORS, spam limits, failure handling and explorer syntax passed.');
