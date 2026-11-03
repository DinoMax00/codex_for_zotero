import { markdownWithMath, visibleTurnItems } from './presentation.mjs';
import { AnnotationBridge } from './annotation-bridge.js';
import createDOMPurify from 'dompurify';
import css from './style.css';

const NS = 'http://www.w3.org/1999/xhtml';
const PANELS = new Map();
const documents = new Set();
const PANE_ID = 'codex-for-zotero-chat';
let registeredPaneID;
const home = Services.dirsvc.get('Home', Ci.nsIFile).path;
const preference = (name, fallback) =>
  Zotero.Prefs.get(`extensions.codex-for-zotero.${name}`, true) || fallback;
const delay = (ms) => Zotero.Promise.delay(ms);

async function resourceText(relative) {
  const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  return new Promise((resolve, reject) => {
    const channel = NetUtil.newChannel({ uri: rootURI + relative, loadUsingSystemPrincipal: true });
    NetUtil.asyncFetch(channel, (stream, status) => {
      try {
        if (status !== 0) throw new Error(`读取插件资源失败 (${status})`);
        resolve(NetUtil.readInputStreamToString(stream, stream.available(), { charset: 'UTF-8' }));
      } catch (e) {
        reject(e);
      } finally {
        stream?.close();
      }
    });
  });
}

class Bridge {
  async ensure() {
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().catch((e) => {
      this.lastError = { message: e.message, stack: e.stack };
      this.connecting = null;
      throw e;
    });
    return this.connecting;
  }
  async connect() {
    this.dir = PathUtils.join(Zotero.Profile.dir, 'codex-for-zotero');
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true, permissions: 0o700 });
    const connectionFile = PathUtils.join(this.dir, 'connection.json');
    try {
      this.connection = JSON.parse(await IOUtils.readUTF8(connectionFile));
      const health = await this.request('/health', null, true);
      if (health.version === pluginVersion) return;
      await this.request('/shutdown', {}, true);
    } catch {}
    const serviceDir = PathUtils.join(this.dir, `service-${pluginVersion}`);
    await IOUtils.makeDirectory(serviceDir, { ignoreExisting: true });
    for (const name of ['server.mjs', 'rpc.mjs', 'store.mjs', 'service.mjs']) {
      const source = await resourceText('bridge/' + name);
      await IOUtils.writeUTF8(PathUtils.join(serviceDir, name), source, { permissions: 0o600 });
    }
    const paths = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
    let nodePath = preference('nodePath', '');
    if (!nodePath)
      for (const p of paths)
        if (await IOUtils.exists(p)) {
          nodePath = p;
          break;
        }
    if (!nodePath) throw new Error('找不到 Node.js。请在连接设置中填写 Node 路径。');
    let codexPath = preference('codexPath', '');
    if (!codexPath)
      for (const p of [
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
        '/Applications/Codex.app/Contents/Resources/codex',
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        PathUtils.join(home, '.local', 'bin', 'codex'),
      ])
        if (await IOUtils.exists(p)) {
          codexPath = p;
          break;
        }
    if (!codexPath) throw new Error('找不到本地 Codex。请先安装并登录 Codex CLI。');
    this.codexPath = codexPath;
    this.nodePath = nodePath;
    const projectRoot = preference(
      'projectRoot',
      PathUtils.join(home, 'Documents', 'ChatGPT', 'paper reading'),
    );
    const configFile = PathUtils.join(this.dir, 'config.json');
    await IOUtils.writeUTF8(
      configFile,
      JSON.stringify({
        version: pluginVersion,
        codexPath,
        projectRoot,
        dataDir: this.dir,
        connectionFile,
        parentPid: Services.appinfo.processID,
      }),
    );
    await IOUtils.setPermissions(configFile, 0o600);
    const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    this.process = await Subprocess.call({
      command: nodePath,
      arguments: [PathUtils.join(serviceDir, 'server.mjs'), '--config', configFile],
      stderr: 'stdout',
    });
    this.process.stdout.readString().catch(() => {});
    for (let attempt = 0; attempt < 80; attempt++) {
      await delay(150);
      try {
        const connection = JSON.parse(await IOUtils.readUTF8(connectionFile));
        if (connection.pid !== this.process.pid) continue;
        this.connection = connection;
        await this.request('/health', null, true);
        return;
      } catch {}
    }
    this.process.kill();
    throw new Error('本地连接未能启动，请检查 Node 和 Codex 路径。');
  }
  async request(route, data, skipEnsure = false) {
    if (!skipEnsure) await this.ensure();
    const opts = {
      headers: { Authorization: `Bearer ${this.connection.token}` },
      responseType: 'text',
      timeout: ['/health', '/shutdown'].includes(route) ? 3000 : 200000,
      successCodes: false,
    };
    if (data !== null) {
      opts.body = JSON.stringify(data);
      opts.headers['Content-Type'] = 'application/json';
    }
    let r;
    try {
      r = await Zotero.HTTP.request(
        data === null ? 'GET' : 'POST',
        this.connection.url + route,
        opts,
      );
    } catch (e) {
      this.connecting = null;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(r.responseText);
    } catch {
      throw new Error('本地 Codex 连接返回了无效响应');
    }
    if (r.status !== 200)
      throw Object.assign(new Error(parsed.error || `连接失败 (${r.status})`), {
        threadId: parsed.threadId,
      });
    return parsed;
  }
  async stop() {
    try {
      if (this.connection) await this.request('/shutdown', {}, true);
    } catch {}
    this.process?.kill();
    await delay(100);
    this.process = null;
    this.connecting = null;
    this.connection = null;
  }
}
const bridge = new Bridge();
let annotationBridge;

function element(doc, tag, cls, text) {
  const node = doc.createElementNS(NS, tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(doc, label, cls, handler) {
  const b = element(doc, 'button', cls, label);
  b.type = 'button';
  b.addEventListener('click', handler);
  return b;
}
function textOf(item) {
  if (item.type === 'userMessage') {
    const text = (item.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return text.includes('# 用户提问\n\n')
      ? text.split('# 用户提问\n\n').slice(1).join('# 用户提问\n\n')
      : text;
  }
  return item.text || '';
}
function installDocument(doc) {
  if (documents.has(doc)) return;
  documents.add(doc);
  doc.l10n?.addResourceIds(['chrome://codex-for-zotero/locale/codex-for-zotero.ftl']);
  const style = element(doc, 'style');
  style.id = 'codex-for-zotero-style';
  style.textContent = css;
  doc.documentElement.appendChild(style);
}

async function resolvePaper(item, doc) {
  let attachment;
  const win = doc.defaultView;
  const tabID = win.Zotero_Tabs?.selectedID;
  const reader = tabID ? Zotero.Reader.getByTabID(tabID) : null;
  if (reader?.itemID) attachment = Zotero.Items.get(reader.itemID);
  if (!attachment && item?.isPDFAttachment?.()) attachment = item;
  if (!attachment && item?.isRegularItem?.()) {
    const best = await item.getBestAttachment();
    if (best?.isPDFAttachment?.()) attachment = best;
    else
      attachment = item
        .getAttachments()
        .map((id) => Zotero.Items.get(id))
        .find((a) => a.isPDFAttachment());
  }
  if (!attachment?.isPDFAttachment?.()) throw new Error('请选择带 PDF 的论文，或打开一篇 PDF。');
  const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
  const file = await attachment.getFilePathAsync();
  if (!file || !(await IOUtils.exists(file)))
    throw new Error('这篇论文的 PDF 尚未下载，请先在 Zotero 中打开附件。');
  return {
    attachmentKey: attachment.key,
    itemKey: parent.key,
    libraryID: attachment.libraryID,
    title: parent.getField('title') || attachment.getField('title'),
    creators: parent
      .getCreators()
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(' '))
      .join('; '),
    year: parent.getField('date')?.match(/\b(?:19|20)\d{2}\b/)?.[0] || '',
    path: file,
  };
}

class ChatPanel {
  constructor(body, doc) {
    this.body = body;
    this.doc = doc;
    this.win = doc.defaultView;
    this.generation = 0;
    this.cursor = 0;
    this.threadId = null;
    this.messages = new Map();
    this.running = false;
    this.sending = false;
    this.disposed = false;
    this.purify = createDOMPurify(this.win);
    this.renderShell();
  }
  renderShell() {
    const d = this.doc;
    this.root = element(d, 'section', 'cfz');
    this.root.setAttribute('aria-label', 'Codex 论文对话');
    this.paperLabel = element(d, 'span');
    this.head = element(d, 'header', 'cfz-head');
    this.head.hidden = true;
    this.titleButton = button(d, '', 'cfz-title', () => {});
    this.titleButton.title = '双击修改会话标题';
    this.titleButton.setAttribute('aria-label', '会话标题，双击改名');
    this.titleButton.addEventListener('dblclick', () => this.editTitle());
    this.titleButton.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        this.editTitle();
      }
    });
    this.titleInput = element(d, 'input', 'cfz-title-input');
    this.titleInput.hidden = true;
    this.titleInput.maxLength = 200;
    this.titleInput.setAttribute('aria-label', '修改会话标题');
    this.titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.saveTitle();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelTitle();
      }
    });
    this.titleInput.addEventListener('blur', () => this.saveTitle());
    this.runLabel = element(d, 'span', 'cfz-run-label');
    this.runLabel.setAttribute('role', 'status');
    this.runLabel.setAttribute('aria-live', 'polite');
    this.head.append(this.titleButton, this.titleInput, this.runLabel);
    this.menu = element(d, 'div', 'cfz-menu');
    this.menu.hidden = true;
    this.sessions = element(d, 'select', 'cfz-sessions');
    this.sessions.setAttribute('aria-label', '历史对话');
    this.sessions.appendChild(this.option('新对话', ''));
    this.sessions.addEventListener('change', () => {
      this.menu.hidden = true;
      this.selectSession(this.sessions.value);
    });
    this.openButton = button(d, '在 Codex 打开', 'cfz-menu-item', () => {
      this.menu.hidden = true;
      if (this.threadId) Zotero.launchURL(`codex://threads/${encodeURIComponent(this.threadId)}`);
    });
    this.menu.append(
      button(d, '新对话', 'cfz-menu-item', () => this.newConversation()),
      this.sessions,
      this.openButton,
      button(d, '重新连接', 'cfz-menu-item', async () => {
        this.menu.hidden = true;
        await bridge.stop();
        await this.setItem(this.currentItem);
      }),
      button(d, '连接设置', 'cfz-menu-item', () => {
        this.menu.hidden = true;
        this.settings();
      }),
    );
    this.log = element(d, 'div', 'cfz-log');
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-label', '对话内容');
    this.requests = element(d, 'div', 'cfz-requests');
    const composer = element(d, 'div', 'cfz-composer');
    this.input = element(d, 'textarea', 'cfz-input');
    this.input.placeholder = '发送消息…';
    this.input.rows = 2;
    this.input.setAttribute('aria-label', '给 Codex 发送问题');
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = Math.min(160, Math.max(46, this.input.scrollHeight)) + 'px';
    });
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || this.composing || e.keyCode === 229) return;
      e.stopPropagation();
      if (!e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    const actions = element(d, 'div', 'cfz-actions');
    this.models = element(d, 'select', 'cfz-models');
    this.models.setAttribute('aria-label', '选择 Codex 模型');
    this.models.appendChild(this.option('模型', ''));
    this.models.addEventListener('focus', () => this.loadModels());
    this.annotateButton = button(d, '', 'cfz-annotate', () => this.annotate());
    this.annotateButton.title = '精读当前论文，高亮核心观点并添加中文批注';
    this.annotateButton.setAttribute('aria-label', '自动阅读并批注论文');
    this.annotateButton.disabled = true;
    const annotateIcon = element(d, 'img');
    annotateIcon.src = 'chrome://codex-for-zotero/content/annotate.svg';
    annotateIcon.alt = '';
    annotateIcon.setAttribute('aria-hidden', 'true');
    this.annotateButton.append(annotateIcon, element(d, 'span', null, '批注'));
    this.sendButton = button(d, '↑', 'cfz-send', () => this.send());
    this.sendButton.title = '发送 · Enter（Shift + Enter 换行）';
    this.sendButton.setAttribute('aria-label', '发送');
    this.stopButton = button(d, '■', 'cfz-stop', () => this.stop());
    this.stopButton.title = '停止';
    this.stopButton.setAttribute('aria-label', '停止回复');
    this.stopButton.hidden = true;
    const tools = element(d, 'div', 'cfz-composer-tools');
    tools.append(this.models, this.annotateButton);
    actions.append(tools, this.stopButton, this.sendButton);
    composer.append(this.input, actions);
    this.status = element(d, 'div', 'cfz-status');
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    this.root.append(this.menu, this.head, this.log, this.requests, composer, this.status);
    this.body.appendChild(this.root);
    this.section = this.body.closest('item-pane-custom-section') || this.body;
    this.section.classList.add('cfz-section');
    this.onWheel = (e) => {
      if (e.ctrlKey) return;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      let target = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
      let scroller;
      for (let n = target; n && this.root.contains(n); n = n.parentElement) {
        const style = this.win.getComputedStyle(n),
          overflow = horizontal ? style.overflowX : style.overflowY;
        if (
          /auto|scroll/.test(overflow) &&
          (horizontal ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight)
        ) {
          scroller = n;
          break;
        }
      }
      scroller ||= this.log;
      e.preventDefault();
      e.stopPropagation();
      const scale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? scroller.clientHeight : 1;
      if (horizontal) scroller.scrollLeft += e.deltaX * scale;
      else scroller.scrollTop += e.deltaY * scale;
    };
    this.section.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.layout = () => {
      if (this.frame || this.disposed) return;
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        const outer = this.section.closest('.zotero-view-item');
        const inset =
          this.root.getBoundingClientRect().top - this.section.getBoundingClientRect().top;
        const height = Math.max(
          260,
          (outer?.clientHeight || this.win.innerHeight - 90) - Math.max(0, inset) - 10,
        );
        if (this.root.style.height !== Math.round(height) + 'px')
          this.root.style.height = Math.round(height) + 'px';
      });
    };
    this.resizeObserver = new this.win.ResizeObserver(this.layout);
    const outer = this.section.closest('.zotero-view-item');
    if (outer) this.resizeObserver.observe(outer);
    this.win.addEventListener('resize', this.layout);
    this.layout();
    this.welcome();
  }
  option(label, value) {
    const o = element(this.doc, 'option', null, label);
    o.value = value;
    return o;
  }
  statusText(text, error = false) {
    if (error) {
      Zotero.debug(`[Codex for Zotero] ${text}`);
      if (/NS_ERROR|nsIURI|Component returned|TypeError|ReferenceError/.test(text))
        text = this.paper
          ? '本地连接失败，请从菜单重试连接。'
          : '无法读取当前 PDF，请重新打开论文。';
    }
    const idle =
      !error &&
      (!text ||
        text.includes('paper reading') ||
        text.startsWith('首次发送') ||
        text === 'Codex 正在回复…');
    this.status.textContent = idle ? '' : text;
    this.status.hidden = idle;
    this.status.classList.toggle('cfz-error', error);
  }
  setRunning(value) {
    this.running = value;
    this.refreshHeader();
    this.stopButton.hidden = !value;
    this.sendButton.hidden = value;
    this.sendButton.disabled = value || this.sending || !this.paper;
    this.annotateButton.disabled = value || this.sending || !this.paper;
    this.input.disabled = this.sending;
  }
  refreshHeader() {
    const title = this.session?.completedOnce ? this.session.title : '';
    this.titleButton.textContent = title;
    this.titleButton.hidden = !title || this.editingTitle;
    this.head.hidden = !title && !this.running && !this.sending;
    const state = this.running || this.sending ? 'inProgress' : this.runState?.status;
    this.runLabel.dataset.state = state || 'idle';
    this.runLabel.textContent =
      state === 'inProgress'
        ? '回复中'
        : state === 'completed'
          ? '已完成'
          : state === 'interrupted'
            ? '已停止'
            : state === 'failed'
              ? '回复失败'
              : '';
    this.runLabel.hidden = !this.runLabel.textContent;
  }
  applySession(data) {
    if (data.session) this.session = data.session;
    if (data.state) this.runState = data.state;
    this.refreshHeader();
  }
  editTitle() {
    if (!this.threadId || !this.session?.completedOnce || this.editingTitle) return;
    this.editingTitle = true;
    this.titleInput.value = this.session.title;
    this.titleInput.hidden = false;
    this.titleButton.hidden = true;
    this.titleInput.focus();
    this.titleInput.select();
  }
  cancelTitle() {
    this.editingTitle = false;
    this.titleInput.hidden = true;
    this.refreshHeader();
  }
  async saveTitle() {
    if (!this.editingTitle || this.renaming) return;
    const name = this.titleInput.value.trim(),
      id = this.threadId,
      gen = this.generation;
    if (!name || name === this.session?.title) {
      this.cancelTitle();
      return;
    }
    this.renaming = true;
    this.titleInput.disabled = true;
    try {
      const r = await bridge.request('/rename', { threadId: id, name });
      if (gen === this.generation) {
        this.session.title = r.title;
        for (const o of this.sessions.options) if (o.value === id) o.textContent = r.title;
        this.cancelTitle();
      }
    } catch (e) {
      this.statusText(e.message, true);
    } finally {
      this.renaming = false;
      this.titleInput.disabled = false;
    }
  }
  finishTurn(turn) {
    const messages = [...this.messages.values()].filter((m) => m.turnId === turn.id);
    const keep = new Set(
      visibleTurnItems({ ...turn, items: messages.map((m) => m.item) }).map((i) => i.id),
    );
    for (const m of messages)
      if (!keep.has(m.item.id)) {
        m.node.remove();
        this.messages.delete(m.item.id);
      }
  }
  welcome() {
    this.log.replaceChildren();
    this.messages.clear();
  }
  async setItem(item) {
    const generation = ++this.generation;
    this.win.clearTimeout(this.timer);
    this.paper = null;
    this.setRunning(false);
    try {
      const paper = await resolvePaper(item, this.doc);
      if (generation !== this.generation || this.disposed) return;
      const same = this.key === `${paper.libraryID}-${paper.attachmentKey}`;
      this.paper = paper;
      this.key = `${paper.libraryID}-${paper.attachmentKey}`;
      this.paperLabel.textContent = paper.title;
      this.input.title = paper.title;
      const data = await bridge.request('/paper', { paper });
      if (generation !== this.generation || this.disposed) return;
      this.sessions.replaceChildren(this.option('新对话', ''));
      for (const s of data.sessions)
        this.sessions.appendChild(
          this.option(`${new Date(s.createdAt).toLocaleDateString()} · ${s.title}`, s.threadId),
        );
      const target =
        same && data.sessions.some((s) => s.threadId === this.threadId)
          ? this.threadId
          : data.sessions[0]?.threadId;
      this.statusText('本地 Codex · paper reading');
      this.sendButton.disabled = false;
      this.loadModels();
      if (target) await this.selectSession(target);
      else this.newConversation();
    } catch (e) {
      if (generation === this.generation) {
        this.statusText(e.message, true);
        this.sendButton.disabled = true;
      }
    }
  }
  async selectSession(id) {
    const gen = ++this.generation;
    this.win.clearTimeout(this.timer);
    this.threadId = id || null;
    this.session = null;
    this.runState = null;
    this.cancelTitle();
    this.sessions.value = id || '';
    this.cursor = 0;
    this.requests.replaceChildren();
    this.requestSignature = '';
    if (!id) {
      this.welcome();
      this.setRunning(false);
      return;
    }
    this.statusText('正在恢复 Codex 对话…');
    try {
      const h = await bridge.request('/history', { threadId: id });
      if (gen !== this.generation || this.disposed) return;
      this.log.replaceChildren();
      this.messages.clear();
      this.historyCursor = h.nextCursor;
      if (h.nextCursor) this.addHistoryButton();
      this.applySession(h);
      for (const t of h.turns) for (const it of visibleTurnItems(t)) this.updateItem(it, t.id);
      this.cursor = h.cursor;
      this.setRunning(h.busy);
      this.renderRequests(h.requests);
      this.scrollBottom();
      this.statusText(h.busy ? 'Codex 正在回复…' : '本地 Codex · paper reading');
      this.poll(gen);
    } catch (e) {
      if (gen === this.generation) this.statusText(e.message, true);
    }
  }
  newConversation() {
    this.generation++;
    this.win.clearTimeout(this.timer);
    this.threadId = null;
    this.session = null;
    this.runState = null;
    this.cancelTitle();
    this.sessions.value = '';
    this.cursor = 0;
    this.requests.replaceChildren();
    this.requestSignature = '';
    this.menu.hidden = true;
    this.welcome();
    this.setRunning(false);
    this.statusText('');
  }
  toggleMenu() {
    this.menu.hidden = !this.menu.hidden;
    this.openButton.disabled = !this.threadId;
  }
  addHistoryButton() {
    const b = button(this.doc, '载入更早的消息', 'cfz-history', async () => {
      const id = this.threadId,
        gen = this.generation;
      b.disabled = true;
      try {
        const h = await bridge.request('/history', { threadId: id, cursor: this.historyCursor });
        if (gen !== this.generation) return;
        const fragment = this.doc.createDocumentFragment();
        for (const t of h.turns)
          for (const it of visibleTurnItems(t)) {
            const node = this.updateItem(it, t.id);
            if (node) fragment.appendChild(node);
          }
        b.after(fragment);
        this.historyCursor = h.nextCursor;
        if (!h.nextCursor) b.remove();
        else b.disabled = false;
      } catch (e) {
        this.statusText(e.message, true);
        b.disabled = false;
      }
    });
    this.log.prepend(b);
  }
  markdown(target, text) {
    const { html, formulae, citations } = markdownWithMath(text);
    const fragment = this.purify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'iframe', 'svg', 'math'],
      FORBID_ATTR: ['style'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
    target.replaceChildren(this.doc.importNode(fragment, true));
    // Only KaTeX-generated MathML enters this path; paper HTML remains sanitized.
    const embedded = [
      ...formulae.map((f) => ({ ...f, kind: 'math' })),
      ...citations.map((c) => ({ ...c, kind: 'citation' })),
    ];
    if (embedded.length) {
      const walker = this.doc.createTreeWalker(target, this.win.NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const matches = embedded.filter((f) => node.textContent.includes(f.token));
        if (!matches.length) continue;
        let rest = node.textContent;
        const replacement = this.doc.createDocumentFragment();
        while (rest) {
          let found = null,
            index = rest.length;
          for (const f of matches) {
            const i = rest.indexOf(f.token);
            if (i >= 0 && i < index) {
              index = i;
              found = f;
            }
          }
          if (!found) {
            replacement.appendChild(this.doc.createTextNode(rest));
            break;
          }
          replacement.appendChild(this.doc.createTextNode(rest.slice(0, index)));
          if (found.kind === 'citation') replacement.appendChild(this.citationButton(found));
          else {
            const wrap = element(
              this.doc,
              'span',
              found.display ? 'cfz-math cfz-math-display' : 'cfz-math',
            );
            const xml = new this.win.DOMParser().parseFromString(
              `<div xmlns="${NS}">${found.markup}</div>`,
              'application/xhtml+xml',
            );
            for (const child of xml.documentElement.childNodes)
              wrap.appendChild(this.doc.importNode(child, true));
            replacement.appendChild(wrap);
          }
          rest = rest.slice(index + found.token.length);
        }
        node.replaceWith(replacement);
      }
    }
    for (const a of target.querySelectorAll('a'))
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) Zotero.launchURL(href);
      });
  }
  citationButton(citation) {
    const label = citation.pending
      ? '论文'
      : citation.valid
        ? `论文${citation.page ? ' · 第 ' + citation.page + ' 页' : ''} ↗`
        : '引用不可用';
    const node = button(this.doc, label, 'cfz-citation', () =>
      this.openCitation(citation).catch((e) => this.statusText(e.message, true)),
    );
    node.disabled = !citation.valid;
    node.title = citation.pending
      ? '引用尚未完整'
      : citation.valid
        ? '打开论文：' + citation.path.split('/').at(-1)
        : '无法识别该文件引用';
    node.setAttribute(
      'aria-label',
      citation.valid
        ? '打开引用的论文' + (citation.page ? '，第 ' + citation.page + ' 页' : '')
        : label,
    );
    return node;
  }
  async openCitation(citation) {
    if (!citation.valid) return;
    if (
      this.paper &&
      (citation.path === this.paper.path || citation.path === this.session?.attachment)
    ) {
      const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
        this.paper.libraryID,
        this.paper.attachmentKey,
      );
      if (attachment?.isPDFAttachment()) {
        await Zotero.Reader.open(
          attachment.id,
          citation.page ? { pageIndex: citation.page - 1 } : undefined,
        );
        return;
      }
    }
    try {
      const metadata = JSON.parse(
        await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(citation.path), 'paper.json')),
      );
      if (
        metadata.path === citation.path &&
        Number.isInteger(metadata.libraryID) &&
        /^[A-Z0-9]{8}$/.test(metadata.attachmentKey || '')
      ) {
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
          metadata.libraryID,
          metadata.attachmentKey,
        );
        if (attachment?.isPDFAttachment()) {
          await Zotero.Reader.open(
            attachment.id,
            citation.page ? { pageIndex: citation.page - 1 } : undefined,
          );
          return;
        }
      }
    } catch {}
    if (!(await IOUtils.exists(citation.path)))
      throw new Error('引用的 PDF 不在本机，请先下载或重新打开论文。');
    const bytes = await IOUtils.read(citation.path, { maxBytes: 1024 });
    if (!new this.win.TextDecoder().decode(bytes).includes('%PDF-'))
      throw new Error('引用文件不是有效的 PDF。');
    Zotero.launchFile(citation.path);
  }
  updateItem(it, turnId) {
    if (!it || !it.id || !['agentMessage', 'userMessage', 'plan', 'reasoning'].includes(it.type))
      return;
    const text = it.type === 'reasoning' ? (it.summary || []).join('\n\n') : textOf(it);
    if ((it.type === 'userMessage' || it.type === 'reasoning') && !text) return;
    const wasBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    let m = this.messages.get(it.id);
    if (!m) {
      const node = element(this.doc, 'article', `cfz-message cfz-${it.type}`);
      const label = element(this.doc, 'div', 'cfz-role');
      const content = element(this.doc, 'div', 'cfz-content');
      node.append(label, content);
      this.log.appendChild(node);
      m = { node, label, content, text: '', item: it };
      this.messages.set(it.id, m);
    }
    m.item = { ...m.item, ...it };
    m.turnId = turnId || m.turnId || this.activeTurnId;
    m.text = text;
    const transient =
      it.type === 'reasoning' || it.type === 'plan' || m.item.phase === 'commentary';
    m.node.classList.toggle('cfz-transient', transient);
    m.label.textContent =
      it.type === 'reasoning' ? '思考摘要' : it.type === 'plan' ? '计划' : '进度';
    if (it.type === 'userMessage') m.content.textContent = m.text;
    else this.markdown(m.content, m.text);
    if (wasBottom) this.scrollBottom();
    return m.node;
  }
  scrollBottom() {
    this.log.scrollTop = this.log.scrollHeight;
  }
  event(e) {
    const p = e.params || {};
    if (e.method === 'item/started' || e.method === 'item/completed')
      this.updateItem(p.item, p.turnId);
    else if (e.method === 'item/agentMessage/delta') {
      let m = this.messages.get(p.itemId);
      if (!m) {
        this.updateItem({ type: 'agentMessage', id: p.itemId, text: '' }, p.turnId);
        m = this.messages.get(p.itemId);
      }
      if (m) {
        m.text = p.fullText === undefined ? m.text + p.delta : p.fullText;
        this.updateItem({ ...m.item, text: m.text }, p.turnId);
      }
    } else if (e.method === 'item/reasoning/summaryTextDelta') {
      const id = p.itemId,
        m = this.messages.get(id),
        summary = m?.item.summary?.slice() || [];
      summary[p.summaryIndex] =
        p.fullText === undefined ? (summary[p.summaryIndex] || '') + p.delta : p.fullText;
      this.updateItem({ id, type: 'reasoning', summary }, p.turnId);
    } else if (e.method === 'thread/name/updated') {
      if (this.session && p.threadName) {
        this.session.title = p.threadName;
        this.refreshHeader();
      }
    } else if (e.method === 'turn/started') {
      this.activeTurnId = p.turn.id;
      this.runState = { id: p.turn.id, status: 'inProgress' };
      this.setRunning(true);
      this.statusText('Codex 正在回复…');
    } else if (e.method === 'turn/completed') {
      this.finishTurn(p.turn);
      this.runState = p.turn;
      if (this.session && p.turn.status === 'completed') this.session.completedOnce = true;
      this.setRunning(false);
      this.statusText(
        p.turn.status === 'failed'
          ? p.turn.error?.message || 'Codex 本轮执行失败'
          : p.turn.status === 'interrupted'
            ? '已停止'
            : '本地 Codex · paper reading',
        p.turn.status === 'failed',
      );
    } else if (e.method === 'error')
      this.statusText(p.error?.message || p.message || 'Codex 返回错误', true);
    else if (e.method === 'bridge/disconnected') {
      this.setRunning(false);
      this.statusText('Codex 连接中断，请切换会话重新连接。', true);
    }
  }
  async poll(gen) {
    if (gen !== this.generation || !this.threadId || this.disposed) return;
    try {
      const data = await bridge.request(
        `/events?threadId=${encodeURIComponent(this.threadId)}&after=${this.cursor}`,
        null,
      );
      if (gen !== this.generation || this.disposed) return;
      if (data.resync) {
        await this.selectSession(this.threadId);
        return;
      }
      for (const e of data.events) this.event(e);
      this.cursor = data.cursor;
      this.applySession(data);
      this.setRunning(data.busy);
      this.renderRequests(data.requests);
    } catch (e) {
      if (gen === this.generation) this.statusText(e.message, true);
    }
    if (gen === this.generation && !this.disposed)
      this.timer = this.win.setTimeout(() => this.poll(gen), this.running ? 300 : 1500);
  }
  async annotate() {
    return this.send({
      task: 'annotate',
      preserveDraft: true,
      text: '使用 $zotero-paper-annotator 精读当前论文，在标题处批注中文全文总结，并准确高亮正文中的核心观点、方法、重要实验结论和局限，添加中文解释。请静默保存并复核，不打开执行 JavaScript 等工具窗口，不加署名或内部标记。跳过已有自动批注，保留我现有的批注和修改。',
    });
  }
  async send(options = {}) {
    const text = options.text ?? this.input.value;
    if (this.sending || this.running || !this.paper || !text.trim()) return;
    this.sending = true;
    this.setRunning(false);
    this.statusText(this.threadId ? '发送给 Codex…' : '正在附上 PDF 并创建 Codex 对话…');
    const generation = this.generation,
      paper = this.paper;
    try {
      const r = await bridge.request('/send', {
        paper,
        threadId: this.threadId,
        text,
        model: this.models.value || undefined,
        ...(options.task ? { task: options.task } : {}),
      });
      if (generation !== this.generation || this.disposed) return;
      if (!options.preserveDraft) {
        this.input.value = '';
        this.input.style.height = '';
      }
      this.threadId = r.threadId;
      if (!Array.from(this.sessions.options).some((o) => o.value === r.threadId))
        this.sessions.appendChild(this.option(paper.title, r.threadId));
      this.sessions.value = r.threadId;
      await this.selectSession(r.threadId);
    } catch (e) {
      if (generation === this.generation) {
        if (e.threadId) this.threadId = e.threadId;
        this.statusText(e.message, true);
      }
    } finally {
      this.sending = false;
      this.input.disabled = false;
      this.setRunning(this.running);
    }
  }
  async stop() {
    try {
      await bridge.request('/interrupt', { threadId: this.threadId });
      this.statusText('正在停止…');
    } catch (e) {
      this.statusText(e.message, true);
    }
  }
  async loadModels() {
    if (this.modelsLoaded || this.modelsLoading) return;
    this.modelsLoading = true;
    try {
      const r = await bridge.request('/models', {});
      const previous = this.models.value;
      this.models.replaceChildren();
      for (const m of r.data || [])
        this.models.appendChild(this.option(m.displayName || m.model, m.model));
      this.models.value =
        previous ||
        r.defaultModel ||
        (r.data || []).find((m) => m.isDefault)?.model ||
        r.data?.[0]?.model ||
        '';
      this.modelsLoaded = true;
    } catch (e) {
      this.statusText(e.message, true);
    } finally {
      this.modelsLoading = false;
    }
  }
  renderRequests(requests = []) {
    const sig = JSON.stringify(requests.map((r) => r.id));
    if (sig === this.requestSignature) return;
    this.requestSignature = sig;
    this.requests.replaceChildren();
    for (const req of requests) {
      const p = req.params || {},
        box = element(this.doc, 'section', 'cfz-approval');
      box.appendChild(element(this.doc, 'strong', null, 'Codex 需要你的确认'));
      const reply = async (result) => {
        try {
          await bridge.request('/reply', { threadId: this.threadId, id: req.id, result });
          box.remove();
          this.requestSignature = '';
        } catch (e) {
          this.statusText(e.message, true);
        }
      };
      const actions = element(this.doc, 'div', 'cfz-actions');
      if (/(?:commandExecution|fileChange)\/requestApproval$/.test(req.method)) {
        box.appendChild(
          element(
            this.doc,
            'pre',
            null,
            p.command || p.reason || p.grantRoot || 'Codex 请求执行此操作',
          ),
        );
        actions.append(
          button(this.doc, '允许', 'cfz-send', () => reply({ decision: 'accept' })),
          button(this.doc, '拒绝', 'cfz-small', () => reply({ decision: 'decline' })),
          button(this.doc, '取消本轮', 'cfz-small', () => reply({ decision: 'cancel' })),
        );
      } else if (/(?:item\/tool|tool)\/requestUserInput$/.test(req.method)) {
        const fields = [];
        for (const q of p.questions || []) {
          const field = element(this.doc, 'fieldset');
          field.appendChild(element(this.doc, 'legend', null, q.question || q.header));
          const inputs = [];
          for (const [i, o] of (q.options || []).entries()) {
            const label = element(this.doc, 'label', 'cfz-choice');
            const input = element(this.doc, 'input');
            input.type = 'radio';
            input.name = `${req.id}-${q.id}`;
            input.value = o.label;
            input.checked = i === 0;
            label.append(
              input,
              element(
                this.doc,
                'span',
                null,
                o.label + (o.description ? ' — ' + o.description : ''),
              ),
            );
            field.appendChild(label);
            inputs.push(input);
          }
          const free = element(this.doc, 'input', 'cfz-free');
          free.type = q.isSecret ? 'password' : 'text';
          free.placeholder = '或输入你的回答';
          field.appendChild(free);
          box.appendChild(field);
          fields.push({ q, inputs, free });
        }
        actions.appendChild(
          button(this.doc, '提交回答', 'cfz-send', () =>
            reply({
              answers: Object.fromEntries(
                fields.map(({ q, inputs, free }) => [
                  q.id,
                  { answers: [free.value || inputs.find((i) => i.checked)?.value || ''] },
                ]),
              ),
            }),
          ),
        );
      } else if (req.method === 'item/permissions/requestApproval') {
        box.appendChild(element(this.doc, 'p', null, p.reason || 'Codex 请求临时权限'));
        box.appendChild(element(this.doc, 'pre', null, JSON.stringify(p.permissions, null, 2)));
        actions.append(
          button(this.doc, '允许本轮', 'cfz-send', () =>
            reply({ permissions: p.permissions, scope: 'turn' }),
          ),
          button(this.doc, '拒绝', 'cfz-small', () => reply({ permissions: {}, scope: 'turn' })),
        );
      } else if (req.method === 'mcpServer/elicitation/request') {
        box.appendChild(element(this.doc, 'p', null, p.message || '外部工具请求信息'));
        if (p.mode === 'url') {
          box.appendChild(
            button(this.doc, '打开验证页面', 'cfz-small', () => {
              if (/^https?:\/\//.test(p.url)) Zotero.launchURL(p.url);
            }),
          );
          actions.appendChild(
            button(this.doc, '已完成验证', 'cfz-send', () =>
              reply({ action: 'accept', content: null }),
            ),
          );
        } else {
          const fields = [];
          for (const [key, s] of Object.entries(p.requestedSchema?.properties || {})) {
            const label = element(this.doc, 'label', 'cfz-choice', s.title || key);
            let input;
            if (s.enum) {
              input = element(this.doc, 'select');
              for (const v of s.enum) input.appendChild(this.option(String(v), String(v)));
            } else {
              input = element(this.doc, 'input', 'cfz-free');
              input.type =
                s.type === 'boolean'
                  ? 'checkbox'
                  : s.type === 'number' || s.type === 'integer'
                    ? 'number'
                    : 'text';
            }
            label.appendChild(input);
            box.appendChild(label);
            fields.push({ key, s, input });
          }
          actions.appendChild(
            button(this.doc, '提交', 'cfz-send', () =>
              reply({
                action: 'accept',
                content: Object.fromEntries(
                  fields.map(({ key, s, input }) => [
                    key,
                    s.type === 'boolean'
                      ? input.checked
                      : ['number', 'integer'].includes(s.type)
                        ? Number(input.value)
                        : input.value,
                  ]),
                ),
              }),
            ),
          );
        }
        actions.appendChild(
          button(this.doc, '拒绝', 'cfz-small', () => reply({ action: 'decline', content: null })),
        );
      } else {
        box.appendChild(
          element(
            this.doc,
            'p',
            null,
            '这个 Codex 交互暂不受侧栏支持。可停止本轮，在 Codex 中继续。',
          ),
        );
        actions.appendChild(button(this.doc, '停止本轮', 'cfz-small', () => this.stop()));
      }
      box.appendChild(actions);
      this.requests.appendChild(box);
    }
  }
  async settings() {
    for (const [name, label, defaultValue] of [
      [
        'projectRoot',
        '论文会话保存到哪个 Codex 项目目录？',
        PathUtils.join(home, 'Documents', 'ChatGPT', 'paper reading'),
      ],
      [
        'codexPath',
        '本地 Codex 可执行文件路径',
        bridge.codexPath ||
          '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      ],
      ['nodePath', 'Node.js 可执行文件路径', bridge.nodePath || '/opt/homebrew/bin/node'],
    ]) {
      const value = { value: preference(name, defaultValue) };
      if (!Services.prompt.prompt(this.win, 'Codex for Zotero', label, value, null, {})) return;
      if (!value.value.startsWith('/')) {
        this.statusText('请填写绝对路径', true);
        return;
      }
      Zotero.Prefs.set(`extensions.codex-for-zotero.${name}`, value.value, true);
    }
    await bridge.stop();
    await this.setItem(this.currentItem);
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.win.clearTimeout(this.timer);
    this.win.cancelAnimationFrame(this.frame);
    this.win.removeEventListener('resize', this.layout);
    this.resizeObserver?.disconnect();
    this.section.removeEventListener('wheel', this.onWheel, true);
    this.section.classList.remove('cfz-section');
    this.root.remove();
  }
}

export async function startup() {
  annotationBridge = new AnnotationBridge({
    Zotero,
    IOUtils,
    PathUtils,
    Services,
    Cc,
    Ci,
    home,
    pluginVersion,
  });
  await annotationBridge.start();
  Zotero.CodexForZotero = { version: pluginVersion, bridge, panels: PANELS, annotationBridge };
  for (const win of Zotero.getMainWindows()) windowLoad(win);
  const id = Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID,
    header: {
      l10nID: 'codex-for-zotero-header',
      icon: 'chrome://codex-for-zotero/content/logo.svg',
    },
    sidenav: {
      l10nID: 'codex-for-zotero-sidenav',
      icon: 'chrome://codex-for-zotero/content/logo.svg',
    },
    sectionButtons: [
      {
        type: 'codex-options',
        icon: 'chrome://codex-for-zotero/content/menu.svg',
        l10nID: 'codex-for-zotero-menu',
        onClick: ({ body }) => PANELS.get(body)?.toggleMenu(),
      },
    ],
    onInit: ({ doc }) => installDocument(doc),
    onItemChange: ({ item, setEnabled }) =>
      setEnabled(!!item && (item.isRegularItem() || item.isPDFAttachment?.())),
    onRender: ({ body, doc, item }) => {
      let panel = PANELS.get(body);
      if (!panel) {
        panel = new ChatPanel(body, doc);
        PANELS.set(body, panel);
      }
      panel.currentItem = item;
    },
    onAsyncRender: async ({ body, item }) => {
      const p = PANELS.get(body);
      if (p) await p.setItem(item);
    },
    onDestroy: ({ body }) => {
      PANELS.get(body)?.dispose();
      PANELS.delete(body);
    },
  });
  if (!id) throw new Error('Codex 侧栏注册失败');
  registeredPaneID = id;
}
export function windowLoad(window) {
  installDocument(window.document);
}
export function windowUnload(window) {
  for (const [body, p] of PANELS)
    if (p.win === window) {
      p.dispose();
      PANELS.delete(body);
    }
}
export async function shutdown() {
  if (registeredPaneID) Zotero.ItemPaneManager.unregisterSection(registeredPaneID);
  for (const p of PANELS.values()) p.dispose();
  PANELS.clear();
  for (const doc of documents) {
    doc.getElementById('codex-for-zotero-style')?.remove();
    doc.l10n?.removeResourceIds(['chrome://codex-for-zotero/locale/codex-for-zotero.ftl']);
  }
  documents.clear();
  await annotationBridge?.stop();
  await bridge.stop();
  delete Zotero.CodexForZotero;
}
