// Skela — local redaction.
// One sentence: confidential values are replaced by placeholders on this device, and the
// originals stay in a vault that never leaves it.
//
// Everything here is deterministic and synchronous. No network, no model. The on-device model
// may *add* names it spots (see `extraTerms`), but the guarantee comes from this file.

const L = '\\p{L}';
const N = '\\p{N}';
const NOT_WORD_BEFORE = `(?<![${L}${N}])`;
const NOT_WORD_AFTER = `(?![${L}${N}])`;

const NUM = '(?:\\d{1,3}(?:[.,\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const CURRENCY = '(?:EUR|eur|evra|eura|evro|RSD|rsd|din\\.?|dinara|USD|usd|dollars?|GBP|CHF|€|\\$|£)';
const SCALE = '(?:\\s?(?:k|K|M|mil\\.?|miliona|million|hiljada|thousand))?';

const PARTY_LABELS = [
  'Investitor', 'Investor', 'Naručilac', 'Narucilac', 'Klijent', 'Client', 'Owner', 'Developer',
  'Glavni izvođač', 'Izvođač radova', 'Izvođač', 'Izvodjac', 'General contractor', 'Contractor',
  'Subcontractor', 'Podizvođač', 'Stručni nadzor', 'Nadzorni organ', 'Nadzor', 'Supervisor',
  'Site manager', 'Site engineer', 'Odgovorni izvođač', 'Projektant', 'Designer', 'Inspector',
  'Contact person', 'Contact', 'Kontakt', 'Tenant', 'Zakupac', 'Reported by', 'Prijavio',
];
const ADDRESS_LABELS = ['Site address', 'Address', 'Adresa objekta', 'Adresa', 'Lokacija objekta', 'Lokacija', 'Location'];
const AMOUNT_LABELS = [
  'contract value', 'vrednost ugovora', 'vrednost radova', 'ugovorena cena', 'unit price', 'jedinična cena',
  'price', 'cena', 'cijena', 'budget', 'budžet', 'budzet', 'invoice', 'faktura', 'penalty', 'penali', 'fee', 'iznos',
];
const COMPANY_SUFFIX = '(?:d\\.\\s?o\\.\\s?o\\.|doo|DOO|a\\.\\s?d\\.|d\\.\\s?d\\.|j\\.\\s?p\\.|LLC|Ltd\\.?|GmbH|Inc\\.?|S\\.A\\.|S\\.p\\.A\\.|B\\.V\\.|AG|PLC)';
const TITLES = '(?:Mr\\.?|Mrs\\.?|Ms\\.?|Dr\\.?|Eng\\.?|Prof\\.?|g\\.|gdin\\.?|gđa\\.?|gospodin|gospođa|inž\\.|ing\\.|arh\\.|dipl\\.\\s?(?:inž|ing|građ)\\.?(?:\\s?(?:građ|arh|el|maš)\\.?)?)';
const NAME_WORD = `\\p{Lu}[\\p{Ll}'’-]+`;

const alt = (list) => list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');

// Each detector: kind, how it was found, a regex, and optionally which capture group holds the
// confidential value (the label around it is kept so the text stays readable).
// Order is priority: when two detectors overlap, the earlier one wins.
const DETECTORS = [
  { kind: 'EMAIL', via: 'pattern', re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  { kind: 'ACCOUNT', via: 'pattern', re: /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu },
  { kind: 'ACCOUNT', via: 'pattern', re: /(?<![\p{N}\/-])\d{3}-\d{5,13}-\d{2}(?![\p{N}-])/gu },
  { kind: 'ID', via: 'pattern', re: /(?<![\p{N}])\d{13}(?![\p{N}])/gu, note: (v) => (isValidJmbg(v) ? 'checksum' : 'pattern') },
  { kind: 'ID', via: 'label', group: 1, re: /(?:ID\s*card|passport|pasoš|pasos|lična\s+karta|licna\s+karta|l\.\s?k\.)\s*(?:no\.?|number|br\.?|broj)?\s*[:#]?\s*([A-Z0-9]{6,12})(?![\p{L}\p{N}])/giu },
  { kind: 'TAX', via: 'label', group: 1, re: /(?<![\p{L}])(?:PIB|VAT(?:\s+(?:no\.?|number|ID))?|Tax\s+ID|TIN|poreski\s+broj)\s*[:#.]?\s*((?:RS)?\d{8,12})(?![\p{N}])/giu },
  { kind: 'TAX', via: 'label', group: 1, re: /(?<![\p{L}])(?:MB|matični\s+broj|maticni\s+broj|mat\.\s?br\.|Reg(?:istration)?\.?\s*(?:no\.?|number))\s*[:#.]?\s*(\d{8})(?![\p{N}])/giu },
  { kind: 'TAX', via: 'checksum', re: /(?<![\p{N}.,])\d{9}(?![\p{N}])/gu, keep: isValidPib },
  { kind: 'GEO', via: 'pattern', re: /(?<![\p{N}.])-?\d{1,2}\.\d{4,7}\s*°?\s*[NS]?\s*,\s*-?\d{1,3}\.\d{4,7}\s*°?\s*[EW]?/gu },
  { kind: 'PARTY', via: 'label', group: 1, re: new RegExp(`(?<![${L}])(?:${alt(PARTY_LABELS)})\\s*[:–-]\\s*([^\\n;,]+)`, 'giu') },
  { kind: 'ADDRESS', via: 'label', group: 1, re: new RegExp(`(?<![${L}])(?:${alt(ADDRESS_LABELS)})\\s*[:–-]\\s*([^\\n;]+)`, 'giu') },
  { kind: 'ADDRESS', via: 'pattern', re: new RegExp(`(?<![${L}])(?:ul\\.|ulica|bulevar|bul\\.|trg|aleja|kej|šetalište)\\s+(?:[${L}.]+\\s+){0,4}?(?:\\d{1,4}[a-zA-Z]?(?:\\/\\d{1,3})?|bb)${NOT_WORD_AFTER}`, 'giu') },
  { kind: 'ADDRESS', via: 'pattern', re: new RegExp(`${NOT_WORD_BEFORE}\\d{1,5}\\s+(?:\\p{Lu}[${L}.']*\\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl)\\.?(?![${L}])`, 'gu') },
  { kind: 'PARCEL', via: 'pattern', re: new RegExp(`(?<![${L}])(?:k\\.\\s?p\\.|kat\\.\\s?parc\\.|kat\\.\\s?parcela|katastarska\\s+parcela|parcela|cadastral\\s+parcel|parcel)\\s*(?:br\\.?|no\\.?)?\\s*\\d+(?:\\/\\d+)?(?:\\s*,?\\s*K\\.\\s?O\\.\\s+\\p{Lu}[${L}]+(?:\\s\\p{Lu}[${L}]+)?)?`, 'giu') },
  { kind: 'PHONE', via: 'pattern', re: /(?<![\p{L}\p{N}])(?:\+|00)\d{1,3}[\s\-\/]?(?:\(?\d{1,4}\)?[\s\-\/]?){2,5}\d{2,4}(?![\p{N}])/gu },
  { kind: 'PHONE', via: 'pattern', re: /(?<![\p{L}\p{N}.,])0\d{1,2}[\s\/\-]\d{2,4}[\s\-]?\d{2,4}(?:[\s\-]?\d{2,4})?(?![\p{N}])/gu, keep: (v) => !/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(v) },
  { kind: 'AMOUNT', via: 'pattern', re: new RegExp(`(?:€|\\$|£)\\s?${NUM}${SCALE}`, 'gu') },
  { kind: 'AMOUNT', via: 'pattern', re: new RegExp(`(?<![${L}${N}.,])${NUM}${SCALE}\\s?${CURRENCY}(?![${L}])`, 'gu') },
  { kind: 'AMOUNT', via: 'label', group: 1, re: new RegExp(`(?<![${L}])(?:${alt(AMOUNT_LABELS)})\\s*(?:[:=]|is|je|of)?\\s*(${NUM}${SCALE})(?![${L}${N}])`, 'giu') },
  { kind: 'COMPANY', via: 'pattern', re: new RegExp(`(?<![${L}])\\p{Lu}[${L}${N}&.-]*(?:\\s+[\\p{Lu}${N}][${L}${N}&.-]*){0,3}\\s+${COMPANY_SUFFIX}(?![${L}])`, 'gu') },
  { kind: 'PERSON', via: 'pattern', group: 1, re: new RegExp(`(?<![${L}])${TITLES}\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`, 'gu') },
];

export const KIND_LABEL = {
  EMAIL: 'e-mail', ACCOUNT: 'bank account', ID: 'personal ID', TAX: 'tax / company ID', GEO: 'coordinates',
  PARTY: 'named party', ADDRESS: 'address', PARCEL: 'cadastral parcel', PHONE: 'phone', AMOUNT: 'money',
  COMPANY: 'company', PERSON: 'person', TERM: 'your term',
};

/** Serbian personal number (JMBG): 13 digits, modulo-11 control digit. */
export function isValidJmbg(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const d = [...value].map(Number);
  const sum = 7 * (d[0] + d[6]) + 6 * (d[1] + d[7]) + 5 * (d[2] + d[8]) + 4 * (d[3] + d[9]) + 3 * (d[4] + d[10]) + 2 * (d[5] + d[11]);
  const m = 11 - (sum % 11);
  if (m === 10) return false;
  return (m === 11 ? 0 : m) === d[12];
}

/** Serbian tax number (PIB): 9 digits, ISO 7064 MOD 11,10 control digit. */
export function isValidPib(value) {
  if (!/^\d{9}$/.test(value)) return false;
  const d = [...value].map(Number);
  let s = 10;
  for (let i = 0; i < 8; i++) {
    s = (s + d[i]) % 10;
    if (s === 0) s = 10;
    s = (s * 2) % 11;
  }
  return (11 - s) % 10 === d[8];
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function collect(text) {
  const hits = [];
  DETECTORS.forEach((det, priority) => {
    const re = new RegExp(det.re.source, det.re.flags.includes('d') ? det.re.flags : det.re.flags + 'd');
    for (const m of text.matchAll(re)) {
      const g = det.group || 0;
      if (m[g] == null) continue;
      let [start, end] = m.indices[g];
      let value = m[g];
      // Drop trailing punctuation, but keep the dot of an abbreviation such as "d.o.o." or "din.".
      let trimmed = value.replace(/[\s,:]+$/u, '');
      if (/\.$/.test(trimmed) && !/(?:^|[\s.])\p{L}{1,3}\.$/u.test(trimmed)) trimmed = trimmed.replace(/[\s.,:]+$/u, '');
      end -= value.length - trimmed.length;
      value = trimmed;
      const lead = value.length - value.trimStart().length;
      start += lead;
      value = value.trimStart();
      if (!value) continue;
      // Already redacted: a labelled field whose value is nothing but placeholders.
      if (!/[\p{L}\p{N}]/u.test(value.replace(/\[[A-Z]+_\d+\]/g, ''))) continue;
      if (det.keep && !det.keep(value)) continue;
      hits.push({ start, end, value, kind: det.kind, via: det.note ? det.note(value) : det.via, priority });
    }
  });
  return hits;
}

// Terms that must be hidden wherever they appear: the user's own list, names the on-device model
// reported, and the words of people and parties already found by pattern (so "Mr. Jovan Petrović"
// also hides a later bare "Petrović"). A short inflection tail is allowed, because Serbian
// declines names: Petrović, Petrovića, Petroviću.
const termBody = (term) => term.trim().split(/\s+/).map(escapeRe).join('\\s+');
const termRegex = (term, flags = 'giu') => new RegExp(`(?<![${L}${N}])${termBody(term)}[${L}]{0,3}${NOT_WORD_AFTER}`, flags);

function collectTerms(text, terms) {
  const hits = [];
  for (const t of terms) {
    const term = t.term.trim();
    if (term.length < 3) continue;
    const re = termRegex(term, 'giud');
    for (const m of text.matchAll(re)) {
      hits.push({ start: m.indices[0][0], end: m.indices[0][1], value: m[0], kind: t.kind, via: t.via, priority: 100, parent: t.parent });
    }
  }
  return hits;
}

function resolveOverlaps(hits) {
  const ordered = [...hits].sort((a, b) => a.priority - b.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken = [];
  for (const h of ordered) {
    if (!taken.some((t) => h.start < t.end && t.start < h.end)) taken.push(h);
  }
  return taken.sort((a, b) => a.start - b.start);
}

/**
 * Redact `text`.
 * @param {string} text  raw field note
 * @param {object} [options]
 * @param {string[]} [options.lexicon]     terms the user marked confidential
 * @param {string[]} [options.extraTerms]  names reported by the on-device model
 * @returns {{text: string, vault: Array, counts: Record<string, number>, total: number}}
 */
export function redact(text, options = {}) {
  const lexicon = (options.lexicon || []).map((s) => s.trim()).filter(Boolean);
  const extra = (options.extraTerms || []).map((s) => s.trim()).filter(Boolean);
  const patternHits = resolveOverlaps(collect(text));

  const terms = [
    ...lexicon.map((term) => ({ term, kind: 'TERM', via: 'your list' })),
    ...extra.map((term) => ({ term, kind: 'PERSON', via: 'on-device model' })),
  ];
  const isTitle = (w) => new RegExp(`^${TITLES}$`, 'u').test(w);
  const isNameWord = (w) => new RegExp(`^${NAME_WORD}$`, 'u').test(w);
  const suffixRe = new RegExp(`\\s+${COMPANY_SUFFIX}$`, 'u');
  for (const h of patternHits) {
    const parent = norm(h.value);
    if (h.kind === 'COMPANY' || (h.kind === 'PARTY' && suffixRe.test(h.value))) {
      // "Dunav Gradnja d.o.o." also hides a later bare "Dunav Gradnja".
      const bare = h.value.replace(suffixRe, '');
      if (bare.length >= 4 && bare !== h.value) terms.push({ term: bare, kind: h.kind, via: h.via, parent });
    } else if (h.kind === 'PERSON' || h.kind === 'PARTY') {
      const tokens = h.value.split(/\s+/);
      const titled = h.kind === 'PERSON' || tokens.some(isTitle);
      const names = tokens.filter((w) => !isTitle(w));
      if (h.kind === 'PARTY') terms.push({ term: h.value, kind: h.kind, via: h.via, parent });
      // Single name words are only hidden for people introduced with a title; a party called
      // "North Build" must not turn every "north wall" into a placeholder.
      if (titled && names.every(isNameWord)) {
        for (const w of names) if (w.length >= 4) terms.push({ term: w, kind: h.kind, via: h.via, parent });
      }
    }
  }

  const hits = resolveOverlaps([...patternHits, ...collectTerms(text, terms)]);

  const vault = [];
  const byKey = new Map();
  const perKind = {};
  const placeholderFor = (h) => {
    const key = h.parent && byKey.has(`${h.kind}:${h.parent}`) ? `${h.kind}:${h.parent}` : `${h.kind}:${norm(h.value)}`;
    let entry = byKey.get(key);
    if (!entry) {
      perKind[h.kind] = (perKind[h.kind] || 0) + 1;
      entry = { placeholder: `[${h.kind}_${perKind[h.kind]}]`, kind: h.kind, value: h.value, via: h.via, count: 0, forms: [], aliases: [] };
      byKey.set(key, entry);
      vault.push(entry);
    }
    entry.count += 1;
    if (!entry.forms.includes(h.value)) entry.forms.push(h.value);
    return entry.placeholder;
  };

  // Parents first, so a bare surname maps onto the placeholder of the full name it belongs to.
  for (const h of hits) if (!h.parent) placeholderFor(h);
  for (const e of vault) e.count = 0;
  // Remember the name words of each entry, so text written later (by a model, say) is checked
  // against "Jovan Petrović" even though the note only ever said "Mr. Jovan Petrović".
  for (const t of terms) {
    const entry = t.parent && byKey.get(`${t.kind}:${t.parent}`);
    if (entry && !entry.aliases.includes(t.term)) entry.aliases.push(t.term);
  }

  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += text.slice(cursor, h.start) + placeholderFor(h);
    cursor = h.end;
  }
  out += text.slice(cursor);

  const counts = {};
  for (const e of vault) counts[e.kind] = (counts[e.kind] || 0) + e.count;
  return { text: out, vault, counts, total: hits.length };
}

/**
 * Egress guard: decide whether `payload` may leave the device.
 * It fails if any vaulted original (or any surface form of it) is present, or if the detectors
 * still find something confidential in the payload itself.
 */
export function inspectEgress(payload, vault = [], options = {}) {
  const leaks = [];
  const hay = norm(payload);
  for (const e of vault) {
    for (const form of [e.value, ...(e.forms || [])]) {
      const needle = norm(form);
      if (needle.length >= 3 && hay.includes(needle)) {
        leaks.push({ kind: e.kind, reason: 'vaulted value present', placeholder: e.placeholder });
        break;
      }
    }
    if ((e.aliases || []).some((alias) => alias.length >= 3 && termRegex(alias).test(payload))) {
      leaks.push({ kind: e.kind, reason: 'part of a vaulted name present', placeholder: e.placeholder });
    }
  }
  const again = redact(payload, { lexicon: options.lexicon, extraTerms: options.extraTerms });
  for (const e of again.vault) leaks.push({ kind: e.kind, reason: 'detector match in payload', placeholder: null });
  return { ok: leaks.length === 0, leaks };
}

/** Put the originals back into text that came home with placeholders. Local only. */
export function rehydrate(text, vault = []) {
  let out = text;
  for (const e of vault) out = out.split(e.placeholder).join(e.value);
  return out;
}

/**
 * Bracketed upper-case tokens in model output that no vault entry stands behind, such as a
 * "[SITE_NAME]" the model made up. They hide nothing and cannot be restored, so the interface
 * must say so instead of drawing them as protected values.
 */
export function strayPlaceholders(text, vault = []) {
  const known = new Set([...vault.map((e) => e.placeholder), '[REDACTED]']);
  const found = String(text).match(/\[[A-Z][A-Z0-9_ ]*\]/g) || [];
  return [...new Set(found.filter((token) => !known.has(token)))];
}

/** Split redacted text into plain and placeholder segments, for rendering. */
export function segments(redactedText) {
  const parts = [];
  const re = /\[([A-Z]+)_(\d+)\]/g;
  let cursor = 0;
  for (const m of redactedText.matchAll(re)) {
    if (m.index > cursor) parts.push({ type: 'text', value: redactedText.slice(cursor, m.index) });
    parts.push({ type: 'placeholder', value: m[0], kind: m[1] });
    cursor = m.index + m[0].length;
  }
  if (cursor < redactedText.length) parts.push({ type: 'text', value: redactedText.slice(cursor) });
  return parts;
}

/**
 * Redact text that was produced from the raw note (model findings, for instance), reusing the
 * placeholders of an existing vault. Anything confidential that the vault does not know yet is
 * replaced by [REDACTED], because it has no vault entry to be restored from.
 */
export function redactWithVault(text, vault = [], options = {}) {
  let out = text;
  const forms = vault
    .flatMap((e) => [e.value, ...(e.forms || [])].map((form) => [form, e.placeholder]))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [form, placeholder] of forms) {
    if (form.length < 3) continue;
    out = out.replace(new RegExp(termBody(form), 'giu'), placeholder);
  }
  // Then the name words, joined when they stand together: "Jovan Petrović" is one placeholder.
  for (const e of vault) {
    const aliases = (e.aliases || []).filter((a) => a.length >= 3);
    if (!aliases.length) continue;
    const one = `(?:${aliases.map(termBody).join('|')})[${L}]{0,3}`;
    out = out.replace(new RegExp(`(?<![${L}${N}])${one}(?:\\s+${one})*${NOT_WORD_AFTER}`, 'giu'), e.placeholder);
  }
  const rest = redact(out, options);
  for (const e of rest.vault) for (const form of e.forms) out = out.split(form).join('[REDACTED]');
  return out;
}
