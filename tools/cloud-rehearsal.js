// Skela — cloud path rehearsal with the real Firebase SDK and no Firebase project.
//
//   node tools/cloud-rehearsal.js <devtools port> [app url]
//
// Chrome's DevTools protocol pauses every request to the Firebase endpoints and this script
// answers it with canned text marked "REHEARSAL". Nothing reaches Google. The on-device model
// stays live. What this proves: the real SDK builds the cloud request, and the app's send,
// review, put-originals-back, offline queue, delivery after reconnect and cloud-failure paths
// work in a real browser. It also reads the exact request body the SDK would have sent and
// checks it for the sample's confidential values.
// What it does not prove: a live Gemini answer, App Check enforcement, quota or billing.

import { SAMPLE_SECRETS } from '../src/samples.js';

const port = process.argv[2] || '9377';
const url = process.argv[3] || 'http://localhost:5199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === 'page' && t.url.startsWith(url));
if (!target) throw new Error(`no page at ${url}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const handlers = {};
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  } else if (handlers[msg.method]) handlers[msg.method](msg.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const until = async (expression, label, timeout = 240000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await js(`return Boolean(${expression})`)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
};
const text = (selector) => js(`return document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);

// ---------- the intercepted cloud ----------
const cloud = { mode: 'ok', appCheck: 0, generate: [], other: [] };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const cors = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Headers', value: '*' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
];
const reply = (requestId, status, body) => send('Fetch.fulfillRequest', {
  requestId, responseCode: status,
  responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
  body: b64(JSON.stringify(body)),
});
handlers['Fetch.requestPaused'] = async ({ requestId, request }) => {
  try {
    if (request.method === 'OPTIONS') return await send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
    if (request.url.includes('firebaseappcheck.googleapis.com')) {
      cloud.appCheck += 1;
      return await reply(requestId, 200, { token: 'rehearsal-app-check-token', ttl: '3600s' });
    }
    if (request.url.includes(':generateContent') || request.url.includes(':streamGenerateContent')) {
      const body = request.postData || '';
      cloud.generate.push({ url: request.url, body, headers: request.headers });
      if (cloud.mode === 'fail') return await reply(requestId, 503, { error: { code: 503, message: 'REHEARSAL: the cloud is unavailable.', status: 'UNAVAILABLE' } });
      const prompt = (JSON.parse(body).contents || []).flatMap((c) => c.parts || []).map((p) => p.text || '').join('\n');
      // The instruction text names example tokens; only the packet after it counts.
      const packet = prompt.slice(prompt.lastIndexOf('letterhead.') + 1);
      const placeholders = [...new Set(packet.match(/\[[A-Z]+_\d+\]/g) || [])];
      const answer = [
        'REHEARSAL: canned text from an intercepted request. No cloud model was called.',
        '',
        '## Risk picture',
        `The packet arrived with ${placeholders.length} placeholders. Contact ${placeholders[0] || '(none)'} before loading the slab.`,
        '',
        '## Actions',
        `1. ${placeholders[1] || 'The contractor'} closes the scaffold platform today.`,
      ].join('\n');
      return await reply(requestId, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: Math.ceil(prompt.length / 4), candidatesTokenCount: Math.ceil(answer.length / 4), totalTokenCount: Math.ceil((prompt.length + answer.length) / 4) },
      });
    }
    cloud.other.push(request.url);
    return await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  } catch (error) {
    console.error('intercept error:', error.message);
  }
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`);
};
const offline = (on) => send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const reload = async () => {
  await send('Page.reload');
  await sleep(1500);
  await until("document.readyState === 'complete' && document.querySelectorAll('#samples button').length === 3", 'app start', 30000);
};
const inspect = async () => {
  await js("document.querySelector('#samples button:nth-child(1)').click(); await new Promise(r => setTimeout(r, 500)); document.getElementById('inspect').click(); return 1");
  await sleep(800);
  await until("!document.getElementById('inspect').disabled", 'inspect done');
};
const leaks = (body) => SAMPLE_SECRETS['block-b'].filter((secret) => body.includes(secret));

await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
await send('Fetch.enable', { patterns: ['*firebaseappcheck.googleapis.com*', '*firebasevertexai.googleapis.com*', '*generativelanguage.googleapis.com*', '*firebaseml.googleapis.com*'].map((urlPattern) => ({ urlPattern })) });
await offline(false);

const saved = await js("return localStorage.getItem('skela.settings')");
const savedQueue = await js("return localStorage.getItem('skela.queue')");
if (saved && !saved.includes('demo-no-project')) console.log('note: a real Firebase config is saved; the rehearsal replaces it and restores it at the end.');

try {
  await js("localStorage.setItem('skela.settings', JSON.stringify({ firebase: { apiKey: 'demo-not-a-key', projectId: 'demo-no-project', appId: '1:0:web:0' }, appCheck: { provider: 'debug' } })); localStorage.removeItem('skela.queue'); return 1");
  await reload();
  await until("document.getElementById('chipCloud').textContent.includes('connected') && !document.getElementById('chipCloud').textContent.includes('not connected')", 'SDK connected', 30000);
  await until("document.getElementById('chipDevice').textContent.includes('ready')", 'on-device model ready', 180000);

  // ---- A. online: live on-device read, then the packet crosses ----
  await inspect();
  check('A note was read on this device', (await text('#findingsMeta')).length > 0, await text('#findingsMeta'));
  const beforeSend = cloud.generate.length;
  check('A nothing was sent to a model endpoint before Send', beforeSend === 0 || cloud.generate.every((g) => leaks(g.body).length === 0), `${beforeSend} request(s)`);
  await js("document.getElementById('send').click(); return 1");
  await until("!document.getElementById('stepReview').hidden && document.getElementById('review').textContent.length > 40 && !document.getElementById('send').textContent.includes('Sending')", 'review', 60000);
  const sent = cloud.generate.at(-1);
  check('A the SDK made a cloud generateContent request', cloud.generate.length > beforeSend, sent?.url);
  check('A the request carried an App Check token', Object.keys(sent?.headers || {}).some((h) => h.toLowerCase() === 'x-firebase-appcheck'));
  check('A the request body holds none of the confidential values', sent && leaks(sent.body).length === 0, sent ? leaks(sent.body).join(', ') || `${sent.body.length} bytes checked` : 'no request');
  check('A the request body does carry placeholders', /\[[A-Z]+_\d+\]/.test(sent?.body || ''));
  check('A the review is reported as cloud', (await text('#reviewMeta')).toLowerCase().includes('cloud'), await text('#reviewMeta'));
  check('A the review text is the intercepted answer', (await text('#review')).includes('REHEARSAL'));
  const withPlaceholders = await text('#review');
  await js("const box = document.getElementById('rehydrate'); if (!box.checked) box.click(); return 1");
  await sleep(400);
  const withOriginals = await text('#review');
  check('A originals are put back on the device', withOriginals !== withPlaceholders && SAMPLE_SECRETS['block-b'].some((s) => withOriginals.includes(s)) && !/\[[A-Z]+_\d+\]/.test(withOriginals), withOriginals.slice(80, 260));
  const ledgerRows = await js("return [...document.querySelectorAll('#ledgerRows tr')].map(r => [...r.children].map(td => td.textContent).join(' | '))");
  check('A the ledger has a cloud row with real token counts', ledgerRows.some((row) => row.includes('cloud')), ledgerRows.join(' // '));
  console.log('     meters:', (await text('#meters')).replace(/\s+/g, ' ').slice(0, 400));

  // ---- B. offline: queue; back online: delivered without a click ----
  await offline(true);
  await until("document.getElementById('chipNet').textContent.includes('offline')", 'offline chip', 10000);
  await inspect();
  const countB = cloud.generate.length;
  check('B send button offers the queue', (await text('#send')).includes('Queue'), await text('#send'));
  await js("document.getElementById('send').click(); return 1");
  await until("document.getElementById('queueMeta').textContent.startsWith('1 anonymised')", 'queued', 10000);
  check('B nothing was sent while offline', cloud.generate.length === countB);
  await offline(false);
  await until("document.getElementById('queueMeta').textContent === ''", 'queue delivered', 60000);
  check('B the queued packet left by itself after reconnect', cloud.generate.length === countB + 1 && leaks(cloud.generate.at(-1).body).length === 0);
  check('B the review is marked as queued delivery', (await js("return [...document.querySelectorAll('#ledgerRows tr')].map(r => r.textContent).join(' // ')")).includes('queued'));

  // ---- C. the cloud fails: the app says so and keeps the packet usable ----
  cloud.mode = 'fail';
  await reload();
  await until("document.getElementById('chipDevice').textContent.includes('ready')", 'on-device model ready', 180000);
  await inspect();
  const countC = cloud.generate.length;
  await js("document.getElementById('send').click(); return 1");
  await until("!document.getElementById('stepReview').hidden && !document.getElementById('send').textContent.includes('Sending') && document.getElementById('stepReview').textContent.length > 60", 'failure handled', 300000);
  check('C the cloud was tried', cloud.generate.length > countC);
  const metaC = await text('#reviewMeta');
  const bodyC = await text('#stepReview');
  check('C a cloud failure does not show cloud text', !(await text('#review')).includes('REHEARSAL'));
  check('C the on-device fallback is labelled as not the cloud review', (await text('#reviewMeta')).includes('the cloud did not answer') && (await text('#reviewMeta')).includes('local draft'));
  console.log('     C outcome:', metaC.replace(/\s+/g, ' ').slice(0, 200), '|', bodyC.replace(/\s+/g, ' ').slice(0, 300));
} finally {
  // ---------- restore ----------
  cloud.mode = 'ok';
  await offline(false).catch(() => {});
  await js(`localStorage.removeItem('skela.queue'); ${saved ? `localStorage.setItem('skela.settings', ${JSON.stringify(saved)});` : "localStorage.removeItem('skela.settings');"} ${savedQueue ? `localStorage.setItem('skela.queue', ${JSON.stringify(savedQueue)});` : ''} return 1`).catch(() => {});
  await send('Fetch.disable').catch(() => {});
  await send('Page.reload').catch(() => {});
}

console.log(`\nApp Check exchanges answered: ${cloud.appCheck}; model requests intercepted: ${cloud.generate.length}; other blocked: ${cloud.other.length}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks FAILED` : `all ${results.length} checks passed (rehearsal: intercepted cloud, live on-device model)`);
ws.close();
process.exit(failed.length ? 1 : 0);
