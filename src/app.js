// Skela — interface.
// One sentence: a site note is read and redacted on this device, and you can see exactly what
// is allowed to cross to the cloud, and what it cost.
//
// The screen is a rendering of `state` and the ledger. Nothing is displayed that those two do
// not hold: every status is a value below, every number is a sum over ledger rows.

import fileConfig from '../config.js';
import { redact, redactWithVault, rehydrate, inspectEgress, segments, strayPlaceholders, KIND_LABEL } from './redact.js';
import { readNote, fromModel, CATEGORIES } from './rules.js';
import { decide, buildPacket, DEFAULT_THRESHOLD, TASK_MODE } from './router.js';
import { createLedger, DEFAULT_PRICE, formatUsd } from './telemetry.js';
import { createHybrid, EgressBlocked, DeviceUnavailable } from './hybrid.js';
import { createDryRunSdk } from './dryrun.js';
import { SAMPLES } from './samples.js';

const SETTINGS_KEY = 'skela.settings';
const QUEUE_KEY = 'skela.queue';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

const defaults = { firebase: null, appCheck: { provider: 'debug' }, cloudModel: '', threshold: DEFAULT_THRESHOLD, priceIn: DEFAULT_PRICE.inputPerMillion, priceOut: DEFAULT_PRICE.outputPerMillion, dryRun: false, dryDevice: false };

const state = {
  settings: { ...defaults, ...(fileConfig || {}), ...readJson(SETTINGS_KEY, {}) },
  hybrid: null,
  engine: 'none', // 'none' | 'firebase' | 'dry-run'
  connectError: null,
  device: 'unknown', // 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'unknown'
  devicePrepared: false,
  downloadProgress: null,
  online: navigator.onLine,
  airGap: false,
  busy: null,
  crossing: false,
  preview: null,
  run: null,
  reviewView: null, // { out, vault, error }
  queue: readJson(QUEUE_KEY, []),
  outbound: [],
};

const ledger = createLedger();
ledger.counters.queued = state.queue.length;
const price = () => ({ inputPerMillion: Number(state.settings.priceIn), outputPerMillion: Number(state.settings.priceOut) });

const deviceReady = () => state.device === 'available';
const cloudReady = () => state.hybrid !== null;
const lexiconOf = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- connection ----------

const DEVICE_OPTIONS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

async function probeDevice() {
  if (state.engine === 'dry-run') {
    state.device = state.settings.dryDevice ? 'available' : 'unavailable';
    return;
  }
  if (!('LanguageModel' in self)) {
    state.device = 'unsupported';
    return;
  }
  try {
    // The Prompt API is what Firebase AI Logic uses for on-device inference. This only asks
    // whether the model is present; it runs no inference.
    state.device = await self.LanguageModel.availability(DEVICE_OPTIONS);
  } catch {
    state.device = 'unknown';
  }
}

async function connect() {
  const s = state.settings;
  if (s.dryRun) {
    const sdk = createDryRunSdk({ deviceAvailable: () => state.settings.dryDevice, online: () => navigator.onLine, delay: 450 });
    state.hybrid = createHybrid(sdk, {}, { hasDeviceApi: () => true });
    state.engine = 'dry-run';
  } else if (s.firebase) {
    try {
      const firebase = await import('./firebase.js');
      const { app, sdk } = firebase.connect(s);
      state.hybrid = createHybrid(sdk, app, { cloudModel: s.cloudModel || undefined });
      state.engine = 'firebase';
    } catch (error) {
      state.connectError = navigator.onLine ? error.message : 'The Firebase SDK is not cached yet and there is no network.';
    }
  }
  await probeDevice();
  render();
  flushQueue();
}

async function downloadModel() {
  if (!state.hybrid) return;
  state.device = 'downloading';
  state.downloadProgress = 0;
  renderStatus();
  try {
    await state.hybrid.prepareDevice((fraction) => {
      state.downloadProgress = fraction;
      renderStatus();
    });
    state.devicePrepared = true;
  } catch (error) {
    state.connectError = `On-device model: ${error.message}`;
  }
  await probeDevice();
  render();
}

// ---------- work ----------

function record(out, task) {
  ledger.record({ task, source: out.source, latencyMs: out.latencyMs, input: out.prompt, output: out.text, usage: out.usage, online: navigator.onLine, simulated: state.engine === 'dry-run' });
  if (out.source === 'cloud') state.outbound.push({ at: Date.now(), task, text: out.prompt });
}

function recompute() {
  const r = state.run;
  if (!r) return;
  r.packet = buildPacket({ redactedText: r.red.text, findings: r.findings, asksRegulation: r.asksRegulation });
  r.egress = inspectEgress(r.packet, r.red.vault, { lexicon: r.lexicon });
  r.verdict = decide({
    findings: r.findings, asksRegulation: r.asksRegulation, text: r.red.text, online: state.online, cloudReady: cloudReady(),
    airGap: state.airGap, egressOk: r.egress.ok, threshold: Number(state.settings.threshold) || DEFAULT_THRESHOLD,
  });
}

let previewTimer = null;

async function inspect() {
  const note = $('note').value.trim();
  if (!note || state.busy) return;
  clearTimeout(previewTimer); // a pending live preview must not wipe the run that starts now
  const lexicon = lexiconOf($('lexicon').value);
  state.busy = 'inspect';
  render();

  const started = performance.now();
  let red = redact(note, { lexicon });
  const read = readNote(red.text);
  ledger.record({ task: 'redact + read', source: 'rules', latencyMs: performance.now() - started, online: navigator.onLine });

  let findings = read.findings;
  let reader = 'rules';
  let readerNote = 'Not connected: the rule engine read the note. No model was used.';

  if (state.hybrid && !deviceReady()) {
    readerNote = 'No on-device model is ready, and a raw note is never sent to the cloud, so the rule engine read it.';
  } else if (state.hybrid) {
    try {
      if (!state.devicePrepared) {
        await state.hybrid.prepareDevice();
        state.devicePrepared = true;
      }
      // The Prompt API now and then fails a call with an unspecific error; one retry, still on device.
      const out = await state.hybrid.structure(note).catch((error) => {
        if (error instanceof DeviceUnavailable) throw error;
        return state.hybrid.structure(note);
      });
      record(out, 'structure');
      // Keep only names that really occur in the note, then redact again with them.
      const names = out.names.filter((n) => typeof n === 'string' && n.trim().length >= 3 && note.toLowerCase().includes(n.trim().toLowerCase()));
      if (names.length) red = redact(note, { lexicon, extraTerms: names });
      const safe = (value) => (typeof value === 'string' ? redactWithVault(value, red.vault, { lexicon, extraTerms: names }) : '');
      const modelFindings = fromModel(out.findings.map((f) => ({ ...f, element: safe(f.element), issue: safe(f.issue), measurement: safe(f.measurement) })));
      if (modelFindings.length) {
        findings = modelFindings;
        reader = 'on-device';
        readerNote = `Read by the on-device model (${TASK_MODE.structure}); every grade was checked against the threshold rules.`;
      } else {
        findings = readNote(red.text).findings;
        readerNote = 'The on-device model returned no findings, so the rule engine reading is shown.';
      }
    } catch (error) {
      readerNote = `The on-device model call failed (${error.message}), so the rule engine reading is shown.`;
    }
  }

  ledger.counters.protectedFields += red.total;
  state.run = { note, lexicon, red, findings, asksRegulation: read.asksRegulation, reader, readerNote, brief: null, briefNote: '' };
  state.preview = null;
  state.reviewView = null;
  recompute();
  render();

  await writeBrief();
  state.busy = null;
  render();
}

async function writeBrief() {
  const r = state.run;
  if (!r.findings.length) return;
  if (!state.hybrid) {
    r.briefNote = 'No model is connected. The checks under each finding are the brief.';
    return;
  }
  const local = deviceReady();
  if (!local && state.airGap) {
    r.briefNote = 'Air-gap is on and no on-device model is ready, so no brief was written. The checks under each finding still apply.';
    return;
  }
  if (!local && !state.online) {
    r.briefNote = 'There is no network and no on-device model, so no brief was written. The checks under each finding still apply.';
    return;
  }
  const text = r.findings.map((f) => `${f.id} [${f.severity}] ${f.text}`).join('\n');
  try {
    // Under air-gap only an ONLY_ON_DEVICE model is called. Otherwise PREFER_ON_DEVICE: the SDK
    // uses the local model when it can and reports which side answered.
    const localOnly = state.airGap;
    r.brief = await state.hybrid.brief(text, r.red.vault, { lexicon: r.lexicon }, { localOnly });
    r.brief.mode = localOnly ? 'ONLY_ON_DEVICE' : TASK_MODE.brief;
    record(r.brief, 'brief');
  } catch (error) {
    if (error instanceof EgressBlocked) ledger.counters.blockedEgress += 1;
    r.briefNote = `No brief: ${error.message}`;
  }
}

function saveQueue() {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue));
  ledger.counters.queued = state.queue.length;
}

async function review({ localOnly = false, item = null } = {}) {
  const job = item || (state.run && { packet: state.run.packet, vault: state.run.red.vault, lexicon: state.run.lexicon });
  if (!job || !state.hybrid || state.busy) return false;
  state.busy = 'review';
  state.crossing = !localOnly;
  render();
  let delivered = false;
  try {
    const out = await state.hybrid.review(job.packet, job.vault, { lexicon: job.lexicon }, { localOnly });
    record(out, localOnly ? 'review draft' : item ? 'review (queued)' : 'review');
    // PREFER_IN_CLOUD falls back to the on-device model when the cloud call fails. That answer
    // is a local draft, not the review that was asked for, and a queued packet stays queued.
    const fellBack = !localOnly && out.source !== 'cloud';
    state.reviewView = { out, vault: job.vault, error: null, draft: localOnly || fellBack, fellBack };
    delivered = !fellBack;
  } catch (error) {
    if (error instanceof EgressBlocked) ledger.counters.blockedEgress += 1;
    state.reviewView = { out: null, vault: job.vault, error: error.message };
  }
  state.busy = null;
  state.crossing = false;
  render();
  return delivered;
}

function sendOrQueue() {
  const r = state.run;
  if (!r) return;
  recompute();
  if (!r.egress.ok) {
    ledger.counters.blockedEgress += 1;
    render();
    return;
  }
  if (!state.online) {
    if (!state.queue.some((q) => q.packet === r.packet)) {
      state.queue.push({ id: `${Date.now()}`, at: Date.now(), packet: r.packet, vault: r.red.vault, lexicon: r.lexicon });
      saveQueue();
    }
    render();
    return;
  }
  review();
}

async function flushQueue() {
  if (!state.online || !state.hybrid || state.airGap || state.busy) return;
  while (state.queue.length && state.online && !state.airGap) {
    const item = state.queue[0];
    const delivered = await review({ item });
    if (!delivered) break;
    state.queue.shift();
    ledger.counters.flushed += 1;
    saveQueue();
    render();
  }
}

// ---------- rendering ----------

function renderStatus() {
  $('chipNet').replaceChildren(el('b', { text: 'Network' }), state.online ? ' online' : ' offline');
  $('chipNet').classList.toggle('off', !state.online);

  const deviceText = {
    unsupported: 'not in this browser', unavailable: 'unavailable on this machine', downloadable: 'not downloaded',
    downloading: `downloading${state.downloadProgress != null ? ` ${Math.round(state.downloadProgress * 100)}%` : ''}`, available: 'ready', unknown: 'unknown',
  }[state.device];
  const chipDevice = $('chipDevice');
  chipDevice.replaceChildren(el('b', { text: 'On-device model' }), ` ${deviceText}${state.engine === 'dry-run' ? ' (pretended)' : ''}`);
  chipDevice.classList.toggle('off', !deviceReady());
  if (state.device === 'downloadable' && state.engine === 'firebase') {
    chipDevice.append(' ', el('button', { type: 'button', class: 'link', text: 'Download', onclick: downloadModel }));
  }

  const cloudText = state.engine === 'firebase' ? 'Firebase AI Logic connected' : state.engine === 'dry-run' ? 'dry run' : state.connectError ? 'connection failed' : 'not connected';
  $('chipCloud').replaceChildren(el('b', { text: 'Cloud' }), ` ${cloudText}`);
  $('chipCloud').classList.toggle('off', !cloudReady());

  const banner = $('banner');
  let message = '';
  if (state.engine === 'dry-run') message = 'Dry run. Answers are canned text; no model and no network is called. The telemetry below counts that canned text.';
  else if (state.connectError) message = `Could not connect: ${state.connectError}`;
  else if (state.engine === 'none') message = 'Not connected to Firebase. Redaction and the rule engine work now, with no model. Open Settings to connect Firebase AI Logic, or to rehearse with a dry run.';
  banner.hidden = !message;
  banner.textContent = message;
  banner.classList.toggle('warn', Boolean(state.connectError));

  const boundary = $('boundary');
  boundary.classList.toggle('sealed', state.airGap);
  boundary.classList.toggle('crossing', state.crossing);
  $('boundaryLabel').textContent = state.airGap ? 'sealed · air-gap' : state.crossing ? 'packet crossing' : 'browser boundary';
}

function renderRedacted(target, text, stray = []) {
  // A placeholder the model made up is drawn as plain text: nothing is protected behind it.
  target.replaceChildren(...segments(text).map((part) => (part.type === 'text' || stray.includes(part.value)
    ? document.createTextNode(part.value)
    : el('mark', { class: 'bar', title: `${KIND_LABEL[part.kind] || 'redacted'}, kept on this device`, text: part.value }))));
}

function renderDevice() {
  const r = state.run;
  const red = r ? r.red : state.preview;

  $('stepRedacted').hidden = !red;
  if (red) {
    renderRedacted($('redacted'), red.text);
    const kinds = Object.entries(red.counts).map(([kind, n]) => `${n} ${KIND_LABEL[kind] || kind}`).join(' · ');
    $('redactionMeta').textContent = red.total ? `${red.total} hidden${r ? '' : ' (live preview)'}: ${kinds}` : 'Nothing confidential found.';
    $('vaultTable').tBodies[0].replaceChildren(...red.vault.map((e) => el('tr', {},
      el('td', {}, el('mark', { class: 'bar', text: e.placeholder })),
      el('td', { text: e.value }),
      el('td', { text: KIND_LABEL[e.kind] || e.kind }),
      el('td', { text: e.via }))));
  }

  $('stepFindings').hidden = !r;
  $('stepBrief').hidden = !r || (!r.brief && !r.briefNote);
  if (!r) return;

  $('findingsMeta').textContent = r.readerNote;
  const list = $('findings');
  if (!r.findings.length) {
    list.replaceChildren(el('li', { class: 'empty', text: 'No defect or safety problem was recognised in this note.' }));
  } else {
    list.replaceChildren(...r.findings.map((f) => {
      const text = el('p', { class: 'finding-text' });
      renderRedacted(text, f.text);
      return el('li', { class: `finding sev-${f.severity}` },
        el('div', { class: 'finding-head' },
          el('span', { class: 'sev', text: f.severity }),
          el('span', { class: 'cat', text: f.category ? CATEGORIES[f.category].label : 'General' }),
          el('span', { class: 'fid', text: f.id })),
        text,
        el('p', { class: 'basis', text: f.basis }),
        f.checks.length ? el('ul', { class: 'checks' }, f.checks.map((c) => el('li', { text: c }))) : null);
    }));
  }

  if (r.brief) {
    renderRedacted($('brief'), r.brief.text, strayPlaceholders(r.brief.text, r.red.vault));
    const stray = strayPlaceholders(r.brief.text, r.red.vault);
    $('briefMeta').textContent = `Ran ${r.brief.source === 'cloud' ? 'in the cloud' : 'on this device'} · ${Math.round(r.brief.latencyMs)} ms · ${r.brief.mode}${stray.length ? ` · the model made up ${stray.join(', ')} — no vaulted value stands behind that` : ''}`;
  } else {
    $('brief').textContent = r.briefNote;
    $('briefMeta').textContent = state.busy === 'inspect' ? 'Writing…' : '';
  }
}

function renderMarkdown(target, text, stray = []) {
  const inline = (line) => line.split(/(\*\*[^*]+\*\*|\[[A-Z]+_\d+\]|\[REDACTED\])/g).filter(Boolean).map((piece) => {
    if (piece.startsWith('**')) return el('strong', { text: piece.slice(2, -2) });
    if (/^\[[A-Z]+(_\d+)?\]$/.test(piece) && !stray.includes(piece)) return el('mark', { class: 'bar', text: piece });
    return document.createTextNode(piece);
  });
  const nodes = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) {
        list = el(ordered ? 'ol' : 'ul');
        nodes.push(list);
      }
      list.append(el('li', {}, inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    nodes.push(heading ? el('h4', {}, inline(heading[2])) : el('p', {}, inline(line)));
  }
  target.replaceChildren(...nodes);
}

function renderCloud() {
  const r = state.run;
  $('stepPacket').hidden = !r;

  if (r) {
    const v = r.verdict;
    $('verdict').textContent = v.verdict;
    $('routeMeta').textContent = `complexity ${v.score} · threshold ${v.threshold}`;
    $('reasons').replaceChildren(...v.reasons.map((reason) => el('li', { text: reason })));

    $('packet').textContent = r.packet;
    $('packetMeta').textContent = `${new Blob([r.packet]).size} bytes · mode ${TASK_MODE.review}`;
    const guard = $('guard');
    guard.classList.toggle('bad', !r.egress.ok);
    guard.textContent = r.egress.ok
      ? `Egress guard: passed. None of the ${r.red.vault.length} vaulted values and no detector match is in this packet.`
      : `Egress guard: blocked. ${r.egress.leaks.length} confidential value(s) found in the packet.`;

    const send = $('send');
    const possible = cloudReady() && !state.airGap && r.egress.ok;
    send.disabled = !possible || Boolean(state.busy);
    send.textContent = state.busy === 'review' ? 'Sending…'
      : state.airGap ? 'Sealed: air-gap is on'
      : !cloudReady() ? 'No cloud model connected'
      : !state.online ? 'Queue for review when online'
        : v.route === 'cloud' ? 'Send for engineering review' : 'Send for review anyway';
    const draft = $('draft');
    draft.hidden = !(cloudReady() && deviceReady() && (state.airGap || !state.online) && r.egress.ok);
    draft.disabled = Boolean(state.busy);
  } else {
    $('verdict').textContent = 'Inspect a note first. The router then decides whether the device can handle it alone.';
    $('routeMeta').textContent = '';
    $('reasons').replaceChildren();
  }
  $('queueMeta').textContent = state.queue.length ? `${state.queue.length} anonymised packet(s) waiting in this browser for a network.` : '';

  const view = state.reviewView;
  $('stepReview').hidden = !view;
  if (view) {
    if (view.error) {
      $('review').replaceChildren(el('p', { class: 'error', text: view.error }));
      $('reviewMeta').textContent = '';
    } else {
      const text = $('rehydrate').checked ? rehydrate(view.out.text, view.vault) : view.out.text;
      const stray = strayPlaceholders(view.out.text, view.vault);
      renderMarkdown($('review'), text, stray);
      $('reviewMeta').textContent = `Ran ${view.out.source === 'cloud' ? 'in the cloud' : 'on this device'} · ${Math.round(view.out.latencyMs)} ms${view.fellBack ? ' · the cloud did not answer, so this is not the cloud review' : ''}${view.draft ? ' · local draft by a small on-device model: verify every code it names' : ''}${stray.length ? ` · the model made up ${stray.length} placeholder(s) (${stray.slice(0, 4).join(', ')}${stray.length > 4 ? ', …' : ''}): no value stands behind them` : ''}`;
    }
  }

  $('stepLog').hidden = state.outbound.length === 0;
  $('logCount').textContent = state.outbound.length;
  $('log').replaceChildren(...state.outbound.map((entry) => el('li', {},
    el('p', { class: 'meta', text: `${clock(entry.at)} · ${entry.task} · ${new Blob([entry.text]).size} bytes` }),
    el('pre', { class: 'packet', text: entry.text }))));
}

function renderHud() {
  const s = ledger.summary(price());
  const approx = s.tokensAllMeasured ? '' : '≈ ';
  const ms = (value) => (value == null ? 'no calls yet' : `${value} ms avg`);
  const meters = [
    ['On device', `${approx}${s.deviceTokens} tokens`, `${s.deviceCalls} model call${s.deviceCalls === 1 ? '' : 's'} · ${ms(s.deviceLatency)}`],
    ['Cloud', `${approx}${s.cloudTokens} tokens`, `${s.cloudCalls} call${s.cloudCalls === 1 ? '' : 's'} · ${ms(s.cloudLatency)}`],
    ['Rule engine', `${s.ruleRuns} run${s.ruleRuns === 1 ? '' : 's'}`, `${ms(s.rulesLatency)} · no model, no tokens`],
    ['Money', `≈ ${formatUsd(s.cloudCost)} spent`, `≈ ${formatUsd(s.savedCost)} not spent, by running on device`],
    ['Without a network', `${s.offlineDone} task${s.offlineDone === 1 ? '' : 's'} done`, `${s.queued} queued · ${s.flushed} delivered later`],
    ['Kept on this device', `${s.protectedFields} value${s.protectedFields === 1 ? '' : 's'}`, `${state.outbound.length} text${state.outbound.length === 1 ? '' : 's'} sent out · ${s.blockedEgress} send${s.blockedEgress === 1 ? '' : 's'} blocked`],
  ];
  $('meters').replaceChildren(...meters.map(([label, value, sub]) => el('div', { class: 'meter' }, el('dt', { text: label }), el('dd', {}, el('strong', { text: value }), el('span', { text: sub })))));

  const total = s.deviceTokens + s.cloudTokens;
  $('splitDevice').style.flexGrow = total ? s.deviceTokens : 0;
  $('splitCloud').style.flexGrow = total ? s.cloudTokens : 0;
  $('split').classList.toggle('empty', !total);
  $('split').setAttribute('aria-label', total ? `${Math.round((100 * s.deviceTokens) / total)}% of model tokens ran on device, ${Math.round((100 * s.cloudTokens) / total)}% in the cloud` : 'No model tokens yet');

  $('hudNote').textContent = `${s.simulated ? 'DRY RUN rows included. ' : ''}≈ marks estimates: tokens as characters ÷ 4 when the response carries no usage data, money at $${price().inputPerMillion.toFixed(2)} in / $${price().outputPerMillion.toFixed(2)} out per million tokens. Latency, source and counts are measured.`;

  $('ledgerRows').replaceChildren(...ledger.rows.map((row) => el('tr', {},
    el('td', { text: clock(row.at) }),
    el('td', { text: row.task }),
    el('td', { text: `${row.source === 'rules' ? 'rule engine' : row.source}${row.simulated ? ' (dry run)' : ''}` }),
    el('td', { text: `${row.latencyMs} ms` }),
    el('td', { text: row.source === 'rules' ? '–' : `${row.tokensMeasured ? '' : '≈ '}${row.tokensIn}` }),
    el('td', { text: row.source === 'rules' ? '–' : `${row.tokensMeasured ? '' : '≈ '}${row.tokensOut}` }),
    el('td', { text: row.online ? 'online' : 'offline' }))));
}

function render() {
  renderStatus();
  renderDevice();
  renderCloud();
  renderHud();
  $('inspect').disabled = Boolean(state.busy);
  $('inspect').textContent = state.busy === 'inspect' ? 'Inspecting…' : 'Inspect';
  $('zones').setAttribute('aria-busy', String(Boolean(state.busy)));
}

// ---------- export ----------

function exportReport() {
  const r = state.run;
  const view = state.reviewView;
  const original = $('rehydrate').checked;
  const back = (text, vault) => (original ? rehydrate(text, vault) : text);
  const lines = ['# Site inspection report', '', `Generated ${new Date().toLocaleString()} with Skela. ${original ? 'Contains the original confidential values: handle accordingly.' : 'Anonymised: confidential values are placeholders.'}`, ''];
  if (r) {
    lines.push('## Findings', '');
    for (const f of r.findings) {
      lines.push(`### ${f.id} · ${f.severity} · ${f.category ? CATEGORIES[f.category].label : 'General'}`, '', back(f.text, r.red.vault), '', `Basis: ${f.basis}`, '', ...f.checks.map((c) => `- ${c}`), '');
    }
    if (r.brief) lines.push('## Crew brief', '', back(r.brief.text, r.red.vault), '');
  }
  if (view && view.out) lines.push(`## Engineering review (${view.out.source === 'cloud' ? 'cloud model' : 'on-device model'}; an engineer must verify it)`, '', back(view.out.text, view.vault), '');
  const s = ledger.summary(price());
  lines.push('---', `Telemetry: ${s.deviceTokens} model tokens on device, ${s.cloudTokens} in the cloud (estimates unless the service reported usage); ${s.protectedFields} confidential values kept on the device.`);
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
  const link = el('a', { href: url, download: `skela-report-${new Date().toISOString().slice(0, 10)}.md` });
  link.click();
  URL.revokeObjectURL(url);
}

// ---------- settings ----------

function parseFirebaseConfig(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Paste the firebaseConfig object, including its braces.');
  const body = text.slice(start, end + 1);
  let config;
  try {
    config = JSON.parse(body);
  } catch {
    // The Firebase console shows a JavaScript object literal: unquoted keys, maybe a trailing comma.
    const jsonish = body.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}');
    try {
      config = JSON.parse(jsonish);
    } catch {
      throw new Error('That does not read as a Firebase configuration object.');
    }
  }
  for (const key of ['apiKey', 'projectId', 'appId']) {
    if (!config[key]) throw new Error(`The configuration is missing "${key}".`);
  }
  return config;
}

function openSettings() {
  const s = state.settings;
  $('fbConfig').value = s.firebase ? JSON.stringify(s.firebase, null, 2) : '';
  $('acProvider').value = (s.appCheck && s.appCheck.provider) || 'debug';
  $('acKey').value = (s.appCheck && (s.appCheck.provider === 'debug' ? (typeof s.appCheck.debugToken === 'string' ? s.appCheck.debugToken : '') : s.appCheck.siteKey)) || '';
  $('cloudModel').value = s.cloudModel || '';
  $('threshold').value = s.threshold;
  $('priceIn').value = s.priceIn;
  $('priceOut').value = s.priceOut;
  $('dryRun').checked = Boolean(s.dryRun);
  $('dryDevice').checked = Boolean(s.dryDevice);
  $('settingsError').hidden = true;
  syncKeyLabel();
  $('settings').showModal();
}

function syncKeyLabel() {
  const debug = $('acProvider').value === 'debug';
  $('acKeyLabel').textContent = debug ? 'Debug token' : 'Site key';
  $('acKey').placeholder = debug ? 'leave empty to have one printed in the console' : 'public reCAPTCHA site key';
}

function saveSettings(event) {
  event.preventDefault();
  try {
    const text = $('fbConfig').value.trim();
    const provider = $('acProvider').value;
    const key = $('acKey').value.trim();
    if (text && provider !== 'debug' && !key) throw new Error('reCAPTCHA needs its public site key.');
    const next = {
      firebase: text ? parseFirebaseConfig(text) : null,
      appCheck: provider === 'debug' ? { provider, debugToken: key || true } : { provider, siteKey: key },
      cloudModel: $('cloudModel').value.trim(),
      threshold: Number($('threshold').value) || DEFAULT_THRESHOLD,
      priceIn: Number($('priceIn').value),
      priceOut: Number($('priceOut').value),
      dryRun: $('dryRun').checked,
      dryDevice: $('dryDevice').checked,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    location.reload(); // Firebase can be initialised once per page; a reload is the honest reset.
  } catch (error) {
    $('settingsError').textContent = error.message;
    $('settingsError').hidden = false;
  }
}

// ---------- wiring ----------

function init() {
  $('samples').replaceChildren(...SAMPLES.map((sample) => el('button', {
    type: 'button', class: 'quiet', title: sample.hint, text: sample.title,
    onclick: () => {
      $('note').value = sample.note;
      $('lexicon').value = sample.lexicon;
      onNoteInput();
      $('note').focus();
    },
  })));

  function onNoteInput() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (state.busy === 'inspect') return;
      const note = $('note').value.trim();
      state.run = null;
      state.reviewView = null;
      state.preview = note ? redact(note, { lexicon: lexiconOf($('lexicon').value) }) : null;
      render();
    }, 120);
  }
  $('note').addEventListener('input', onNoteInput);
  $('lexicon').addEventListener('input', onNoteInput);
  $('note').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) inspect();
  });

  $('inspect').addEventListener('click', inspect);
  $('send').addEventListener('click', sendOrQueue);
  $('draft').addEventListener('click', () => review({ localOnly: true }));
  $('rehydrate').addEventListener('change', renderCloud);
  $('export').addEventListener('click', exportReport);
  $('airGap').addEventListener('change', (event) => {
    state.airGap = event.target.checked;
    recompute();
    render();
    flushQueue();
  });
  $('toggleLedger').addEventListener('click', () => {
    const ledgerBox = $('ledger');
    ledgerBox.hidden = !ledgerBox.hidden;
    $('toggleLedger').setAttribute('aria-expanded', String(!ledgerBox.hidden));
  });

  $('openSettings').addEventListener('click', openSettings);
  $('cancelSettings').addEventListener('click', () => $('settings').close());
  $('acProvider').addEventListener('change', syncKeyLabel);
  $('settingsForm').addEventListener('submit', saveSettings);
  $('forget').addEventListener('click', () => {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(QUEUE_KEY);
    location.reload();
  });

  const onNetwork = () => {
    state.online = navigator.onLine;
    recompute();
    render();
    flushQueue();
  };
  addEventListener('online', onNetwork);
  addEventListener('offline', onNetwork);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  render();
  connect();
}

init();
