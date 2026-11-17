import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslation } from '../bridge/translate.mjs';
import { translateLocation } from '../src/translation-view.mjs';

test('Luna translation rejects missing, repeated or invented paragraph IDs', () => {
  const input = [
    { id: 'p1b1', text: 'Contact dynamics' },
    { id: 'p1b2', text: 'The distance is 12 mm.' },
  ];
  const one = { id: 'p1b1', text: '接触动力学' },
    two = { id: 'p1b2', text: '距离为 12 mm。' };
  const output = (translations) => JSON.stringify({ translations });
  assert.deepEqual(
    { ...validateTranslation(output([two, one]), input) },
    { p1b1: one.text, p1b2: two.text },
  );
  for (const bad of [[one], [one, one], [one, { ...two, id: 'fake' }], [one, { ...two, text: '' }]])
    assert.throws(() => validateTranslation(output(bad), input));
});

test('mirrored pages retain fractional position in each direction; supplement links resolve to their original paragraph', () => {
  const map = {
    sourcePages: 2,
    pages: [{ source: 0 }, { source: 1 }, { source: 0, supplement: 1, x: 0.54, y: 0.58 }],
  };
  const source = { page: 1, x: 0.15, y: 0.47 };
  assert.deepEqual(translateLocation(translateLocation(source, map, false), map, true), source);
  assert.deepEqual(translateLocation({ page: 2, x: 0.1, y: 0.8 }, map, true), {
    page: 0,
    x: 0.54,
    y: 0.58,
  });
  assert.equal(translateLocation({ page: 2, y: 0 }, map, false), null);
});
