// Skela — end-to-end check in a real Chrome, over the DevTools protocol. No dependencies.
//
//   1. start Chrome with:  --remote-debugging-port=9222 --user-data-dir=<an empty folder>
//   2. run:                node tools/e2e.js 9222 [screenshot folder]
//
// The script starts its own copy of the static server, and stops it for the offline part, so
// "opens with no network" is tested against a server that is really gone.
//
// It drives the interface the way a person would and fails on any console error. The model side
// runs in dry-run mode (canned text), so this proves the interface, the routing, the egress
// guard, the offline queue and the service worker. It does not prove a live Gemini call.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SAMPLE_SECRETS } from '../src/samples.js';

const port = process.argv[2] || '9222';
const shots = process.argv[3] || null;
const serverPort = 5199;
const base = `http://localhost:${serverPort}/`;

let server = null;
const startServer = () => new Promise((resolve) => {
  server = spawn(process.execPath, [fileURLToPath(new URL('./serve.js', import.meta.url)), String(serverPort)], { stdio: ['ignore', 'pipe', 'inherit'] });
  server.stdout.once('data', resolve);
});
const stopServer = () => new Promise((resolve) => {
  server.once('exit', resolve);
  server.kill();
});
await startServer();

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('No page target in this Chrome.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    problems.push(`console.error: ${msg.params.args.map((a) => a.value || a.description).join(' ')}`);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result.value;
};
const until = async (expression, label, timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await js(expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
};
const load = async () => {
  await send('Page.navigate', { url: base });
  await until("document.readyState === 'complete' && document.querySelectorAll('#samples button').length === 3", 'app start');
  await sleep(300);
};
// Offline means two things here: the page is told it is offline (navigator.onLine and the
// offline event), and the server is stopped so nothing can be fetched even by the service worker.
const netState = async (isOffline) => {
  const state = { offline: isOffline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await send('Network.emulateNetworkConditions', state).catch(() => {});
  await send('Network.overrideNetworkState', state).catch(() => {});
};
const offline = async (value) => {
  if (value) await stopServer();
  else if (server.exitCode !== null || server.killed) await startServer();
  await netState(value);
};
const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
const shot = async (name, fullPage = false) => {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).textContent`);
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const settings = (value) => js(`localStorage.setItem('skela.settings', ${JSON.stringify(JSON.stringify(value))})`);
const meter = (label) => js(`[...document.querySelectorAll('.meter')].find((m) => m.querySelector('dt').textContent === ${JSON.stringify(label)}).querySelector('dd').textContent`);

await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Log.enable'), send('Network.enable')]);
await viewport(1440, 900);
await offline(false);
await load();
// Start clean: no settings, no service worker, no cache from an earlier run.
await js("(async () => { localStorage.clear(); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); })()");

// ---- A. not connected: redaction and the rule engine, no model ----
await load();
check('A banner says it is not connected', (await text('#banner')).startsWith('Not connected to Firebase'));
await click('#samples button:nth-child(1)');
await until("!document.querySelector('#stepRedacted').hidden", 'live preview');
check('A live preview hides values before Inspect', (await text('#redactionMeta')).includes('live preview'));
await click('#inspect');
await until("document.querySelectorAll('.finding').length > 0 && document.querySelector('#inspect').textContent === 'Inspect'", 'findings');
check('A four findings, worst first', await js("[...document.querySelectorAll('.finding .sev')].map((n) => n.textContent).join(',')") === 'critical,critical,major,major');
check('A no secret on screen in the redacted note', await js(`(() => { const t = document.querySelector('#redacted').textContent.toLowerCase(); return ${JSON.stringify(SAMPLE_SECRETS['block-b'])}.every((s) => !t.includes(s.toLowerCase())); })()`));
check('A router explains why nothing crosses', (await text('#verdict')).includes('no cloud model is connected'));
check('A send is disabled', await js("document.querySelector('#send').disabled"));
check('A egress guard passed', (await text('#guard')).startsWith('Egress guard: passed'));
check('A telemetry: 10 values kept, 0 tokens', (await meter('Kept on this device')).startsWith('10 values') && (await meter('Cloud')).includes('0 tokens'), await meter('Kept on this device'));
await shot('A-not-connected');

// ---- B. dry run, no local model, online: brief falls back to cloud, review crosses ----
await settings({ dryRun: true, dryDevice: false });
await load();
check('B banner says dry run', (await text('#banner')).startsWith('Dry run'));
await click('#samples button:nth-child(1)');
await until("document.querySelector('#redactionMeta').textContent.includes('live preview')", 'live preview');
await click('#inspect');
await until("!document.querySelector('#stepBrief').hidden && document.querySelector('#inspect').textContent === 'Inspect'", 'brief');
check('B raw note was read by the rule engine, not sent', (await text('#findingsMeta')).includes('never sent to the cloud'));
check('B brief ran in the cloud (PREFER_ON_DEVICE fallback)', (await text('#briefMeta')).includes('in the cloud'));
check('B router sends this one to the cloud', (await text('#verdict')).includes('may go to the cloud'));
await click('#send');
await until("!document.querySelector('#stepReview').hidden && !document.querySelector('#send').disabled", 'review');
check('B review arrived from the cloud', (await text('#reviewMeta')).includes('in the cloud'));
const sent = await js("[...document.querySelectorAll('#log pre')].map((n) => n.textContent)");
check('B two texts left the device', sent.length === 2, `${sent.length}`);
const leaked = SAMPLE_SECRETS['block-b'].filter((s) => sent.some((t) => t.toLowerCase().includes(s.toLowerCase())));
check('B nothing confidential is in any text that left', leaked.length === 0, leaked.join(', '));
check('B review shows placeholders', (await text('#review')).includes('[PARTY_2]'));
await click('#rehydrate');
check('B originals are put back locally', (await text('#review')).includes('Mr. Jovan Petrović'));
await click('#toggleLedger');
check('B ledger has three rows: rule engine, brief, review', await js("document.querySelectorAll('#ledgerRows tr').length") === 3);
await shot('B-dry-run-cloud');
await js("document.querySelector('#stepFindings').scrollIntoView()");
await shot('B2-findings');
await js('scrollTo(0, 0)');
await click('#toggleLedger');

// ---- C. offline, with a (pretended) local model: service worker, queue, local draft ----
await settings({ dryRun: true, dryDevice: true });
await load();
await until('navigator.serviceWorker.controller !== null', 'service worker control', 10000);
await offline(true);
const reloadStarted = Date.now();
await send('Page.reload');
await until("document.readyState === 'complete' && document.querySelectorAll('#samples button').length === 3", 'offline start from the service worker', 20000);
const offlineStartMs = Date.now() - reloadStarted;
await netState(true); // Chrome drops the override on navigation; tell the new document again
await until("document.querySelector('#chipNet').textContent.includes('offline')", 'offline chip');
check('C app opened with the server stopped, from the service worker', true, `${offlineStartMs} ms`);
await click('#samples button:nth-child(3)');
await until("document.querySelector('#redactionMeta').textContent.includes('live preview')", 'live preview');
await click('#inspect');
await until("!document.querySelector('#stepBrief').hidden && document.querySelector('#inspect').textContent === 'Inspect'", 'offline brief');
check('C brief ran on this device', (await text('#briefMeta')).includes('on this device'));
check('C router queues the packet', (await text('#verdict')).includes('waits in the queue'));
check('C send button offers the queue', (await text('#send')) === 'Queue for review when online');
await click('#send');
await until("document.querySelector('#queueMeta').textContent.startsWith('1 anonymised')", 'queued');
await click('#draft');
await until("!document.querySelector('#stepReview').hidden && !document.querySelector('#draft').disabled", 'local draft');
check('C local draft ran on this device', (await text('#reviewMeta')).includes('on this device') && (await text('#reviewMeta')).includes('local draft'));
check('C nothing left the device while offline', await js("document.querySelector('#stepLog').hidden"));
check('C offline work is counted', (await meter('Without a network')).startsWith('4 tasks done'), await meter('Without a network'));
await shot('C-offline-queue');
await offline(false);
await until("document.querySelector('#queueMeta').textContent === '' && !document.querySelector('#stepLog').hidden", 'queue flush after reconnect', 10000);
check('C queued packet was delivered after reconnect', (await meter('Without a network')).includes('1 delivered later'), await meter('Without a network'));
const sentC = await js("[...document.querySelectorAll('#log pre')].map((n) => n.textContent)");
const leakedC = SAMPLE_SECRETS['objekat-c'].filter((s) => sentC.some((t) => t.toLowerCase().includes(s.toLowerCase())));
check('C nothing confidential in the delivered packet', sentC.length === 1 && leakedC.length === 0, leakedC.join(', '));

// ---- D. air-gap seals the boundary ----
await click('#airGap');
check('D boundary is sealed', (await text('#boundaryLabel')).includes('sealed') && await js("document.querySelector('#boundary').classList.contains('sealed')"));
check('D send is disabled under air-gap and says why', await js("document.querySelector('#send').disabled") && (await text('#send')).includes('air-gap'));
check('D the brief keeps the mode it really ran in', (await text('#briefMeta')).includes('PREFER_ON_DEVICE'));
check('D router says nothing leaves', (await text('#verdict')).includes('nothing leaves this device'));
await shot('D-air-gap');

// ---- E. phone width ----
await viewport(390, 844);
await sleep(300);
check('E no horizontal overflow at 390 px', await js('document.documentElement.scrollWidth <= 390'), `${await js('document.documentElement.scrollWidth')}`);
await shot('E-phone', true);

await viewport(1440, 900);
await js('localStorage.clear()');
check('no console errors or exceptions', problems.length === 0, problems.join(' | '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
ws.close();
server.kill();
process.exit(failed ? 1 : 0);
