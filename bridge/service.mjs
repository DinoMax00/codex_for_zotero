import { firstInput } from './store.mjs';

export class PaperService {
  constructor(rpc, store) {
    this.rpc = rpc;
    this.store = store;
    this.events = new Map();
    this.requests = new Map();
    this.loaded = new Set();
    this.active = new Map();
    this.locks = new Map();
    this.cursor = 0;
    this.messageText = new Map();
    this.reasoningText = new Map();
    this.turnStates = new Map();
    rpc.on('notification', (msg) => this.notification(msg));
    rpc.on('request', (msg) => this.request(msg));
    rpc.on('disconnected', (e) => {
      this.loaded.clear();
      this.requests.clear();
      for (const threadId of this.active.keys())
        this.publish(threadId, 'bridge/disconnected', { message: e.message });
      this.active.clear();
    });
  }
  async lock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  own(threadId) {
    for (const record of Object.values(this.store.records)) {
      const session = record.sessions.find((s) => s.threadId === threadId);
      if (session) return { record, session };
    }
    throw new Error('这个会话不属于 Codex for Zotero');
  }
  publish(threadId, method, params) {
    if (!threadId) return;
    const queue = this.events.get(threadId) || [];
    queue.push({ seq: ++this.cursor, method, params });
    if (queue.length > 2500) queue.splice(0, queue.length - 2500);
    this.events.set(threadId, queue);
  }
  notification(msg) {
    const p = msg.params || {},
      id = p.threadId || p.thread?.id;
    const messageKey = `${id}:${p.itemId || p.item?.id}`;
    if (['item/started', 'item/completed'].includes(msg.method) && p.item?.type === 'agentMessage')
      this.messageText.set(messageKey, p.item.text || '');
    if (msg.method === 'item/agentMessage/delta') {
      const fullText = (this.messageText.get(messageKey) || '') + p.delta;
      this.messageText.set(messageKey, fullText);
      this.publish(id, msg.method, { ...p, fullText });
      return;
    }
    if (msg.method === 'item/reasoning/summaryTextDelta') {
      const key = `${messageKey}:${p.summaryIndex}`;
      const fullText = (this.reasoningText.get(key) || '') + p.delta;
      this.reasoningText.set(key, fullText);
      this.publish(id, msg.method, { ...p, fullText });
      return;
    }
    if (msg.method === 'thread/name/updated' && p.threadName) {
      try {
        const { session } = this.own(id);
        session.title = p.threadName;
        this.store.save().catch(() => {});
      } catch {}
    }
    if (msg.method === 'turn/started' && id)
      this.turnStates.set(id, { id: p.turn.id, status: 'inProgress' });
    if (msg.method === 'turn/started' && id) this.active.set(id, p.turn.id);
    if (msg.method === 'turn/completed' && id) {
      this.active.delete(id);
      this.turnStates.set(id, { id: p.turn.id, status: p.turn.status, error: p.turn.error });
      try {
        const { session } = this.own(id);
        if (p.turn.status === 'completed') session.completedOnce = true;
        this.store.save().catch(() => {});
      } catch {}
      for (const [key, r] of this.requests) if (r.params.threadId === id) this.requests.delete(key);
    }
    if (msg.method === 'serverRequest/resolved') this.requests.delete(JSON.stringify(p.requestId));
    this.publish(id, msg.method, p);
  }
  request(msg) {
    const id = msg.params?.threadId;
    try {
      this.own(id);
    } catch {
      this.rpc.respond(msg.id, null, {
        code: -32601,
        message: 'Client cannot route this request to a Zotero conversation',
      });
      return;
    }
    this.requests.set(JSON.stringify(msg.id), msg);
    this.publish(id, 'bridge/request', msg);
  }
  async ready() {
    await this.rpc.start();
  }
  paper(paper) {
    const key = this.store.key(paper);
    return (this.store.records[key] ||= { key, title: paper.title || '', sessions: [] });
  }
  async list(paper) {
    const record = this.paper(paper);
    return {
      paper: { key: record.key, title: record.title },
      sessions: record.sessions.map((s) => ({ ...s, busy: this.active.has(s.threadId) })),
      projectRoot: this.store.projectRoot,
    };
  }
  async resume(threadId) {
    this.own(threadId);
    await this.ready();
    if (!this.loaded.has(threadId)) {
      const r = await this.rpc.call('thread/resume', { threadId, excludeTurns: true });
      this.loaded.add(threadId);
      if (r.thread.status?.type === 'active')
        this.active.set(
          threadId,
          r.thread.turns?.find((t) => t.status === 'inProgress')?.id || null,
        );
      return r;
    }
  }
  async send({ paper, threadId, text = '', model, effort, task, images = [] }) {
    if (typeof text !== 'string' || (!text.trim() && !images?.length))
      throw new Error('请先输入问题或添加图片');
    const imageInput = await this.store.media.inputs(images);
    if (task && task !== 'annotate') throw new Error('不支持的论文任务');
    if (text.length > 150000) throw new Error('问题过长，请拆成多次发送');
    return this.lock(this.store.key(paper), async () => {
      await this.ready();
      const record = this.paper(paper);
      let session, skillInput;
      if (task === 'annotate') {
        const listing = await this.rpc.call('skills/list', {
          cwds: [this.store.projectRoot],
          forceReload: true,
        });
        const skill = (listing.data || [])
          .flatMap((d) => d.skills || [])
          .find((s) => s.name === 'zotero-paper-annotator' && s.enabled !== false);
        if (!skill?.path)
          throw new Error('未找到已启用的论文批注技能，请先安装 zotero-paper-annotator。');
        skillInput = { type: 'skill', name: skill.name, path: skill.path };
      }
      if (threadId) {
        session = record.sessions.find((s) => s.threadId === threadId);
        if (!session) throw new Error('当前论文与所选会话不匹配');
        await this.resume(threadId);
      } else {
        const started = await this.rpc.call('thread/start', {
          cwd: this.store.projectRoot,
          serviceName: 'codex_for_zotero',
        });
        threadId = started.thread.id;
        this.loaded.add(threadId);
        session = {
          threadId,
          title: paper.title || '论文阅读',
          createdAt: Date.now(),
          attachment: null,
          attached: false,
        };
        record.sessions.unshift(session);
        await this.store.save();
        await this.rpc.call('thread/name/set', { threadId, name: `论文 · ${session.title}` });
      }
      if (this.active.has(threadId)) throw new Error('Codex 正在回复，请先停止当前回复再发送');
      if (!session.attached && !session.attachment) {
        session.attachment = await this.store.attach(paper, session);
        await this.store.save();
      }
      const input = session.attached
        ? [{ type: 'text', text }]
        : firstInput(paper, session.attachment, text);
      input.push(...imageInput);
      if (skillInput) input.push(skillInput);
      // Preserve native permissions, tools and model defaults; only explicit UI choices override them.
      const params = { threadId, input, summary: 'auto' };
      if (model) params.model = model;
      if (effort) params.effort = effort;
      this.active.set(threadId, null);
      try {
        const result = await this.rpc.call('turn/start', params);
        session.attached = true;
        session.updatedAt = Date.now();
        session.model = model || session.model || null;
        await this.store.save();
        if (this.active.has(threadId)) this.active.set(threadId, result.turn.id);
        return { threadId, turnId: result.turn.id, attachment: session.attachment, cursor: 0 };
      } catch (e) {
        this.active.delete(threadId);
        throw Object.assign(e, { threadId });
      }
    });
  }
  async history(threadId, cursor = null) {
    await this.resume(threadId);
    const anchor = this.cursor;
    const page = await this.rpc.call('thread/turns/list', {
      threadId,
      limit: 30,
      sortDirection: 'desc',
      itemsView: 'full',
      ...(cursor ? { cursor } : {}),
    });
    const { session } = this.own(threadId);
    if (page.data.some((t) => t.status === 'completed') && !session.completedOnce) {
      session.completedOnce = true;
      await this.store.save();
    }
    const latest = page.data[0];
    if (latest && !this.active.has(threadId))
      this.turnStates.set(threadId, { id: latest.id, status: latest.status, error: latest.error });
    return {
      session: { ...session },
      state: this.turnStates.get(threadId),
      turns: [...page.data].reverse(),
      nextCursor: page.nextCursor,
      cursor: anchor,
      busy: this.active.has(threadId),
      requests: this.pending(threadId),
    };
  }
  pending(threadId) {
    return [...this.requests.values()].filter((r) => r.params?.threadId === threadId);
  }
  poll(threadId, after) {
    this.own(threadId);
    const queue = this.events.get(threadId) || [];
    return {
      session: { ...this.own(threadId).session },
      state: this.turnStates.get(threadId),
      events: queue.filter((e) => e.seq > after),
      cursor: this.cursor,
      resync: queue.length > 0 && after > 0 && after < queue[0].seq - 1,
      busy: this.active.has(threadId),
      requests: this.pending(threadId),
    };
  }
  async rename(threadId, name) {
    this.own(threadId);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200)
      throw new Error('标题须为 1–200 个字符');
    await this.resume(threadId);
    const title = name.trim();
    await this.rpc.call('thread/name/set', { threadId, name: title });
    const { session } = this.own(threadId);
    session.title = title;
    await this.store.save();
    this.publish(threadId, 'thread/name/updated', { threadId, threadName: title });
    return { title };
  }
  async interrupt(threadId) {
    await this.resume(threadId);
    let turnId = this.active.get(threadId);
    if (!turnId && this.active.has(threadId)) {
      const r = await this.rpc.call('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });
      turnId = r.data.find((t) => t.status === 'inProgress')?.id;
    }
    if (turnId) await this.rpc.call('turn/interrupt', { threadId, turnId });
    return { interrupted: !!turnId };
  }
  reply(threadId, id, result) {
    this.own(threadId);
    const key = JSON.stringify(id),
      r = this.requests.get(key);
    if (!r || r.params.threadId !== threadId) throw new Error('这个请求已经结束，请刷新会话');
    this.rpc.respond(id, result);
    this.requests.delete(key);
    return { ok: true };
  }
}
