// Skela — hybrid router.
// Decides, for one inspection, whether the work stays on the device or an anonymised packet is
// offered to the cloud. The decision is a pure function of what it is given, and every reason
// it returns is shown to the user.
//
// Privacy is typed, not hoped for: the inference mode follows the class of data.
//   raw note          -> ONLY_ON_DEVICE    (confidential text never has a cloud fallback)
//   redacted findings -> PREFER_ON_DEVICE  (safe either way; local is free and works offline)
//   anonymised packet -> PREFER_IN_CLOUD   (needs depth; falls back to local if the cloud fails)

export const TASK_MODE = {
  structure: 'ONLY_ON_DEVICE',
  brief: 'PREFER_ON_DEVICE',
  review: 'PREFER_IN_CLOUD',
};

// The on-device model accepts at most 9216 tokens (Firebase AI Logic hybrid docs, checked
// 2026-11-18). Leave room for the instruction and the answer.
export const ON_DEVICE_TOKEN_LIMIT = 9216;
export const ON_DEVICE_INPUT_BUDGET = 6000;
export const DEFAULT_THRESHOLD = 4;

export const estimateTokens = (text) => Math.ceil((text || '').length / 4);

/** Complexity of an inspection, with the parts that make it up. */
export function complexity({ findings = [], asksRegulation = false, text = '' }) {
  const parts = [];
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const major = findings.filter((f) => f.severity === 'major').length;
  const categories = new Set(findings.map((f) => f.category).filter(Boolean)).size;
  const tokens = estimateTokens(text);

  if (critical) parts.push({ points: critical * 2, why: `${critical} critical finding${critical > 1 ? 's' : ''}` });
  if (major) parts.push({ points: major, why: `${major} major finding${major > 1 ? 's' : ''}` });
  if (categories >= 3) parts.push({ points: 2, why: `${categories} disciplines interact` });
  if (asksRegulation) parts.push({ points: 2, why: 'the note asks about codes or compliance' });
  if (tokens > ON_DEVICE_INPUT_BUDGET) parts.push({ points: 3, why: `about ${tokens} tokens, over the on-device input budget of ${ON_DEVICE_INPUT_BUDGET}` });

  return { score: parts.reduce((n, p) => n + p.points, 0), parts };
}

/**
 * Route one inspection.
 * @returns {{route: 'device'|'cloud'|'queued'|'blocked', mode: string|null, score: number, reasons: string[]}}
 */
export function decide({ findings, asksRegulation, text, online, cloudReady, airGap, egressOk, threshold = DEFAULT_THRESHOLD }) {
  const { score, parts } = complexity({ findings, asksRegulation, text });
  const reasons = parts.map((p) => `+${p.points} ${p.why}`);
  const base = { score, threshold, reasons };

  if (score < threshold) {
    return { ...base, route: 'device', mode: TASK_MODE.brief, verdict: `Complexity ${score} is under the threshold of ${threshold}: the device handles this alone.` };
  }
  if (airGap) {
    return { ...base, route: 'device', mode: TASK_MODE.brief, verdict: `Complexity ${score} would justify a cloud review, but air-gap is on: nothing leaves this device.` };
  }
  if (!egressOk) {
    return { ...base, route: 'blocked', mode: null, verdict: 'The egress guard found confidential values in the packet. Sending is blocked until they are redacted.' };
  }
  if (!cloudReady) {
    return { ...base, route: 'device', mode: TASK_MODE.brief, verdict: `Complexity ${score} would justify a cloud review, but no cloud model is connected.` };
  }
  if (!online) {
    return { ...base, route: 'queued', mode: TASK_MODE.review, verdict: `Complexity ${score} justifies a cloud review. There is no network, so the anonymised packet waits in the queue.` };
  }
  return { ...base, route: 'cloud', mode: TASK_MODE.review, verdict: `Complexity ${score} is at or over the threshold of ${threshold}: the anonymised packet may go to the cloud.` };
}

/** The exact text that crosses the browser boundary. Built only from redacted material. */
export function buildPacket({ redactedText, findings, asksRegulation }) {
  const lines = [
    'SITE INSPECTION PACKET (anonymised on device; tokens in square brackets are placeholders, keep them unchanged)',
    '',
    'FINDINGS',
    ...findings.map((f) => `${f.id} [${f.severity}] [${f.category || 'general'}] ${f.text}`),
    '',
    'FIELD NOTE',
    redactedText.trim(),
  ];
  if (asksRegulation) lines.push('', 'The inspector asks which codes or regulations apply.');
  return lines.join('\n');
}
