import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybrid, EgressBlocked, DeviceUnavailable, STRUCTURE_SCHEMA } from '../src/hybrid.js';
import { createDryRunSdk } from '../src/dryrun.js';
import { redact } from '../src/redact.js';
import { readNote } from '../src/rules.js';
import { buildPacket, decide, TASK_MODE } from '../src/router.js';
import { createLedger, DEFAULT_PRICE } from '../src/telemetry.js';
import { SAMPLES, SAMPLE_SECRETS } from '../src/samples.js';

const clock = () => { let t = 0; return () => (t += 5); };
const setup = (env) => {
  const sdk = createDryRunSdk(env);
  return { sdk, hybrid: createHybrid(sdk, {}, { now: clock(), hasDeviceApi: env.hasDeviceApi || (() => true) }) };
};
const has = (hay, needle) => hay.toLowerCase().includes(needle.toLowerCase());

test('each task is created in the inference mode its data class demands', () => {
  const seen = [];
  const sdk = createDryRunSdk();
  const original = sdk.getGenerativeModel;
  sdk.getGenerativeModel = (ai, params) => { seen.push(params); return original(ai, params); };
  createHybrid(sdk, {});
  assert.deepEqual(seen.map((p) => p.mode), ['only_on_device', 'prefer_on_device', 'prefer_in_cloud', 'only_on_device', 'only_on_device']);
  assert.equal(seen[0].onDeviceParams.promptOptions.responseConstraint, STRUCTURE_SCHEMA);
  assert.equal(seen[0].inCloudParams, undefined, 'the raw-note task must not carry cloud parameters');
  assert.equal(seen[1].inCloudParams.model, 'gemini-3.5-flash-lite');
  assert.equal(seen[2].inCloudParams.model, 'gemini-3.5-flash-lite');
  assert.throws(() => sdk.getGenerativeModel({}, { mode: 'prefer_in_cloud', inCloudParams: {} }), /no-model/, 'the stand-in must reject what the real SDK rejects');
  assert.deepEqual(TASK_MODE, { structure: 'ONLY_ON_DEVICE', brief: 'PREFER_ON_DEVICE', review: 'PREFER_IN_CLOUD' });
});

test('a chosen cloud model is passed to both cloud-capable tasks', () => {
  const seen = [];
  const sdk = createDryRunSdk();
  const original = sdk.getGenerativeModel;
  sdk.getGenerativeModel = (ai, params) => { seen.push(params); return original(ai, params); };
  createHybrid(sdk, {}, { cloudModel: 'gemini-3.8-flash' });
  assert.deepEqual(seen.filter((p) => p.inCloudParams).map((p) => p.inCloudParams.model), ['gemini-3.8-flash', 'gemini-3.8-flash']);
});

test('a raw note never reaches the cloud, even with no on-device model and a live network', async () => {
  const { sdk, hybrid } = setup({ deviceAvailable: () => false, online: () => true });
  await assert.rejects(() => hybrid.structure(SAMPLES[0].note), /ONLY_ON_DEVICE/);
  assert.equal(sdk.calls.length, 0);
});

test('the SDK trap: with no Prompt API, ONLY_ON_DEVICE falls through to the cloud (stand-in mirrors SDK 13.4.0)', async () => {
  const sdk = createDryRunSdk({ promptApi: () => false, online: () => true });
  const model = sdk.getGenerativeModel({}, { mode: sdk.InferenceMode.ONLY_ON_DEVICE });
  const result = await model.generateContent('anything');
  assert.equal(result.response.inferenceSource, 'in_cloud');
});

test('Skela starts no local-only task in a browser without the Prompt API, so the trap cannot fire', async () => {
  const { sdk, hybrid } = setup({ promptApi: () => false, online: () => true, hasDeviceApi: () => false });
  await assert.rejects(() => hybrid.structure(SAMPLES[0].note), DeviceUnavailable);
  await assert.rejects(() => hybrid.brief('F1 [major] guardrail missing', [], {}, { localOnly: true }), DeviceUnavailable);
  await assert.rejects(() => hybrid.review('F1 [major] guardrail missing', [], {}, { localOnly: true }), DeviceUnavailable);
  await assert.rejects(() => hybrid.prepareDevice(), DeviceUnavailable);
  assert.equal(sdk.calls.length, 0);
});

test('if a local-only task is ever answered from the cloud, it fails loudly (negative control)', async () => {
  const { hybrid } = setup({ promptApi: () => false, online: () => true, hasDeviceApi: () => true });
  await assert.rejects(() => hybrid.structure('Crack 0.4 mm in slab.'), /answered from the cloud/);
});

test('with an on-device model the raw note is read locally', async () => {
  const { sdk, hybrid } = setup({ deviceAvailable: () => true, online: () => false });
  const out = await hybrid.structure(SAMPLES[0].note);
  assert.equal(out.source, 'on-device');
  assert.deepEqual(sdk.cloudCalls(), []);
  assert.ok(Array.isArray(out.findings) && Array.isArray(out.names));
});

test('the egress guard stops an unredacted packet before the SDK is called (negative control)', async () => {
  const { sdk, hybrid } = setup({ deviceAvailable: () => true, online: () => true });
  const vault = redact(SAMPLES[0].note).vault;
  await assert.rejects(() => hybrid.review(SAMPLES[0].note, vault), EgressBlocked);
  await assert.rejects(() => hybrid.brief(SAMPLES[0].note, vault), EgressBlocked);
  assert.equal(sdk.calls.length, 0);
});

for (const sample of SAMPLES) {
  test(`end to end "${sample.id}": nothing confidential is in any prompt that reached the cloud`, async () => {
    const { sdk, hybrid } = setup({ deviceAvailable: () => false, online: () => true });
    const lexicon = sample.lexicon ? [sample.lexicon] : [];
    const red = redact(sample.note, { lexicon });
    const read = readNote(red.text);
    const packet = buildPacket({ redactedText: red.text, findings: read.findings, asksRegulation: read.asksRegulation });

    const brief = await hybrid.brief(read.findings.map((f) => `${f.id} [${f.severity}] ${f.text}`).join('\n'), red.vault, { lexicon });
    const review = await hybrid.review(packet, red.vault, { lexicon });
    assert.equal(brief.source, 'cloud', 'no local model, so PREFER_ON_DEVICE fell back to the cloud');
    assert.equal(review.source, 'cloud');

    const sent = sdk.cloudCalls();
    assert.equal(sent.length, 2);
    for (const call of sent) {
      for (const secret of SAMPLE_SECRETS[sample.id]) {
        assert.ok(!has(call.prompt, secret), `"${secret}" reached the cloud in a ${call.mode} call`);
      }
    }
  });
}

test('PREFER_IN_CLOUD falls back to the device when the network is gone', async () => {
  const { sdk, hybrid } = setup({ deviceAvailable: () => true, online: () => false });
  const red = redact(SAMPLES[0].note, { lexicon: ['Feniks'] });
  const out = await hybrid.review(red.text, red.vault, { lexicon: ['Feniks'] });
  assert.equal(out.source, 'on-device');
  assert.deepEqual(sdk.cloudCalls(), []);
});

test('PREFER_ON_DEVICE stays local when a model is present', async () => {
  const { sdk, hybrid } = setup({ deviceAvailable: () => true, online: () => true });
  const out = await hybrid.brief('F1 [major] guardrail missing', []);
  assert.equal(out.source, 'on-device');
  assert.deepEqual(sdk.cloudCalls(), []);
});

test('localOnly (air-gap) calls cannot reach the cloud, with or without a local model', async () => {
  const absent = setup({ deviceAvailable: () => false, online: () => true });
  await assert.rejects(() => absent.hybrid.brief('F1 [major] guardrail missing', [], {}, { localOnly: true }), /ONLY_ON_DEVICE/);
  await assert.rejects(() => absent.hybrid.review('F1 [major] guardrail missing', [], {}, { localOnly: true }), /ONLY_ON_DEVICE/);
  assert.equal(absent.sdk.calls.length, 0);

  const present = setup({ deviceAvailable: () => true, online: () => true });
  const out = await present.hybrid.review('F1 [major] guardrail missing', [], {}, { localOnly: true });
  assert.equal(out.source, 'on-device');
  assert.deepEqual(present.sdk.cloudCalls(), []);
});

test('offline with no local model: the review fails loudly instead of pretending', async () => {
  const { hybrid } = setup({ deviceAvailable: () => false, online: () => false });
  await assert.rejects(() => hybrid.review('F1 [major] guardrail missing', []), /unreachable/);
});

test('router: one verdict per situation', () => {
  const red = redact(SAMPLES[0].note);
  const read = readNote(red.text);
  const base = { ...read, text: red.text, online: true, cloudReady: true, airGap: false, egressOk: true };
  assert.equal(decide(base).route, 'cloud');
  assert.equal(decide({ ...base, online: false }).route, 'queued');
  assert.equal(decide({ ...base, airGap: true }).route, 'device');
  assert.equal(decide({ ...base, cloudReady: false }).route, 'device');
  assert.equal(decide({ ...base, egressOk: false }).route, 'blocked');
  assert.equal(decide({ ...base, threshold: 99 }).route, 'device');

  const small = readNote(redact(SAMPLES[1].note).text);
  const verdict = decide({ ...small, text: SAMPLES[1].note, online: true, cloudReady: true, airGap: false, egressOk: true });
  assert.equal(verdict.route, 'device');
  assert.ok(verdict.score < verdict.threshold);
});

test('router: a long note exceeds the on-device input budget and is scored for it', () => {
  const long = 'Minor damp patch noted on the wall. '.repeat(900);
  const verdict = decide({ findings: [], asksRegulation: false, text: long, online: true, cloudReady: true, airGap: false, egressOk: true, threshold: 3 });
  assert.equal(verdict.route, 'cloud');
  assert.ok(verdict.reasons.some((r) => r.includes('on-device input budget')));
});

test('ledger: sums, measured against estimated, and money', () => {
  const ledger = createLedger();
  ledger.record({ task: 'read', source: 'rules', latencyMs: 2, online: false });
  ledger.record({ task: 'brief', source: 'on-device', latencyMs: 400, input: 'x'.repeat(400), output: 'y'.repeat(200), online: false });
  ledger.record({ task: 'review', source: 'cloud', latencyMs: 1800, usage: { promptTokenCount: 1000, candidatesTokenCount: 2000 }, online: true });
  ledger.counters.protectedFields = 9;
  const s = ledger.summary(DEFAULT_PRICE);
  assert.equal(s.deviceTokens, 150);
  assert.equal(s.cloudTokens, 3000);
  assert.equal(s.ruleRuns, 1);
  assert.equal(s.offlineDone, 2);
  assert.equal(s.tokensAllMeasured, false);
  assert.ok(Math.abs(s.cloudCost - (1000 * 0.30 + 2000 * 2.50) / 1e6) < 1e-12);
  assert.ok(Math.abs(s.savedCost - (100 * 0.30 + 50 * 2.50) / 1e6) < 1e-12);
  assert.equal(s.protectedFields, 9);
  assert.equal(ledger.rows[0].tokensIn + ledger.rows[0].tokensOut, 0, 'rule-engine runs are not model tokens');
  assert.equal(ledger.rows[2].tokensMeasured, true);
});
