import { parseArgs } from 'node:util';
import { CodexRPC } from '../bridge/rpc.mjs';
const { values } = parseArgs({ options: { codex: { type: 'string' }, cwd: { type: 'string' } } });
const rpc = new CodexRPC(values.codex || process.env.CODEX_FOR_ZOTERO_CODEX || 'codex', {
  cwd: values.cwd || process.cwd(),
});
try {
  await rpc.start();
  const models = await rpc.call('model/list', {});
  console.log(
    JSON.stringify({
      initialized: true,
      models: models.data.map((m) => ({ id: m.model, default: m.isDefault })),
    }),
  );
} finally {
  rpc.close();
}
