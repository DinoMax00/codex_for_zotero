import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PaperStore } from '../bridge/store.mjs';
import { PaperService } from '../bridge/service.mjs';
import { createBridge } from '../bridge/server.mjs';
import http from 'node:http';

class FakeCodex extends EventEmitter {
  calls = [];
  responses = [];
  next = 0;
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'skills/list') return { data: [{ skills: this.skills || [] }] };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.next}` } };
    if (method === 'turn/start')
      return { turn: { id: `turn-${this.calls.length}`, status: 'inProgress' } };
    if (method === 'thread/resume')
      return { thread: { id: params.threadId, status: { type: 'idle' } } };
    if (method === 'thread/turns/list')
      return {
        data: [
          {
            id: 'old',
            status: 'completed',
            items: [{ type: 'agentMessage', id: 'a', text: 'Native persisted answer' }],
          },
        ],
        nextCursor: null,
      };
    return {};
  }
  respond(id, result, error) {
    this.responses.push({ id, result, error });
  }
  complete(id) {
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId: id, turn: { id: 'turn', status: 'completed' } },
    });
  }
}
async function fixture() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cfz-test-'));
  const pdf = path.join(tmp, 'paper 中文.pdf');
  await writeFile(pdf, '%PDF-1.7\nfixture');
  const store = new PaperStore(path.join(tmp, 'paper reading'), path.join(tmp, 'private'));
  await store.load();
  const rpc = new FakeCodex();
  const service = new PaperService(rpc, store);
  const paper = { libraryID: 1, attachmentKey: 'ABCDEFGH', title: 'Test paper', path: pdf };
  return { tmp, store, rpc, service, paper };
}
test('first turn attaches a PDF snapshot; follow-up uses the same native thread without reattaching', async () => {
  const { service, rpc, paper, store } = await fixture();
  const first = await service.send({ paper, text: '总结论文' });
  assert.equal(rpc.calls.find((c) => c.method === 'thread/start').params.cwd, store.projectRoot);
  const initial = rpc.calls.find((c) => c.method === 'turn/start').params;
  assert.equal(initial.input[0].type, 'mention');
  assert.equal(await readFile(initial.input[0].path, 'utf8'), '%PDF-1.7\nfixture');
  assert.match(initial.input[1].text, /总结论文/);
  assert.equal((await stat(initial.input[0].path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(initial.input[0].path))).mode & 0o777, 0o700);
  assert.equal(
    (await stat(path.join(path.dirname(initial.input[0].path), 'paper.json'))).mode & 0o777,
    0o600,
  );
  assert.equal(initial.approvalPolicy, undefined);
  assert.equal(initial.summary, 'auto');
  rpc.complete(first.threadId);
  await service.send({ paper, threadId: first.threadId, text: '展开核心公式' });
  const turns = rpc.calls.filter((c) => c.method === 'turn/start');
  assert.equal(turns[1].params.threadId, first.threadId);
  assert.deepEqual(turns[1].params.input, [{ type: 'text', text: '展开核心公式' }]);
});
test('paper and thread cannot be crossed, and busy turns cannot overlap', async () => {
  const { service, paper } = await fixture();
  const r = await service.send({ paper, text: 'hello' });
  await assert.rejects(service.send({ paper, threadId: r.threadId, text: 'again' }), /正在回复/);
  await assert.rejects(
    service.send({
      paper: { ...paper, attachmentKey: 'OTHERKEY' },
      threadId: r.threadId,
      text: 'wrong paper',
    }),
    /不匹配/,
  );
  assert.throws(() => service.poll('another-thread', 0), /不属于/);
});
test('restart resumes Codex persisted history and does not use a parallel transcript', async () => {
  const f = await fixture();
  const r = await f.service.send({ paper: f.paper, text: 'hello' });
  f.rpc.complete(r.threadId);
  const store = new PaperStore(f.store.projectRoot, path.join(f.tmp, 'private'));
  await store.load();
  const rpc = new FakeCodex();
  const service = new PaperService(rpc, store);
  const history = await service.history(r.threadId);
  assert.equal(history.turns[0].items[0].text, 'Native persisted answer');
  await service.send({ paper: f.paper, threadId: r.threadId, text: 'followup' });
  assert.equal(
    rpc.calls.some((c) => c.method === 'thread/resume'),
    true,
  );
  assert.deepEqual(rpc.calls.find((c) => c.method === 'turn/start').params.input, [
    { type: 'text', text: 'followup' },
  ]);
  const persisted = await readFile(store.filename, 'utf8');
  assert.equal(persisted.includes('Native persisted answer'), false);
});
test('approval is routed to the owning conversation and never auto-accepted', async () => {
  const { service, rpc, paper } = await fixture();
  const r = await service.send({ paper, text: 'hello' });
  rpc.emit('request', {
    id: 80,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: r.threadId, command: 'echo test' },
  });
  assert.equal(rpc.responses.length, 0);
  assert.equal(service.poll(r.threadId, 0).requests.length, 1);
  service.reply(r.threadId, 80, { decision: 'decline' });
  assert.equal(rpc.responses[0].result.decision, 'decline');
  assert.throws(() => service.reply(r.threadId, 80, { decision: 'accept' }), /已经结束/);
});
test('stream replay carries authoritative text, and interrupts use the native turn endpoint', async () => {
  const { service, rpc, paper } = await fixture();
  const r = await service.send({ paper, text: 'hello' });
  for (const delta of ['Hello', ' world'])
    rpc.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: r.threadId, itemId: 'message', delta },
    });
  assert.equal(service.poll(r.threadId, 0).events.at(-1).params.fullText, 'Hello world');
  await service.interrupt(r.threadId);
  assert.equal(rpc.calls.at(-1).method, 'turn/interrupt');
  assert.equal(rpc.calls.at(-1).params.turnId, r.turnId);
});
test('HTTP bridge rejects missing tokens, browser origins, wrong hosts and non-JSON mutations', async (t) => {
  const f = await fixture();
  const b = await createBridge({
    projectRoot: f.store.projectRoot,
    dataDir: path.join(f.tmp, 'http'),
    codexPath: '/not/needed',
  });
  t.after(() => b.close());
  const url = b.connection.url,
    auth = { Authorization: `Bearer ${b.connection.token}` };
  assert.equal((await fetch(url + '/health')).status, 403);
  assert.equal(
    (await fetch(url + '/health', { headers: { ...auth, Origin: 'https://evil.example' } })).status,
    403,
  );
  const wrongHost = await new Promise((resolve, reject) => {
    http
      .get(url + '/health', { headers: { ...auth, Host: 'evil.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(url + '/health', { headers: auth })).status, 200);
  assert.equal(
    (await fetch(url + '/paper', { method: 'POST', headers: auth, body: '{}' })).status,
    415,
  );
});
test('invalid or non-PDF files fail without modifying the Zotero attachment', async () => {
  const f = await fixture();
  await writeFile(f.paper.path, 'not a PDF');
  await assert.rejects(f.service.send({ paper: f.paper, text: 'hello' }), /不是有效/);
  assert.equal(await readFile(f.paper.path, 'utf8'), 'not a PDF');
  assert.throws(() => f.store.key({ ...f.paper, attachmentKey: '../../evil' }), /无效/);
});
test('native title rename survives restart and reasoning summaries replay without raw reasoning', async () => {
  const f = await fixture(),
    r = await f.service.send({ paper: f.paper, text: 'hello' });
  f.rpc.complete(r.threadId);
  for (const delta of ['Checking', ' equations'])
    f.rpc.emit('notification', {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: r.threadId, turnId: r.turnId, itemId: 'reason', summaryIndex: 0, delta },
    });
  const events = f.service.poll(r.threadId, 0);
  assert.equal(events.events.at(-1).params.fullText, 'Checking equations');
  assert.equal(events.session.completedOnce, true);
  assert.equal(events.state.status, 'completed');
  await f.service.rename(r.threadId, '可微世界模型');
  assert.deepEqual(f.rpc.calls.at(-1), {
    method: 'thread/name/set',
    params: { threadId: r.threadId, name: '可微世界模型' },
  });
  const restored = new PaperStore(f.store.projectRoot, path.join(f.tmp, 'private'));
  await restored.load();
  assert.equal(restored.records['1-ABCDEFGH'].sessions[0].title, '可微世界模型');
  await assert.rejects(f.service.rename('not-owned', 'title'), /不属于/);
  await assert.rejects(f.service.rename(r.threadId, ' '), /1–200/);
});

test('annotation button task attaches an explicit native skill and reuses the paper thread', async () => {
  const { service, rpc, paper } = await fixture();
  const skill = {
    name: 'zotero-paper-annotator',
    path: '/local/skills/zotero-paper-annotator/SKILL.md',
    enabled: true,
  };
  rpc.skills = [skill];
  const r = await service.send({
    paper,
    text: '使用 $zotero-paper-annotator 自动批注',
    task: 'annotate',
    model: 'gpt-6.1-sol',
  });
  const first = rpc.calls.find((c) => c.method === 'turn/start').params;
  assert.equal(first.model, 'gpt-6.1-sol');
  assert.equal(first.approvalPolicy, undefined);
  assert.equal(first.input[0].type, 'mention');
  assert.deepEqual(first.input.at(-1), { type: 'skill', name: skill.name, path: skill.path });
  assert.deepEqual(rpc.calls.find((c) => c.method === 'skills/list').params, {
    cwds: [service.store.projectRoot],
    forceReload: true,
  });
  rpc.complete(r.threadId);
  await service.send({ paper, threadId: r.threadId, text: '再次批注', task: 'annotate' });
  const followup = rpc.calls.filter((c) => c.method === 'turn/start').at(-1).params;
  assert.equal(followup.threadId, r.threadId);
  assert.deepEqual(
    followup.input.map((i) => i.type),
    ['text', 'skill'],
  );
  assert.equal(rpc.calls.filter((c) => c.method === 'thread/start').length, 1);
});
test('missing or disabled annotation skills fail before creating a native conversation', async () => {
  for (const skills of [
    [],
    [{ name: 'zotero-paper-annotator', path: '/local/skill/SKILL.md', enabled: false }],
  ]) {
    const { service, rpc, paper } = await fixture();
    rpc.skills = skills;
    await assert.rejects(
      service.send({ paper, text: '自动批注', task: 'annotate' }),
      /未找到已启用/,
    );
    assert.equal(
      rpc.calls.some((c) => ['thread/start', 'turn/start'].includes(c.method)),
      false,
    );
  }
});
