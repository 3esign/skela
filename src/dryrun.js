// Skela — dry-run SDK.
// A stand-in with the same surface as the part of `firebase/ai` that hybrid.js uses. It calls no
// model and no network. It exists for two reasons: the tests need to observe exactly what would
// be sent and in which inference mode, and the interface can be rehearsed before a Firebase
// project is connected. Every text it returns starts with "DRY RUN", and the app shows a
// permanent banner while it is active.
//
// Mode semantics copy the Firebase JS SDK 13.4.0 (`callCloudOrDevice` in firebase-ai.js):
//   no Prompt API     cloud, whatever the mode (the SDK creates no on-device adapter)
//   ONLY_ON_DEVICE    device if available, otherwise throw
//   PREFER_ON_DEVICE  device if available, otherwise cloud
//   PREFER_IN_CLOUD   cloud; on a fetch error, device if available
//   ONLY_IN_CLOUD     cloud

export const DRY_RUN_STAMP = 'DRY RUN: canned text, no model was called.';

export function createDryRunSdk({ deviceAvailable = () => false, online = () => true, promptApi = () => true, delay = 0 } = {}) {
  const calls = [];
  const wait = () => (delay ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve());

  const InferenceMode = {
    PREFER_ON_DEVICE: 'prefer_on_device',
    ONLY_ON_DEVICE: 'only_on_device',
    ONLY_IN_CLOUD: 'only_in_cloud',
    PREFER_IN_CLOUD: 'prefer_in_cloud',
  };

  function answer(prompt) {
    if (prompt.startsWith('You are reading a construction site inspection note')) {
      return JSON.stringify({ findings: [], names: [] });
    }
    const placeholders = [...new Set(prompt.match(/\[[A-Z]+_\d+\]/g) || [])];
    const findings = (prompt.match(/^F\d+ \[/gm) || []).length;
    if (prompt.startsWith('Write a site brief')) {
      return `${DRY_RUN_STAMP} A real brief would summarise ${findings || 'the'} findings here.\nDo now: (dry run)`;
    }
    return [
      DRY_RUN_STAMP,
      '',
      '## What arrived',
      `A packet with ${findings} findings and ${placeholders.length} placeholders.`,
      placeholders.length ? `Placeholders seen, unchanged: ${placeholders.join(', ')}.` : 'No placeholders in the packet.',
      '',
      '## What a real review adds',
      'Risk picture, likely causes, codes to check, ordered actions and open questions, written by the cloud model.',
    ].join('\n');
  }

  function getGenerativeModel(ai, params) {
    const mode = params.mode;
    // Same check as the real SDK: cloud parameters without a model name are an error.
    if (params.inCloudParams && !params.inCloudParams.model) {
      throw new Error('no-model: Must provide a model name.');
    }
    return {
      params,
      async initializeDeviceModel(onProgress) {
        if (!deviceAvailable() && mode === InferenceMode.ONLY_ON_DEVICE) throw new Error('Local LanguageModel API not available in this environment.');
        if (onProgress) onProgress(1);
      },
      async generateContent(prompt) {
        await wait();
        const device = deviceAvailable();
        let source;
        if (!promptApi()) {
          source = 'in_cloud';
        } else if (mode === InferenceMode.ONLY_ON_DEVICE) {
          if (!device) throw new Error('Inference mode is ONLY_ON_DEVICE, but an on-device model is not available.');
          source = 'on_device';
        } else if (mode === InferenceMode.PREFER_ON_DEVICE) {
          source = device ? 'on_device' : 'in_cloud';
        } else if (mode === InferenceMode.PREFER_IN_CLOUD) {
          source = online() ? 'in_cloud' : device ? 'on_device' : null;
        } else {
          source = 'in_cloud';
        }
        if (source === 'in_cloud' && !online()) source = null;
        if (!source) throw new Error('fetch-error: the cloud is unreachable and no on-device model is available.');
        calls.push({ mode, source, prompt });
        const text = answer(prompt);
        return { response: { text: () => text, inferenceSource: source, usageMetadata: null } };
      },
    };
  }

  return {
    calls,
    cloudCalls: () => calls.filter((c) => c.source === 'in_cloud'),
    InferenceMode,
    GoogleAIBackend: class GoogleAIBackend {},
    getAI: () => ({ dryRun: true }),
    getGenerativeModel,
  };
}
