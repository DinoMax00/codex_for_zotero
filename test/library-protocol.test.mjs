import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionPath, duplicateCandidates, doiOf, arxivOf } from '../src/library-protocol.mjs';
test('collection paths preserve explicit nesting, Unicode, and literal slash names', () => {
  assert.deepEqual(collectionPath(' robotics / 全身控制 '), ['robotics', '全身控制']);
  assert.deepEqual(collectionPath(['a/b', 'child']), ['a/b', 'child']);
  for (const path of ['a//b', 'a/../b', '', []]) assert.throws(() => collectionPath(path));
});
test('DOI matches win over title changes and remain case insensitive', () => {
  assert.equal(doiOf('https://doi.org/10.1234/ABC'), '10.1234/abc');
  const old = { key: 'EXISTING', title: 'Old title', DOI: '10.1234/ABC' };
  assert.deepEqual(duplicateCandidates({ title: 'New title', DOI: 'doi:10.1234/abc' }, [old]), {
    matches: [old],
    conflicts: [],
  });
});
test('same titles with different DOIs and multiple matches require disambiguation', () => {
  const old = { key: 'EXISTING', title: 'A paper', DOI: '10.1234/one' };
  assert.deepEqual(duplicateCandidates({ title: 'A paper', DOI: '10.1234/two' }, [old]), {
    matches: [],
    conflicts: [old],
  });
  assert.equal(
    duplicateCandidates({ title: 'A paper' }, [old, { ...old, key: 'ANOTHER' }]).matches.length,
    2,
  );
});
test('arXiv versions deduplicate without treating arbitrary publisher numbers as arXiv IDs', () => {
  assert.equal(arxivOf('https://arxiv.org/pdf/1706.03762v7.pdf'), '1706.03762');
  assert.equal(arxivOf('arXiv: hep-th/9901001v2'), 'hep-th/9901001');
  assert.equal(arxivOf('https://publisher.test/2024.12345/article'), '');
  const old = {
    key: 'EXISTING',
    title: 'Original title',
    url: 'https://arxiv.org/abs/1706.03762v1',
  };
  assert.deepEqual(
    duplicateCandidates({ title: 'Revised title', url: 'https://arxiv.org/abs/1706.03762v7' }, [
      old,
    ]).matches,
    [old],
  );
});
