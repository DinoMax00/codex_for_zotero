// Explicit opt-in integration check: creates native chats and consumes model quota.
import { readFile, mkdtemp } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { CodexRPC } from '../bridge/rpc.mjs';
import { PaperStore } from '../bridge/store.mjs';
import { PaperService } from '../bridge/service.mjs';
const { values } = parseArgs({
  options: {
    paper: { type: 'string' },
    codex: { type: 'string' },
    'allow-model-call': { type: 'boolean', default: false },
  },
});
if (!values.paper || !values['allow-model-call']) {
  throw new Error(
    'Usage: node scripts/native-smoke.mjs --paper /absolute/test.pdf --allow-model-call [--codex /absolute/codex]',
  );
}
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cfz-native-'));
const projectRoot = path.join(tmp, 'paper-reading');
const paper = {
  libraryID: 1,
  attachmentKey: 'TESTPDF1',
  title: 'Integration test paper',
  path: path.resolve(values.paper),
};
await readFile(paper.path); // Fail before creating a native chat if the fixture is unavailable.
const codex = values.codex || process.env.CODEX_FOR_ZOTERO_CODEX || 'codex';
const store = new PaperStore(projectRoot, path.join(tmp, 'state'));
await store.load();
let rpc = new CodexRPC(codex, { cwd: projectRoot });
let service = new PaperService(rpc, store);
let threadId;
async function waitTurn() {
  const started = Date.now();
  while (service.active.has(threadId)) {
    if (Date.now() - started > 240000) {
      await service.interrupt(threadId);
      throw new Error('Native test timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const final = service
    .poll(threadId, 0)
    .events.filter((e) => e.method === 'turn/completed')
    .at(-1);
  if (final?.params.turn.status !== 'completed')
    throw new Error('Native test turn did not complete; inspect it in Codex');
}
try {
  ({ threadId } = await service.send({
    paper,
    text: 'Read the attached test PDF. Reply only with its title. Do not modify files.',
    effort: 'low',
  }));
  await waitTurn();
  await service.send({
    paper,
    threadId,
    text: 'In this same paper, what is the first author? Reply briefly. Do not modify files.',
    effort: 'low',
  });
  await waitTurn();
  rpc.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rpc = new CodexRPC(codex, { cwd: projectRoot });
  service = new PaperService(rpc, store);
  const restored = await service.history(threadId);
  if (restored.turns.length < 2) throw new Error('Two-turn history was not restored');
  await rpc.call('thread/archive', { threadId });
  console.log(
    JSON.stringify({
      ok: true,
      restoredTurns: restored.turns.length,
      archived: true,
      temporaryDirectory: tmp,
    }),
  );
} catch (error) {
  console.error('Smoke test failed. Temporary files were retained for inspection.', error.message);
  if (threadId) console.error('Native test chat:', threadId);
  process.exitCode = 1;
} finally {
  rpc.close();
}
