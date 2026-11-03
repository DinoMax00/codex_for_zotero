import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaStore, byteRange } from '../bridge/media.mjs';
import { createBridge } from '../bridge/server.mjs';
import { PaperStore } from '../bridge/store.mjs';
import { PaperService } from '../bridge/service.mjs';
import { EventEmitter } from 'node:events';
import { markdownWithMath, visibleTurnItems } from '../src/presentation.mjs';
import { mediaReference, userImages } from '../src/media-protocol.mjs';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=',
  'base64',
);
const dataURL = 'data:image/png;base64,' + png.toString('base64');
async function fixture(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cfz-media-test-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  const media = new MediaStore(root);
  await media.init();
  return { tmp, root, media };
}
test('image attachments are private durable snapshots and reject non-images or oversized batches', async (t) => {
  const { media } = await fixture(t);
  const image = await media.stage({ dataURL, name: '图.png' });
  assert.deepEqual(await readFile(image.path), png);
  assert.equal((await stat(image.path)).mode & 0o777, 0o600);
  assert.deepEqual(await media.inputs([image.id]), [{ type: 'localImage', path: image.path }]);
  const reopened = new MediaStore(media.root);
  await reopened.init();
  assert.equal((await reopened.inputs([image.id]))[0].path, image.path);
  await assert.rejects(media.stage({ dataURL: 'data:image/svg+xml;base64,PHN2Zz4=' }));
  await assert.rejects(media.stage({ dataURL: 'data:image/png;base64,SGVsbG8=' }));
  await assert.rejects(media.inputs(Array(9).fill(image.id)), /8/);
  await assert.rejects(media.inputs(['../../credentials.png']));
});
test('output media checks real paths and signatures; symlinks cannot expose files outside the project', async (t) => {
  const { media, tmp, root } = await fixture(t);
  const outside = path.join(tmp, 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, path.join(root, 'escape.png'));
  await assert.rejects(media.register(outside), /工作目录/);
  await assert.rejects(media.register(path.join(root, 'escape.png')), /工作目录/);
  await writeFile(path.join(root, 'fake.png'), '<html>private text</html>');
  await assert.rejects(media.register('fake.png'), /不支持/);
  const stage = await media.stage({ source: outside });
  assert.deepEqual(await readFile(outside), png);
  assert.equal((await media.register(stage.path)).kind, 'image');
});
test('media markdown preserves code and rejects executable, SVG, credentialed and private-network references', () => {
  const result = markdownWithMath(
    '![chart](</Users/example/Papers/chart 1.png>)\n\n[clip](outputs/demo.mp4)\n\n![remote](https://example.com/signed?id=1)\n\n`![literal](bad.png)`\n\n```md\n![literal](bad.mp4)\n```',
  );
  assert.equal(result.media.length, 3);
  assert.equal(result.media[0].source, '/Users/example/Papers/chart 1.png');
  assert.equal(result.media[1].kind, 'video');
  assert.equal(result.media[2].remote, true);
  assert.doesNotMatch(result.html, /<img|<video/);
  assert.match(result.html, /literal/);
  for (const url of [
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://example.com/file.svg',
    'https://user:pass@example.com/test.png',
    'http://127.0.0.1/test.png',
    'http://0.0.0.0/test.png',
    'http://192.168.1.2/test.mp4',
    '//example.com/test.png',
    'file://remote/test.png',
  ])
    assert.equal(mediaReference(url, '', true), null, url);
  assert.equal(mediaReference('sandbox:/tmp/test.mp4').source, '/tmp/test.mp4');
  assert.equal(
    mediaReference('file:///Users/example/Papers/a%20b.png').source,
    '/Users/example/Papers/a b.png',
  );
});
test('image-only and generated-image history survives final-answer filtering', () => {
  assert.equal(
    userImages({
      content: [
        { type: 'localImage', path: '/Users/example/a.png' },
        { type: 'image', url: dataURL },
      ],
    }).length,
    2,
  );
  const rows = visibleTurnItems({
    status: 'completed',
    items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'image', url: dataURL }] },
      {
        id: 'i',
        type: 'imageGeneration',
        status: 'completed',
        savedPath: '/Users/example/chart.png',
      },
      { id: 'r', type: 'reasoning' },
      { id: 'a', type: 'agentMessage', phase: 'final_answer' },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['u', 'i', 'a'],
  );
});
test('native turn sends real localImage inputs on first and later image-only turns', async (t) => {
  const { tmp, root } = await fixture(t);
  const store = new PaperStore(root, path.join(tmp, 'state'));
  await store.load();
  const staged = await store.media.stage({ dataURL });
  const calls = [];
  class RPC extends EventEmitter {
    async start() {}
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'test-thread' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    }
  }
  const rpc = new RPC();
  const service = new PaperService(rpc, store);
  const pdf = path.join(tmp, 'test.pdf');
  await writeFile(pdf, '%PDF-1.7\nfixture');
  const paper = { path: pdf, libraryID: 1, attachmentKey: 'TESTPDF1' };
  const first = await service.send({ paper, images: [staged.id] });
  let input = calls.find((c) => c.method === 'turn/start').params.input;
  assert.equal(input[0].type, 'mention');
  assert.equal(input.at(-1).type, 'localImage');
  rpc.emit('notification', {
    method: 'turn/completed',
    params: { threadId: first.threadId, turn: { id: 'turn-1', status: 'completed' } },
  });
  await service.send({ paper, threadId: first.threadId, images: [staged.id], text: '' });
  input = calls.filter((c) => c.method === 'turn/start').at(-1).params.input;
  assert.deepEqual(input, [
    { type: 'text', text: '' },
    { type: 'localImage', path: staged.path },
  ]);
  const count = calls.length;
  await assert.rejects(service.send({ paper, images: ['bad'] }));
  assert.equal(calls.length, count);
});
test('capability URLs stream exact ranges without exposing the API bearer token', async (t) => {
  const { tmp, root } = await fixture(t);
  const bridge = await createBridge({
    projectRoot: root,
    dataDir: path.join(tmp, 'state'),
    codexPath: '/not/needed',
  });
  t.after(() => bridge.close());
  const base = bridge.connection.url,
    headers = {
      Authorization: 'Bearer ' + bridge.connection.token,
      'Content-Type': 'application/json',
    };
  assert.equal(
    (
      await fetch(base + '/images/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataURL }),
      })
    ).status,
    403,
  );
  const response = await fetch(base + '/images/stage', {
    method: 'POST',
    headers,
    body: JSON.stringify({ dataURL }),
  });
  assert.equal(response.status, 200);
  const image = await response.json();
  assert.ok(!image.route.includes(bridge.connection.token));
  const ranged = await fetch(base + image.route, { headers: { Range: 'bytes=0-7' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(0, 8));
  assert.equal(
    (await fetch(base + image.route, { method: 'HEAD' })).headers.get('Content-Length'),
    String(png.length),
  );
  assert.equal(
    (await fetch(base + image.route, { headers: { Range: 'bytes=999999-' } })).status,
    416,
  );
  assert.equal((await fetch(base + '/media/' + '0'.repeat(48))).status, 404);
  const invalid = await fetch(base + '/media/prepare', {
    method: 'POST',
    headers,
    body: JSON.stringify({ threadId: 'not-owned', path: image.path }),
  });
  assert.equal(invalid.status, 400);
});
test('video range parsing supports seeking, suffix requests and rejects multipart/invalid ranges', () => {
  assert.deepEqual(byteRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(byteRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(byteRange('bytes=80-', 100), { start: 80, end: 99, partial: true });
  for (const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,5-6', 'invalid'])
    assert.throws(() => byteRange(range, 100));
});
