// Skela — rule engine.
// A deterministic reader for field notes: it sorts sentences into findings, pulls out
// measurements and grades severity. It is NOT a language model and the interface never calls it
// one. It runs when no on-device model is available, and it always produces the safety checks.
//
// Thresholds below are triage hints for the person on site, not a compliance verdict. Each
// carries its source so an engineer can check it against the edition in force locally.

export const CATEGORIES = {
  structural: {
    label: 'Structure',
    words: ['crack', 'pukotin', 'prslin', 'deflection', 'ugib', 'spall', 'ljušt', 'ljust', 'delaminat', 'corrosion', 'corroded', 'korozij', 'rebar', 'reinforcement', 'armatur', 'honeycomb', 'segregacij', 'gnezd', 'settlement', 'sleganj', 'beam', 'greda', 'column', 'stub', 'slab', 'ploč', 'ploc', 'bearing', 'weld', 'zavar', 'bolt', 'vijak', 'formwork', 'oplat'],
    checks: ['Photograph the defect with a scale and mark its ends and date on the element.', 'Record width, length, pattern and position relative to supports.', 'Keep loads off the element until the engineer of record has assessed it.'],
  },
  fall: {
    label: 'Work at height',
    words: ['scaffold', 'skel', 'guardrail', 'guard rail', 'handrail', 'ograd', 'edge', 'ivic', 'harness', 'pojas', 'ladder', 'merdevin', 'opening', 'otvor', 'roof', 'krov', 'platform', 'toe board', 'toeboard', 'fall', 'pad sa visine'],
    checks: ['Close the area below and stop work at the unprotected edge.', 'Fit guardrail, mid-rail and toe board, or use a harness on a rated anchor.', 'Have a competent person inspect and tag the scaffold before reuse.'],
  },
  excavation: {
    label: 'Excavation',
    words: ['trench', 'rov', 'excavation', 'iskop', 'shoring', 'razupir', 'podgrad', 'slope', 'kosin', 'spoil', 'groundwater', 'podzemn'],
    checks: ['Keep people out of the excavation until its sides are supported or battered back.', 'Keep spoil and plant back from the edge.', 'Provide a ladder or ramp for exit and check for water and services.'],
  },
  electrical: {
    label: 'Electrical',
    words: ['cable', 'kabl', 'electrical', 'elektr', 'panel', 'orman', 'rcd', 'fid', 'grounding', 'earthing', 'uzemljenj', 'socket', 'utičn', 'uticn', 'live wire', 'exposed wire'],
    checks: ['Isolate and lock off the circuit before anyone touches it.', 'Replace damaged cable; do not tape it.', 'Test the residual-current device and record the result.'],
  },
  fire: {
    label: 'Fire',
    words: ['fire', 'požar', 'pozar', 'extinguisher', 'aparat za gašenje', 'welding', 'hot work', 'flammable', 'zapaljiv', 'gas cylinder', 'boca', 'escape route', 'evakuac'],
    checks: ['Clear combustibles from the hot-work area and post a fire watch.', 'Check that an extinguisher is within reach and in date.', 'Keep escape routes free and signed.'],
  },
  lifting: {
    label: 'Lifting',
    words: ['crane', 'kran', 'dizalic', 'hoist', 'sling', 'lifting', 'load', 'teret', 'outrigger', 'rigging'],
    checks: ['Stop the lift until the lifting plan and load chart are confirmed.', 'Inspect slings and shackles; remove damaged gear from site.', 'Keep everyone out from under the load path.'],
  },
  ppe: {
    label: 'Protective equipment',
    words: ['helmet', 'hard hat', 'šlem', 'slem', 'kacig', 'ppe', 'gloves', 'rukavic', 'goggles', 'naočar', 'naocar', 'vest', 'prsluk', 'boots', 'cipel'],
    checks: ['Stop the task until the missing equipment is worn.', 'Brief the crew and record the briefing.'],
  },
  water: {
    label: 'Water and envelope',
    words: ['leak', 'curenj', 'procur', 'moisture', 'vlag', 'damp', 'waterproof', 'hidroizolacij', 'membrane', 'drain', 'odvod', 'ponding'],
    checks: ['Trace the water to its source before repairing finishes.', 'Protect electrical installations and stored materials nearby.', 'Record the extent with photographs after rain.'],
  },
};

const NEGATIVE = /\b(missing|no |not |without|absent|removed|damaged|broken|loose|unsecured|unprotected|exposed|uncovered|expired|nema|bez |nedostaj|oštećen|ostecen|polomljen|neobezbe|nezaštić|nezastic|otkriven)/i;
const UNIT = '(mm|cm|m|kN|MPa|°|%)';
const MEASURE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s?${UNIT}(?![\\p{L}\\p{N}])`, 'gu');
const REGULATORY = /\b(code|standard|eurocode|\bEN\s?\d|osha|regulation|compliance|permit|propis|pravilnik|standard|dozvol|normativ|is this (?:allowed|acceptable)|da li je dozvoljeno)/i;

const toMetres = (value, unit) => (unit === 'mm' ? value / 1000 : unit === 'cm' ? value / 100 : unit === 'm' ? value : null);
const toMillimetres = (value, unit) => (unit === 'mm' ? value : unit === 'cm' ? value * 10 : unit === 'm' ? value * 1000 : null);

// Severity rules. `basis` is shown next to every finding so the grade can be argued with.
const RULES = [
  {
    id: 'crack-1mm',
    test: (f) => /crack|pukotin|prslin/i.test(f.text) && f.measurements.some((m) => toMillimetres(m.value, m.unit) >= 1 && toMillimetres(m.value, m.unit) <= 50),
    severity: 'critical',
    basis: 'Crack width 1 mm or more: treat as possibly structural until an engineer says otherwise (Skela triage rule).',
  },
  {
    id: 'crack-ec2',
    test: (f) => /crack|pukotin|prslin/i.test(f.text) && f.measurements.some((m) => toMillimetres(m.value, m.unit) >= 0.3 && toMillimetres(m.value, m.unit) < 1),
    severity: 'major',
    basis: 'Crack width at or above 0.3 mm, the recommended limit for most exposure classes in EN 1992-1-1 Table 7.1N. Check the exposure class.',
  },
  {
    id: 'fall-height',
    test: (f) => f.category === 'fall' && NEGATIVE.test(f.text) && f.measurements.some((m) => toMetres(m.value, m.unit) >= 1.8),
    severity: 'critical',
    basis: 'Unprotected work 1.8 m or more above a lower level (US OSHA 29 CFR 1926.501(b)(1) uses 6 ft; check the local threshold).',
  },
  {
    id: 'trench-depth',
    test: (f) => f.category === 'excavation' && NEGATIVE.test(f.text) && f.measurements.some((m) => toMetres(m.value, m.unit) >= 1.5),
    severity: 'critical',
    basis: 'Excavation 1.5 m or deeper without a protective system (US OSHA 29 CFR 1926.652(a)(1) uses 5 ft; check the local threshold).',
  },
  {
    id: 'exposed-rebar',
    test: (f) => /(exposed|otkriven|vidljiv).{0,30}(rebar|reinforcement|armatur)|(rebar|reinforcement|armatur).{0,30}(exposed|corro|otkriven|koroz)/i.test(f.text),
    severity: 'major',
    basis: 'Exposed or corroding reinforcement: cover is lost and section loss may follow (Skela triage rule).',
  },
  {
    id: 'live-electrical',
    test: (f) => f.category === 'electrical' && NEGATIVE.test(f.text),
    severity: 'major',
    basis: 'Damaged or unprotected electrical installation (Skela triage rule).',
  },
  {
    id: 'missing-protection',
    test: (f) => ['fall', 'excavation', 'lifting', 'fire', 'ppe'].includes(f.category) && NEGATIVE.test(f.text),
    severity: 'major',
    basis: 'A protective measure is reported missing or damaged (Skela triage rule).',
  },
];

export const SEVERITY_ORDER = ['critical', 'major', 'minor', 'note'];

// Words match from the start of a word only, so "rov" (trench) does not fire inside "improve".
const WORD_RE = Object.fromEntries(Object.entries(CATEGORIES).map(([key, cat]) => [
  key,
  cat.words.map((w) => new RegExp(`(?<![\\p{L}])${w.replace(/\s+/g, '\\s+')}`, 'iu')),
]));

// On a tie the earlier category wins, so safety readings come before structure: "two workers
// without helmets at the rebar yard" is a helmet problem, not a rebar problem.
const TIE_ORDER = ['fall', 'excavation', 'electrical', 'fire', 'lifting', 'ppe', 'structural', 'water'];

function categorise(sentence) {
  let best = null;
  let bestScore = 0;
  for (const key of TIE_ORDER) {
    const score = WORD_RE[key].reduce((n, re) => n + (re.test(sentence) ? 1 : 0), 0);
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

function measurementsIn(sentence) {
  return [...sentence.matchAll(MEASURE)].map((m) => ({ value: Number(m[1].replace(',', '.')), unit: m[2], raw: m[0] }));
}

/** Grade one finding. Used for rule-engine findings and to cross-check model findings. */
export function grade(finding) {
  for (const rule of RULES) {
    if (rule.test(finding)) return { severity: rule.severity, basis: rule.basis, rule: rule.id };
  }
  return { severity: finding.category ? 'minor' : 'note', basis: 'No threshold rule matched; recorded as an observation.', rule: null };
}

/**
 * Read a redacted field note into findings.
 * @param {string} redactedText text that has already been through redact()
 */
export function readNote(redactedText) {
  const sentences = redactedText
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\[\d])|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && !s.endsWith('?')); // a question is not a finding

  const findings = [];
  for (const sentence of sentences) {
    const category = categorise(sentence);
    if (!category) continue;
    const finding = { text: sentence, category, measurements: measurementsIn(sentence) };
    Object.assign(finding, grade(finding));
    finding.checks = CATEGORIES[category].checks;
    findings.push(finding);
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  findings.forEach((f, i) => { f.id = `F${i + 1}`; });
  return { findings, asksRegulation: REGULATORY.test(redactedText), sentences: sentences.length };
}

/** Turn model output (already schema-shaped) into the same finding objects, graded by the rules. */
export function fromModel(items) {
  const findings = [];
  for (const item of items || []) {
    const text = [item.element, item.issue].filter(Boolean).join(': ') + (item.measurement ? ` (${item.measurement})` : '');
    if (!text.trim()) continue;
    const category = CATEGORIES[item.category] ? item.category : categorise(text);
    const finding = { text, category, measurements: measurementsIn(text) };
    const ruled = grade(finding);
    // The stricter of the two grades wins: a model may not talk a threshold breach down.
    const modelSeverity = SEVERITY_ORDER.includes(item.severity) ? item.severity : 'note';
    const stricter = SEVERITY_ORDER.indexOf(ruled.severity) <= SEVERITY_ORDER.indexOf(modelSeverity);
    finding.severity = stricter ? ruled.severity : modelSeverity;
    finding.basis = stricter && ruled.rule ? ruled.basis : `Graded ${modelSeverity} by the on-device model; no stricter threshold rule matched.`;
    finding.rule = stricter ? ruled.rule : null;
    finding.checks = category ? CATEGORIES[category].checks : [];
    findings.push(finding);
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  findings.forEach((f, i) => { f.id = `F${i + 1}`; });
  return findings;
}
