const NS = 'http://www.w3.org/1999/xhtml';
const VIEWER_URL = 'resource://zotero/reader/pdf/web/viewer.html';
const wait = (win, ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
const clamp = (n) => Math.min(1, Math.max(0, n));
function el(doc, name, className, text) {
  const node = doc.createElementNS(NS, name);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Main pages retain the original geometry. Overflow pages point to a specific source paragraph.
export function translateLocation(location, map, fromTranslation) {
  if (fromTranslation) {
    const entry = map.pages[location.page];
    if (!entry) return null;
    return entry.supplement
      ? { page: entry.source, x: entry.x, y: entry.y }
      : { ...location, page: entry.source };
  }
  return location.page < map.sourcePages ? location : null;
}

function pdfSurface(app) {
  const viewer = app.pdfViewer;
  const scroll = viewer.container;
  const pageRect = (index) => viewer.getPageView(index)?.div.getBoundingClientRect();
  return {
    scroll,
    location() {
      const visiblePages = [...viewer._getVisiblePages().views].sort((a, b) => a.id - b.id);
      const box = scroll.getBoundingClientRect();
      // Anchor a little below the top edge, avoiding inter-page gutters.
      const y = box.top + 24;
      const x = box.left + Math.min(36, box.width / 4);
      const page =
        visiblePages.find(({ id }) => pageRect(id - 1)?.bottom >= y) || visiblePages.at(-1);
      if (!page) return null;
      const rect = pageRect(page.id - 1);
      if (!rect?.height || !rect.width) return null;
      return {
        page: page.id - 1,
        x: clamp((x - rect.left) / rect.width),
        y: clamp((y - rect.top) / rect.height),
      };
    },
    move(location, moveX) {
      let rect = pageRect(location.page);
      if (!rect?.height) {
        viewer.currentPageNumber = location.page + 1;
        rect = pageRect(location.page);
      }
      if (!rect?.height) return;
      const box = scroll.getBoundingClientRect();
      const top = scroll.scrollTop + rect.top - box.top + rect.height * location.y - 24;
      const left = moveX
        ? scroll.scrollLeft +
          rect.left -
          box.left +
          rect.width * location.x -
          Math.min(36, box.width / 4)
        : scroll.scrollLeft;
      // Assign primitives: option dictionaries from the host scope are not
      // recognized by Gecko's cross-compartment DOM scrollTo binding.
      scroll.scrollTop = top;
      if (moveX) scroll.scrollLeft = left;
    },
  };
}

function syncScrolling(win, original, translated, map, enabled, pageChanged) {
  const sides = [original, translated];
  let frame = 0,
    side = 0;
  const ignore = [null, null];
  const listeners = [];
  const scrollFrom = (index) => {
    pageChanged();
    if (!enabled()) return;
    const current = sides[index].scroll;
    const ignored = ignore[index];
    ignore[index] = null;
    if (
      ignored &&
      Math.abs(current.scrollTop - ignored.top) < 1.5 &&
      Math.abs(current.scrollLeft - ignored.left) < 1.5
    )
      return;
    side = index;
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (!enabled()) return;
      const origin = sides[side].location();
      if (!origin) return;
      const target = translateLocation(origin, map, side === 1);
      if (!target) return;
      const destination = sides[1 - side];
      destination.move(target, side === 1 && !!map.pages[origin.page]?.supplement);
      ignore[1 - side] = { top: destination.scroll.scrollTop, left: destination.scroll.scrollLeft };
      pageChanged();
    });
  };
  for (const [i, entry] of sides.entries()) {
    const listener = () => scrollFrom(i);
    entry.scroll.addEventListener('scroll', listener, { passive: true });
    listeners.push(() => entry.scroll.removeEventListener('scroll', listener));
  }
  scrollFrom(0);
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    for (const remove of listeners) remove();
  };
}

export class TranslationView {
  constructor({ reader, paper, bridge, doc, io, cu, onClose, exportFile }) {
    Object.assign(this, { reader, paper, bridge, doc, io, cu, onClose, exportFile });
    this.win = doc.defaultView;
    this.closed = false;
    this.serial = 0;
    this.sync = true;
    const panel = (this.panel = el(doc, 'section', 'cfz-translation'));
    panel.setAttribute('aria-label', '中文译文');
    const bar = el(doc, 'header', 'cfz-translation-bar');
    this.label = el(doc, 'span', 'cfz-translation-page');
    bar.append(el(doc, 'strong', '', '中文译文'), this.label);
    this.syncButton = this.button('联动', () => {
      this.sync = !this.sync;
      this.syncButton.setAttribute('aria-pressed', String(this.sync));
      this.syncButton.textContent = this.sync ? '联动' : '独立滚动';
    });
    this.syncButton.setAttribute('aria-pressed', 'true');
    this.syncButton.title = '切换两份 PDF 的滚动联动';
    this.saveButton = this.button('另存 PDF', async () => {
      try {
        await this.exportFile(this.result.path);
      } catch (error) {
        this.win.alert(error.message);
      }
    });
    this.closeButton = this.button('×', () => this.close());
    this.closeButton.setAttribute('aria-label', '关闭译文列');
    bar.append(this.syncButton, this.saveButton, this.closeButton);
    this.syncButton.hidden = this.saveButton.hidden = true;
    this.placeholder = el(doc, 'div', 'cfz-translation-empty');
    this.status = el(doc, 'div', 'cfz-translation-status');
    this.status.setAttribute('role', 'status');
    this.generate = this.button('生成中文 PDF', () => this.start());
    this.cancelButton = this.button('取消', () => this.cancel());
    this.cancelButton.hidden = true;
    this.placeholder.append(this.status, this.generate, this.cancelButton);
    panel.append(bar, this.placeholder);
    reader._iframe.parentNode.insertBefore(panel, reader._iframe.nextSibling);
    reader._iframe.parentNode.classList.add('cfz-translation-tab');
  }
  button(label, action) {
    const button = el(this.doc, 'button', '', label);
    button.type = 'button';
    button.addEventListener('click', () =>
      Promise.resolve()
        .then(action)
        .catch((error) => this.fail(error)),
    );
    return button;
  }
  async open() {
    await this.action('/translation/lookup');
  }
  async start() {
    await this.action('/translation/start');
  }
  async action(route) {
    const serial = ++this.serial;
    this.generate.hidden = true;
    this.status.textContent = '正在检查 PDF…';
    try {
      const result = await this.bridge.request(route, { paper: this.paper });
      if (!this.closed && serial === this.serial) await this.update(result, serial);
    } catch (error) {
      if (!this.closed && serial === this.serial) this.fail(error);
    }
  }
  async cancel() {
    if (!this.result?.id) return;
    this.cancelButton.disabled = true;
    await this.bridge.request('/translation/cancel', { id: this.result.id });
  }
  async update(result, serial) {
    this.result = result;
    if (result.state === 'complete') {
      this.cancelButton.hidden = true;
      this.status.textContent = '正在打开中文 PDF…';
      await this.showPDF(result, serial);
      return;
    }
    this.status.textContent = {
      missing: 'GPT-6-Luna · 简体中文',
      extracting: '正在提取原文…',
      translating: `GPT-6-Luna 翻译中 · ${result.done}/${result.total} 批`,
      rendering: '正在排版并生成 PDF…',
      cancelled: '已取消，完成的译段已保存。',
      failed: result.error || '翻译失败',
    }[result.state];
    const running = ['extracting', 'translating', 'rendering'].includes(result.state);
    this.generate.textContent =
      result.state === 'cancelled' || result.state === 'failed' ? '继续翻译' : '生成中文 PDF';
    this.generate.hidden = running;
    this.cancelButton.hidden = !running;
    if (!running) this.cancelButton.disabled = false;
    if (running) {
      this.timer = this.win.setTimeout(async () => {
        try {
          const next = await this.bridge.request('/translation/status', { id: result.id });
          if (!this.closed && serial === this.serial) await this.update(next, serial);
        } catch (error) {
          if (!this.closed && serial === this.serial) this.fail(error);
        }
      }, 900);
    }
  }
  fail(error) {
    if (this.closed) return;
    this.stopSync?.();
    this.frame?.remove();
    this.frame = null;
    this.placeholder.hidden = false;
    this.generate.hidden = false;
    this.generate.textContent = '重试';
    this.cancelButton.hidden = this.syncButton.hidden = this.saveButton.hidden = true;
    this.status.textContent = error?.message || '无法打开译文';
  }
  async showPDF(result, serial) {
    const data = await this.io.read(result.path);
    if (this.closed || serial !== this.serial) return;
    this.frame = this.doc.createXULElement('browser');
    this.frame.classList.add('cfz-translation-browser');
    this.frame.setAttribute('type', 'content');
    this.frame.setAttribute('src', VIEWER_URL);
    this.panel.append(this.frame);
    let app, source;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.closed || serial !== this.serial) return;
      const win = this.frame.contentWindow?.wrappedJSObject;
      app = win?.PDFViewerApplication;
      source = this.reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication;
      if (app && source?.pdfDocument) break;
      await wait(this.win, 100);
    }
    if (!app || !source?.pdfDocument)
      throw new Error('当前 Zotero 阅读器未就绪，请关闭译文列后重试');
    const content = this.frame.contentWindow;
    const inner = content.wrappedJSObject;
    for (const [key, value] of Object.entries({
      isEvalSupported: false,
      enableScripting: false,
      enableXfa: false,
      defaultUrl: '',
      disableHistory: true,
      disablePreferences: true,
      sidebarViewOnLoad: 0,
      annotationEditorMode: -1,
      textLayerMode: 1,
      defaultZoomValue: 'page-width',
    }))
      inner.PDFViewerApplicationOptions.set(key, value);
    await app.initializedPromise;
    if (this.closed || serial !== this.serial) return;
    const style = inner.document.createElement('style');
    style.textContent =
      '.toolbar,#sidebarContainer{display:none!important} #viewerContainer{inset:0!important}';
    inner.document.head.appendChild(style);
    await app.open(this.cu.cloneInto({ data }, content));
    if (this.closed || serial !== this.serial) return;
    await app.pdfViewer.pagesPromise;
    if (this.closed || serial !== this.serial) return;
    this.placeholder.hidden = true;
    this.saveButton.hidden = this.syncButton.hidden = false;
    app.pdfViewer.currentScaleValue = 'page-width';
    this.originalViewer = source.pdfViewer;
    this.originalSettings = {
      zoom: source.pdfViewer.currentScaleValue,
      scroll: source.pdfViewer.scrollMode,
      spread: source.pdfViewer.spreadMode,
    };
    const original = pdfSurface(source);
    const translated = pdfSurface(app);
    const initialLocation = original.location();
    source.pdfViewer.scrollMode = 0;
    source.pdfViewer.spreadMode = 0;
    source.pdfViewer.currentScaleValue = 'page-width';
    if (initialLocation) original.move(initialLocation, false);
    const pageChanged = () => {
      const page = translated.location()?.page;
      if (Number.isInteger(page)) {
        const entry = result.pages[page];
        this.label.textContent = entry?.supplement
          ? `补译 · 原文第 ${entry.source + 1} 页`
          : `${page + 1} / ${result.pages.length}`;
      }
    };
    this.stopSync = syncScrolling(
      this.win,
      original,
      translated,
      result,
      () => this.sync,
      pageChanged,
    );
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.serial++;
    this.win.clearTimeout(this.timer);
    this.stopSync?.();
    this.panel.parentElement?.classList.remove('cfz-translation-tab');
    this.panel.remove();
    if (this.originalSettings) {
      try {
        const { zoom, scroll, spread } = this.originalSettings;
        if (this.originalViewer.scrollMode === 0) this.originalViewer.scrollMode = scroll;
        if (this.originalViewer.spreadMode === 0) this.originalViewer.spreadMode = spread;
        if (this.originalViewer.currentScaleValue === 'page-width')
          this.originalViewer.currentScaleValue = zoom;
      } catch {}
    }
    this.onClose();
  }
}
