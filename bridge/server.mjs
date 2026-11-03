import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CodexRPC } from './rpc.mjs';
import { PaperStore, atomicJSON } from './store.mjs';
import { PaperService } from './service.mjs';

export async function createBridge(config) {
  const token = randomBytes(32).toString('hex');
  const store = new PaperStore(config.projectRoot, config.dataDir);
  await store.load();
  const rpc = new CodexRPC(config.codexPath, { cwd: store.projectRoot });
  const service = new PaperService(rpc, store);
  function json(res, status, value) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (
      req.headers.origin ||
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
      !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') ||
      Buffer.byteLength(supplied) !== token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    )
      return json(res, 403, { error: '本地连接验证失败' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health')
        return json(res, 200, {
          ok: true,
          version: config.version || '0.6.0',
          pid: process.pid,
          projectRoot: store.projectRoot,
        });
      if (req.method === 'GET' && url.pathname === '/events')
        return json(
          res,
          200,
          service.poll(
            url.searchParams.get('threadId'),
            Number(url.searchParams.get('after') || 0),
          ),
        );
      if (req.method !== 'POST') return json(res, 404, { error: '未知请求' });
      if (!req.headers['content-type']?.startsWith('application/json'))
        return json(res, 415, { error: '需要 JSON 请求' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1000000) {
          json(res, 413, { error: '请求过大' });
          return;
        }
      }
      const p = JSON.parse(body);
      let data;
      switch (url.pathname) {
        case '/paper':
          data = await service.list(p.paper);
          break;
        case '/send':
          data = await service.send(p);
          break;
        case '/history':
          data = await service.history(p.threadId, p.cursor);
          break;
        case '/rename':
          data = await service.rename(p.threadId, p.name);
          break;
        case '/interrupt':
          data = await service.interrupt(p.threadId);
          break;
        case '/reply':
          data = service.reply(p.threadId, p.id, p.result);
          break;
        case '/models': {
          await service.ready();
          data = await rpc.call('model/list', {});
          const effective = await rpc.call('config/read', {
            cwd: store.projectRoot,
            includeLayers: false,
          });
          data.defaultModel = effective.config?.model || data.data?.find((m) => m.isDefault)?.model;
          break;
        }
        case '/shutdown':
          json(res, 200, { ok: true });
          setTimeout(() => close(), 30);
          return;
        default:
          return json(res, 404, { error: '未知请求' });
      }
      json(res, 200, data);
    } catch (e) {
      json(res, 400, { error: e.message, ...(e.threadId ? { threadId: e.threadId } : {}) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connection = {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    pid: process.pid,
    version: config.version || '0.6.0',
  };
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    rpc.close();
    server.closeAllConnections();
    server.close();
    if (config.connectionFile) {
      try {
        const current = JSON.parse(await readFile(config.connectionFile, 'utf8'));
        if (current.pid === process.pid) await unlink(config.connectionFile);
      } catch {}
    }
  }
  if (config.connectionFile) await atomicJSON(config.connectionFile, connection);
  return { server, service, connection, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.indexOf('--config');
  const config =
    arg >= 0
      ? JSON.parse(await readFile(process.argv[arg + 1], 'utf8'))
      : {
          codexPath: process.env.CODEX_FOR_ZOTERO_CODEX || '/opt/homebrew/bin/codex',
          projectRoot: path.join(os.homedir(), 'Documents', 'ChatGPT', 'paper reading'),
          dataDir: path.join(os.homedir(), '.codex', 'zotero-codex'),
        };
  const bridge = await createBridge(config);
  console.log(JSON.stringify({ ready: true, url: bridge.connection.url }));
  process.on('SIGTERM', () => bridge.close());
  process.on('SIGINT', () => bridge.close());
  // Zotero owns this sidecar. Exit if the application has gone away unexpectedly.
  if (config.parentPid)
    setInterval(() => {
      try {
        process.kill(config.parentPid, 0);
      } catch {
        bridge.close();
      }
    }, 10000).unref();
}
