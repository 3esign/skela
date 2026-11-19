// Skela — evaluate one async expression in the app page over the DevTools protocol.
//
//   node tools/cdp-eval.js <port> <page url prefix> "<async expression>" [timeout ms]
//
// Prints the JSON result and every request URL that left the page while it ran.
// Used for live probes (for example the Prompt API on a machine that has Gemini Nano).

const [port = '9222', prefix = 'http://localhost', expression, timeout = '180000'] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(prefix));
if (!page) { console.error('no page with prefix', prefix); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });

let seq = 0;
const pending = new Map();
const requests = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Network.enable');
const reply = await send('Runtime.evaluate', {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
  timeout: Number(timeout),
});
const r = reply.result || {};
if (r.exceptionDetails) console.log('EXCEPTION', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
else console.log(JSON.stringify(r.result?.value, null, 1));
console.log('requests:', JSON.stringify(requests));
ws.close();
