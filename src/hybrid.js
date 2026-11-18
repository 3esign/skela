// Skela — hybrid inference over Firebase AI Logic.
// All model inference in this app goes through here, and all of it goes through the Firebase AI
// Logic SDK. The SDK is injected (see firebase.js for the real one) so this logic runs under
// test without a browser or a network.
//
// Three tasks, three inference modes, chosen by the class of data:
//   structure(raw note)        ONLY_ON_DEVICE    confidential text has no cloud fallback at all
//   brief(redacted findings)   PREFER_ON_DEVICE  either side is safe; the SDK reports which ran
//   review(anonymised packet)  PREFER_IN_CLOUD   deep cross-check; local fallback if cloud fails
//
// Anything that could reach the cloud passes the egress guard first. If the guard finds a
// confidential value, the SDK is never called.
//
// ONLY_ON_DEVICE is not enough on its own. In Firebase JS SDK 13.4.0, when the browser has no
// Prompt API at all (no `LanguageModel` global), no on-device adapter is created and
// `callCloudOrDevice` sends the request to the cloud whatever the mode says. We observed that
// request leave a Chrome without the Prompt API. So every local-only task first checks that the
// Prompt API exists, and afterwards checks that the SDK reports an on-device answer.

import { inspectEgress } from './redact.js';
import { TASK_MODE } from './router.js';
import { CATEGORIES, SEVERITY_ORDER } from './rules.js';

// Default cloud model of Firebase JS SDK 13.x for hybrid inference.
export const DEFAULT_CLOUD_MODEL = 'gemini-3.5-flash-lite';

export class DeviceUnavailable extends Error {
  constructor(message = 'This browser has no on-device model API, so a local-only task was not started.') {
    super(message);
    this.name = 'DeviceUnavailable';
  }
}

const LOCAL_ONLY = new Set(['structure', 'briefLocal', 'reviewLocal']);

export class EgressBlocked extends Error {
  constructor(leaks) {
    super(`Egress blocked: ${leaks.length} confidential value(s) in the outgoing text.`);
    this.name = 'EgressBlocked';
    this.leaks = leaks;
  }
}

// Plain JSON Schema: accepted by the Prompt API as `responseConstraint`.
export const STRUCTURE_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          element: { type: 'string' },
          issue: { type: 'string' },
          category: { type: 'string', enum: Object.keys(CATEGORIES) },
          measurement: { type: 'string' },
          severity: { type: 'string', enum: SEVERITY_ORDER },
        },
        required: ['element', 'issue', 'category', 'severity'],
      },
    },
    names: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'names'],
};

const PROMPTS = {
  structure: (note) => [
    'You are reading a construction site inspection note. Return JSON only.',
    '"findings": one item per distinct defect or safety problem, with the building element, the issue in a few words, a category, any measurement quoted exactly, and a severity (critical, major, minor, note).',
    '"names": every person name and company name that appears in the note, exactly as written. Empty list if none.',
    'Do not invent findings. Do not copy names, addresses or prices into findings.',
    '',
    'NOTE:',
    note,
  ].join('\n'),
  brief: (findingsText) => [
    'Write a site brief for the crew from these inspection findings, in plain English.',
    'Three short sentences at most, then a line "Do now:" with up to three actions, most urgent first.',
    'Bracketed tokens such as [PERSON_1] are placeholders. Keep them unchanged.',
    '',
    findingsText,
  ].join('\n'),
  review: (packet) => [
    'You are a senior structural and site-safety engineer reviewing an anonymised inspection packet.',
    'Write a review in Markdown with these sections: "Risk picture" (how the findings interact), "Likely causes", "Codes and standards to check" (name the document and the topic, and say plainly that the engineer must verify the clause and edition), "Actions" (ordered, with who should act), "Open questions for the site".',
    'Be specific to the findings. Do not pad. If the packet lacks something you need, say what.',
    'Bracketed tokens such as [PERSON_1] or [ADDRESS_1] are placeholders for confidential values removed on the device. Keep them unchanged and never guess what they stand for.',
    '',
    packet,
  ].join('\n'),
};

const sourceName = (inferenceSource) => (String(inferenceSource).toLowerCase().includes('device') ? 'on-device' : 'cloud');

/**
 * @param {object} sdk     { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from firebase/ai
 * @param {object} app     an initialised FirebaseApp
 * @param {object} options { cloudModel, now }
 */
export function createHybrid(sdk, app, options = {}) {
  const now = options.now || (() => performance.now());
  const hasDeviceApi = options.hasDeviceApi || (() => typeof globalThis.LanguageModel !== 'undefined');
  const ai = sdk.getAI(app, { backend: new sdk.GoogleAIBackend() });
  const english = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  // The SDK rejects inCloudParams without a model name ("no-model"), so it is always stated.
  const inCloud = (extra = {}) => ({ model: options.cloudModel || DEFAULT_CLOUD_MODEL, ...extra });

  const models = {
    structure: sdk.getGenerativeModel(ai, {
      mode: sdk.InferenceMode[TASK_MODE.structure],
      onDeviceParams: { createOptions: english, promptOptions: { responseConstraint: STRUCTURE_SCHEMA } },
    }),
    brief: sdk.getGenerativeModel(ai, {
      mode: sdk.InferenceMode[TASK_MODE.brief],
      inCloudParams: inCloud({ generationConfig: { maxOutputTokens: 300 } }),
      onDeviceParams: { createOptions: english },
    }),
    review: sdk.getGenerativeModel(ai, {
      mode: sdk.InferenceMode[TASK_MODE.review],
      inCloudParams: inCloud(),
      onDeviceParams: { createOptions: english },
    }),
    // Air-gap and offline drafts use these: the same tasks with no cloud path at all.
    briefLocal: sdk.getGenerativeModel(ai, { mode: sdk.InferenceMode.ONLY_ON_DEVICE, onDeviceParams: { createOptions: english } }),
    reviewLocal: sdk.getGenerativeModel(ai, { mode: sdk.InferenceMode.ONLY_ON_DEVICE, onDeviceParams: { createOptions: english } }),
  };

  async function run(task, prompt, model = task) {
    if (LOCAL_ONLY.has(model) && !hasDeviceApi()) throw new DeviceUnavailable();
    const started = now();
    const result = await models[model].generateContent(prompt);
    const response = result.response;
    if (LOCAL_ONLY.has(model) && sourceName(response.inferenceSource) !== 'on-device') {
      throw new Error(`A local-only task (${task}) was answered from the cloud. This must be reported.`);
    }
    const text = response.text();
    return {
      task,
      text,
      prompt,
      source: sourceName(response.inferenceSource),
      latencyMs: now() - started,
      usage: response.usageMetadata || null,
    };
  }

  function guard(text, vault, guardOptions) {
    const verdict = inspectEgress(text, vault, guardOptions);
    if (!verdict.ok) throw new EgressBlocked(verdict.leaks);
  }

  return {
    modes: TASK_MODE,

    /** Start (or await) the on-device model download. Must follow a user gesture. */
    prepareDevice(onProgress) {
      if (!hasDeviceApi()) return Promise.reject(new DeviceUnavailable());
      return models.structure.initializeDeviceModel(onProgress);
    },

    /** Raw note in, findings and names out. ONLY_ON_DEVICE: throws if no local model. */
    async structure(rawNote) {
      const out = await run('structure', PROMPTS.structure(rawNote));
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        parsed = { findings: [], names: [] };
        out.parseFailed = true;
      }
      return { ...out, findings: parsed.findings || [], names: parsed.names || [] };
    },

    /** Redacted findings in, crew brief out. Guarded, because the SDK may fall back to cloud.
     *  With localOnly the call uses an ONLY_ON_DEVICE model and cannot reach the cloud. */
    async brief(findingsText, vault, guardOptions, { localOnly = false } = {}) {
      guard(findingsText, vault, guardOptions);
      return run('brief', PROMPTS.brief(findingsText), localOnly ? 'briefLocal' : 'brief');
    },

    /** Anonymised packet in, engineering review out. Guarded. */
    async review(packet, vault, guardOptions, { localOnly = false } = {}) {
      guard(packet, vault, guardOptions);
      return run('review', PROMPTS.review(packet), localOnly ? 'reviewLocal' : 'review');
    },
  };
}
