import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNote, fromModel, grade } from '../src/rules.js';

const one = (text) => readNote(text).findings[0];

test('crack width is graded against the stated thresholds', () => {
  assert.equal(one('Hairline crack 0.2 mm in the slab.').severity, 'minor');
  assert.equal(one('Diagonal crack 0.3 mm wide in the slab.').severity, 'major');
  assert.equal(one('Diagonal crack 0.3 mm wide in the slab.').rule, 'crack-ec2');
  assert.equal(one('Crack 1.0 mm in beam B4.').severity, 'critical');
  assert.equal(one('Crack 0.4 mm wide and 2.1 m long.').severity, 'major', 'a 2.1 m length is not a width');
  assert.equal(one('Pukotina u gredi širine 1,2 mm.').severity, 'critical');
});

test('height and depth rules need both the threshold and a missing protection', () => {
  assert.equal(one('Scaffold guardrail missing at 6 m height.').rule, 'fall-height');
  assert.notEqual(one('Scaffold guardrail fitted and tagged at 6 m height.').severity, 'critical');
  assert.equal(one('Guardrail missing on the 1.2 m platform.').severity, 'major');
  assert.equal(one('Trench 1.8 m deep with no shoring.').rule, 'trench-depth');
  assert.equal(one('Trench 1.2 m deep with no shoring.').severity, 'major');
  assert.equal(one('Skela nema ogradu na visini 8 m.').severity, 'critical');
});

test('a safety reading wins a tie with a structural word', () => {
  assert.equal(one('Two workers without helmets at the rebar yard.').category, 'ppe');
});

test('words are matched from their start, not inside other words', () => {
  assert.equal(readNote('We will improve the provision of drawings.').findings.length, 0);
  assert.equal(readNote('The investor has knowledge of the download.').findings.length, 0);
});

test('a question is not a finding, but it marks the note as a regulatory query', () => {
  const read = readNote('Crack 0.4 mm wide in slab. Which code limits apply to the crack width?');
  assert.equal(read.findings.length, 1);
  assert.equal(read.asksRegulation, true);
});

test('findings come out worst first with stable ids', () => {
  const read = readNote('Damp patch on wall.\nTrench 2 m deep with no shoring.\nCable damaged near the panel.');
  assert.deepEqual(read.findings.map((f) => f.severity), ['critical', 'major', 'minor']);
  assert.deepEqual(read.findings.map((f) => f.id), ['F1', 'F2', 'F3']);
});

test('a model may not grade a threshold breach down, and may grade up', () => {
  const [down] = fromModel([{ element: 'Beam G2', issue: 'crack', measurement: '1.2 mm', category: 'structural', severity: 'minor' }]);
  assert.equal(down.severity, 'critical');
  assert.equal(down.rule, 'crack-1mm');
  const [up] = fromModel([{ element: 'Wall W1', issue: 'damp patch', category: 'water', severity: 'major' }]);
  assert.equal(up.severity, 'major');
  assert.match(up.basis, /on-device model/);
  assert.deepEqual(fromModel([{ element: '', issue: '' }]), []);
});

test('grade explains itself', () => {
  const g = grade({ text: 'Exposed rebar with corrosion at the soffit.', category: 'structural', measurements: [] });
  assert.equal(g.severity, 'major');
  assert.ok(g.basis.length > 20);
});
