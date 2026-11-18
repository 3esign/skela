// Skela — telemetry ledger.
// Every inference and every rule-engine run is one row. The HUD is a sum over these rows and
// nothing else, so each number on screen can be traced to the calls that produced it.
//
// Measured: latency (performance clock), inference source (reported by the Firebase AI Logic
// SDK), cloud token counts when the response carries usage metadata, redaction counts.
// Estimated: token counts without usage metadata (characters / 4), and all money. Estimates are
// flagged per row and the HUD marks them with "≈".

import { estimateTokens } from './router.js';

// Paid-tier list price of the default cloud model, gemini-3.5-flash-lite, in USD per million
// tokens. Source: ai.google.dev/gemini-api/docs/pricing, read 2026-11-18. Editable in Settings.
export const DEFAULT_PRICE = { inputPerMillion: 0.30, outputPerMillion: 2.50, model: 'gemini-3.5-flash-lite', checked: '2026-11-18' };

export const SOURCES = ['on-device', 'cloud', 'rules'];

export function createLedger() {
  const rows = [];
  const counters = { protectedFields: 0, blockedEgress: 0, queued: 0, flushed: 0 };

  return {
    rows,
    counters,

    /** Record one unit of work. */
    record({ task, source, latencyMs, input = '', output = '', usage = null, online = true, simulated = false }) {
      const measured = Boolean(usage && Number.isFinite(usage.promptTokenCount));
      const row = {
        at: Date.now(),
        task,
        source,
        latencyMs: Math.round(latencyMs),
        tokensIn: source === 'rules' ? 0 : measured ? usage.promptTokenCount : estimateTokens(input),
        tokensOut: source === 'rules' ? 0 : measured ? (usage.candidatesTokenCount || 0) : estimateTokens(output),
        tokensMeasured: measured,
        online,
        simulated,
      };
      rows.push(row);
      return row;
    },

    summary(price = DEFAULT_PRICE) {
      const of = (source) => rows.filter((r) => r.source === source);
      const sum = (list, key) => list.reduce((n, r) => n + r[key], 0);
      const mean = (list) => (list.length ? Math.round(sum(list, 'latencyMs') / list.length) : null);
      const cost = (list) => (sum(list, 'tokensIn') * price.inputPerMillion + sum(list, 'tokensOut') * price.outputPerMillion) / 1e6;
      const device = of('on-device');
      const cloud = of('cloud');
      const rules = of('rules');
      return {
        deviceTokens: sum(device, 'tokensIn') + sum(device, 'tokensOut'),
        cloudTokens: sum(cloud, 'tokensIn') + sum(cloud, 'tokensOut'),
        deviceCalls: device.length,
        cloudCalls: cloud.length,
        ruleRuns: rules.length,
        deviceLatency: mean(device),
        cloudLatency: mean(cloud),
        rulesLatency: mean(rules),
        cloudCost: cost(cloud),
        // What the on-device model calls would have cost at the cloud price. Rule-engine runs
        // are not counted: they never were model tokens.
        savedCost: cost(device),
        offlineDone: rows.filter((r) => !r.online && r.source !== 'cloud').length,
        tokensAllMeasured: [...device, ...cloud].every((r) => r.tokensMeasured),
        simulated: rows.some((r) => r.simulated),
        ...counters,
      };
    },
  };
}

export function formatUsd(value) {
  if (!value) return '$0';
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(3)}`;
}
