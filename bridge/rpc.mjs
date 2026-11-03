import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';

// Transport only. Codex owns the agent loop, tools, context, auth and history.
export class CodexRPC extends EventEmitter {
  constructor(
    command,
    { args = ['app-server', '--listen', 'stdio://'], cwd, env = process.env } = {},
  ) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.proc = null;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.#start().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }
  async #start() {
    const env = {
      ...this.env,
      PATH: [path.dirname(process.execPath), path.dirname(this.command), this.env.PATH || ''].join(
        path.delimiter,
      ),
    };
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    child.on('error', (e) => {
      if (this.proc === child) this.#died(e);
    });
    child.on('exit', (code, signal) => {
      if (this.proc === child)
        this.#died(
          new Error(
            `Codex 已退出 (${signal || code})${this.stderr ? '：' + this.stderr.slice(-800) : ''}`,
          ),
        );
    });
    this.proc.stderr.on('data', (b) => {
      this.stderr = (this.stderr + b.toString()).slice(-8000);
    });
    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method) this.emit(msg.id === undefined ? 'notification' : 'request', msg);
      else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error
          ? p.reject(Object.assign(new Error(msg.error.message), { rpcCode: msg.error.code }))
          : p.resolve(msg.result);
      }
    });
    const info = await this.call('initialize', {
      clientInfo: { name: 'codex_for_zotero', title: 'Codex for Zotero', version: '0.7.1' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    this.info = info;
    return info;
  }
  call(method, params = {}, timeout = 180000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}。请先检查会话状态，避免重复发送。`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  notify(method, params) {
    this.#write({ method, params });
  }
  respond(id, result, error) {
    this.#write(error ? { id, error } : { id, result });
  }
  #write(message) {
    if (!this.proc?.stdin.writable) throw new Error('Codex 连接已关闭');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  #died(error) {
    if (!this.proc) return;
    this.proc = null;
    this.starting = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('disconnected', error);
  }
  close() {
    this.lines?.close();
    this.proc?.kill('SIGTERM');
  }
}
