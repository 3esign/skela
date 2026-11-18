// Skela — probe of the real Firebase AI Logic SDK, without a Firebase project.
//
//   1. node tools/serve.js 5173
//   2. Chrome with --remote-debugging-port=9222 --user-data-dir=<an empty folder>
//   3. node tools/probe-sdk.js 9222 http://localhost:5173/
//
// It loads src/firebase.js (the real SDK from the Google CDN), builds the hybrid layer on it with
// a placeholder configuration, and starts a local-only task and an unredacted review. In a
// Chrome without the Prompt API both must be refused before any request is made. The probe
// lists every request that left the page other than the app and SDK files; the list must be empty.
//
// Why this exists: with no Prompt API, SDK 13.4.0 creates no on-device adapter and sends an
// ONLY_ON_DEVICE request to the cloud. The guard in src/hybrid.js prevents that, and this probe
// is how the guard is checked against the real SDK rather than the dry-run stand-in.

const [port = '9222', base = 'http://localhost:5173/'] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });

let seq = 0;
const pending = new Map();
const requests = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: base });
await sleep(2500);
requests.length = 0;

const expression = `(async () => {
  const out = {};
  const firebase = await import('./src/firebase.js');
  out.sdkVersion = firebase.SDK_VERSION;
  const appModule = await import('https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js');
  const ai = await import('https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js');
  const { createHybrid } = await import('./src/hybrid.js');
  const app = appModule.initializeApp({ apiKey: 'probe-not-a-key', projectId: 'probe-no-project', appId: '1:0:web:0' }, 'probe-' + Date.now());
  const hybrid = createHybrid({ getAI: ai.getAI, getGenerativeModel: ai.getGenerativeModel, GoogleAIBackend: ai.GoogleAIBackend, InferenceMode: ai.InferenceMode }, app, {});
  out.hybridBuiltOnRealSdk = true;
  out.promptApiInThisChrome = 'LanguageModel' in self;
  try { await hybrid.structure('Crack 0.4 mm in slab S3.'); out.localOnlyTask = 'ran'; } catch (e) { out.localOnlyTask = 'refused: ' + e.name; }
  try { await hybrid.review('Investor: Example Build d.o.o., phone 060/123-45-67', []); out.unredactedReview = 'sent'; } catch (e) { out.unredactedReview = 'refused: ' + e.name; }
  return JSON.stringify(out);
})()`;
const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const value = result.result?.result?.value;
console.log(value || JSON.stringify(result.result?.exceptionDetails?.exception?.description || result));
await sleep(1500);

const outside = requests.filter((url) => !url.startsWith(base) && !url.startsWith('https://www.gstatic.com/firebasejs/'));
console.log('requests other than app and SDK files:', outside.length ? outside : 'none');
ws.close();

const parsed = value ? JSON.parse(value) : {};
const ok = parsed.hybridBuiltOnRealSdk && parsed.unredactedReview === 'refused: EgressBlocked' && outside.length === 0
  && (parsed.promptApiInThisChrome || parsed.localOnlyTask === 'refused: DeviceUnavailable');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
