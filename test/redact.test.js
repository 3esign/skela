import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, rehydrate, inspectEgress, isValidJmbg, isValidPib, segments, strayPlaceholders } from '../src/redact.js';
import { SAMPLES, SAMPLE_SECRETS } from '../src/samples.js';

const lexiconOf = (s) => (s.lexicon ? s.lexicon.split(',') : []);
const has = (hay, needle) => hay.toLowerCase().includes(needle.toLowerCase());

for (const sample of SAMPLES) {
  test(`sample "${sample.id}": no confidential value survives redaction`, () => {
    const out = redact(sample.note, { lexicon: lexiconOf(sample) });
    for (const secret of SAMPLE_SECRETS[sample.id]) {
      assert.ok(!has(out.text, secret), `"${secret}" is still in the redacted text`);
    }
    assert.ok(out.total >= 2);
  });

  test(`sample "${sample.id}": the raw note fails the egress guard (negative control)`, () => {
    const out = redact(sample.note, { lexicon: lexiconOf(sample) });
    assert.equal(inspectEgress(out.text, out.vault, { lexicon: lexiconOf(sample) }).ok, true);
    assert.equal(inspectEgress(sample.note, out.vault, { lexicon: lexiconOf(sample) }).ok, false);
  });
}

test('technical content is left alone', () => {
  const blockB = redact(SAMPLES[0].note).text;
  for (const keep of ['0.4 mm', '2.1 m', '30 cm', '6 m height', '1.8 m deep', 'Slab S3', 'level 3', '18 Nov']) {
    assert.ok(blockB.includes(keep), `lost "${keep}"`);
  }
  const serbian = redact(SAMPLES[2].note).text;
  for (const keep of ['1,2 mm', '8 m', 'G2', '18.11']) assert.ok(serbian.includes(keep), `lost "${keep}"`);

  const pure = 'Concrete C25/30, rebar Ø12 at 150 mm, crack 0.35 mm, load 12 kN, slope 2 %, inspected 05-12-2026 on level 05, axis 3/B, 1200 x 600 mm opening.';
  const out = redact(pure);
  assert.equal(out.total, 0, `over-redacted: ${out.text}`);
  assert.equal(out.text, pure);
});

test('checksum validators accept valid numbers and reject altered ones', () => {
  assert.equal(isValidJmbg('0101900710004'), true);
  assert.equal(isValidJmbg('0101900710005'), false);
  assert.equal(isValidJmbg('123'), false);
  assert.equal(isValidPib('102030400'), true);
  assert.equal(isValidPib('102030401'), false);
});

test('an unlabelled 9-digit number is redacted only when the tax checksum holds', () => {
  assert.ok(redact('Invoice ref 102030400 was paid.').text.includes('[TAX_1]'));
  assert.equal(redact('Batch 102030401 of anchors.').total, 0);
});

test('money in its common spellings', () => {
  for (const s of ['48,500 EUR', '€ 1.250.000', '$12,000', '320.000 din.', '1.2 mil EUR', '350 EUR', '15000 RSD', '2,5 miliona dinara', 'contract value 980000', 'cena: 12.500']) {
    const out = redact(`Offer ${s} for the works.`);
    assert.ok(out.counts.AMOUNT >= 1, `missed "${s}" -> ${out.text}`);
    assert.ok(!/\d{3}/.test(out.text.replace(/\[[A-Z]+_\d+\]/g, '')), `digits left from "${s}" -> ${out.text}`);
  }
});

test('phones, e-mail, accounts, coordinates, parcels, addresses', () => {
  const cases = {
    PHONE: ['+381 60 123 4567', '+381601234567', '060/123-45-67', '011 222-3344', '0044 20 7946 0958'],
    EMAIL: ['site.office@example.org'],
    ACCOUNT: ['160-0000000123456-78', 'RS35 2600 0560 1001 6113 79'],
    GEO: ['44.8125, 20.4612', '44.81250° N, 20.46120° E'],
    PARCEL: ['k.p. 1432/5 K.O. Savski Venac', 'parcel no. 88/2'],
    ADDRESS: ['ul. Kneza Miloša 12', 'Bulevar kralja Aleksandra 73a', '221 Baker Street', 'Address: Nemanjina 4, Beograd'],
  };
  for (const [kind, list] of Object.entries(cases)) {
    for (const value of list) {
      const out = redact(`Meet at the gate. ${value}\nBring the drawings.`);
      assert.ok(out.counts[kind] >= 1, `${kind} missed "${value}" -> ${out.text}`);
    }
  }
});

test('a titled person is hidden again when only the surname returns, declined', () => {
  const out = redact('Spoke to Mr. Jovan Petrović on site. Petrović agreed. Dogovor sa Petrovićem i kod Petrovića.');
  assert.ok(!has(out.text, 'Petrovi'), out.text);
  assert.equal(out.vault.filter((e) => e.kind === 'PERSON').length, 1);
  assert.equal(out.vault[0].count, 4);
});

test('a party named after a common word does not swallow that word elsewhere', () => {
  const out = redact('Contractor: North Build\nNorth wall has damp patches. North Build will return Monday.');
  assert.ok(out.text.includes('North wall'), out.text);
  assert.ok(!out.text.includes('North Build'), out.text);
});

test('names reported by the on-device model are hidden and attributed to it', () => {
  const out = redact('Foreman Dragan Simić refused to stop the pour.', { extraTerms: ['Dragan Simić'] });
  assert.ok(!has(out.text, 'Simić'));
  assert.equal(out.vault[0].via, 'on-device model');
});

test('the user list hides a term wherever it appears', () => {
  const out = redact('Handover of project Feniks is at risk; Feniksa se tiče i ovo.', { lexicon: ['Feniks'] });
  assert.ok(!has(out.text, 'Feniks'), out.text);
  assert.equal(out.counts.TERM, 2);
});

test('rehydrate restores the originals locally', () => {
  const note = 'Investor: Sava Invest d.o.o., PIB 102030400, offer 48,500 EUR, mail a@example.com.';
  const out = redact(note);
  assert.equal(rehydrate(out.text, out.vault), note);
  assert.ok(segments(out.text).some((p) => p.type === 'placeholder' && p.kind === 'TAX'));
});

test('egress guard catches a single leaked value among clean text (negative control)', () => {
  const out = redact(SAMPLES[0].note, { lexicon: ['Feniks'] });
  const leaked = `${out.text}\nPS call 060/123-45-67`;
  const verdict = inspectEgress(leaked, out.vault);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.leaks.some((l) => l.kind === 'PHONE'));
  const renamed = `${out.text}\nAsk Petrovića directly.`;
  assert.equal(inspectEgress(renamed, out.vault).ok, false);
});

test('model-written text is redacted with the vault of the note it came from', async () => {
  const { redactWithVault } = await import('../src/redact.js');
  const note = 'Contractor: Mr. Jovan Petrović, phone 060/123-45-67. Slab S3 cracked.';
  const red = redact(note);
  const fromModel = 'Slab S3: crack reported by Jovan Petrović (060/123-45-67), second contact 011 222-3344';
  const out = redactWithVault(fromModel, red.vault);
  assert.ok(!/Petrovi|060|222-3344/.test(out), out);
  assert.ok(out.includes('[PARTY_1]') && out.includes('[PHONE_1]') && out.includes('[REDACTED]'), out);
  assert.equal(inspectEgress(out, red.vault).ok, true);
});

test('placeholders a model made up are told apart from vaulted ones', () => {
  const red = redact('Contractor: Mr. Jovan Petrović, phone 060/123-45-67.');
  const real = red.vault[0].placeholder;
  assert.deepEqual(strayPlaceholders(`Tell ${real} and [REDACTED].`, red.vault), [], 'vaulted tokens are not stray');
  assert.deepEqual(strayPlaceholders(`Concerns at [SITE_NAME]; call [PERSON_9] and ${real}. [SITE_NAME] again.`, red.vault), ['[SITE_NAME]', '[PERSON_9]']);
  assert.deepEqual(strayPlaceholders('Slab S3 [see photo] is cracked.', red.vault), [], 'ordinary bracketed prose is left alone');
  assert.deepEqual(strayPlaceholders('Fix the crack in [F3 Slab S3] and the rail on [F1 North scaffold].', red.vault), [], 'a bracketed finding reference ending in capitals is not a placeholder');
});

test('US phones, SSN and currency-before-number are redacted without touching codes or dates', () => {
  const text = 'Call (415) 555-0192 or 415-555-0199, SSN 123-45-6789, quote USD 50,000 and EUR 48,500. Check EN 1992-1-1 on 2026-11-19 for 0.4 mm crack.';
  const out = redact(text);
  for (const secret of ['415', '555-0192', '555-0199', '123-45-6789', '50,000', '48,500']) {
    assert.ok(!out.text.includes(secret), `leaked ${secret}: ${out.text}`);
  }
  for (const keep of ['EN 1992-1-1', '2026-11-19', '0.4 mm']) {
    assert.ok(out.text.includes(keep), `corrupted ${keep}: ${out.text}`);
  }
});

test('redactWithVault replaces only the newly matched span, not unrelated measurements', async () => {
  const { redactWithVault } = await import('../src/redact.js');
  const red = redact('Contractor: Mr. Jovan Petrović.');
  const out = redactWithVault('Slab S3 spalling 30 cm reported by Jovan Petrović; fee: 30.', red.vault);
  assert.ok(out.includes('30 cm'), `measurement corrupted: ${out}`);
  assert.ok(out.includes('[PARTY_1]'), out);
  assert.ok(out.includes('fee: [REDACTED]'), out);
});
