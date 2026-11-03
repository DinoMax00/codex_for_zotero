import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationBridge } from '../src/annotation-bridge.js';
import {
  validateAnnotation,
  isInternalTag,
  ANNOTATION_ROUTE,
} from '../src/annotation-protocol.mjs';
const sample = {
  key: 'ABCDEFGH',
  version: 0,
  itemType: 'annotation',
  parentItem: 'PAPERPDF',
  annotationType: 'highlight',
  annotationText: 'Original quotation',
  annotationComment: '中文解释',
  annotationColor: '#ffd400',
  annotationPageLabel: '2',
  annotationSortIndex: '00001|000025|00010',
  annotationPosition: '{"pageIndex":1,"rects":[[10,20,100,35]]}',
  codexAnchor: 'a'.repeat(24),
};
test('native highlights exclude visible automation labels and author names', () => {
  const clean = validateAnnotation(
    {
      ...sample,
      annotationAuthorName: 'Long automation name',
      tags: [{ tag: 'codex-anchor:bad' }],
    },
    'PAPERPDF',
  );
  assert.equal(clean.authorName, '');
  assert.deepEqual(clean.tags, []);
  assert.equal(clean.comment, '中文解释');
  assert.equal(clean.key, sample.key);
  assert.throws(
    () => validateAnnotation({ ...sample, parentItem: 'OTHERPDF' }, 'PAPERPDF'),
    /指定 PDF/,
  );
  assert.throws(
    () =>
      validateAnnotation(
        { ...sample, annotationPosition: '{"pageIndex":1,"rects":[[100,20,10,35]]}' },
        'PAPERPDF',
      ),
    /坐标/,
  );
});
test('legacy cleanup recognizes only reserved machine labels', () => {
  for (const tag of [
    'codex-paper-reading',
    'codex-paper-reading:core',
    'codex-anchor:' + 'a'.repeat(32),
  ])
    assert.equal(isInternalTag(tag), true);
  for (const tag of ['机器人', 'codex-paper-reading-club', 'codex-anchor:my-notes'])
    assert.equal(isInternalTag(tag), false);
});
test('background endpoint rejects browser origins, invalid secrets and wrong instances', async () => {
  const saved = [];
  const b = new AnnotationBridge({
    home: '/home',
    pluginVersion: 'test',
    PathUtils: { join: (...p) => p.join('/') },
    Services: { uuid: { generateUUID: () => '{a'.padEnd(36, 'b') + '}' } },
    IOUtils: {
      makeDirectory: async () => {},
      readUTF8: async () => {
        throw new Error('missing');
      },
      exists: async () => false,
      writeUTF8: async (p, data) => saved.push(p),
      setPermissions: async () => {},
      remove: async () => {},
    },
    Zotero: {
      Profile: { dir: '/profile' },
      Server: {
        port: 23119,
        init: async () => {},
        Endpoints: {},
        LocalAPI: { getServerID: () => 'instance-A' },
      },
    },
  });
  await b.start();
  assert.ok(b.Zotero.Server.Endpoints[ANNOTATION_ROUTE]);
  assert.ok(saved.some((p) => p.endsWith('bridge.json')));
  const call = (headers, data = { action: 'status', serverID: 'instance-A' }) =>
    new b.Endpoint().init({ headers: new Headers(headers), data });
  assert.equal((await call({}))[0], 403);
  assert.equal(
    (await call({ Authorization: 'Bearer ' + b.token, Origin: 'https://example.test' }))[0],
    403,
  );
  assert.equal(
    (
      await call({ Authorization: 'Bearer ' + b.token }, { action: 'status', serverID: 'another' })
    )[0],
    409,
  );
  assert.equal((await call({ Authorization: 'Bearer ' + b.token }))[0], 200);
  assert.equal(
    (
      await call(
        { Authorization: 'Bearer ' + b.token },
        { action: 'execute', serverID: 'instance-A', code: 'doSomething()' },
      )
    )[0],
    400,
  );
  await b.stop();
  assert.equal(b.Zotero.Server.Endpoints[ANNOTATION_ROUTE], undefined);
});
