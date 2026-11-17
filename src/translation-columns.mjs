const NS = 'http://www.w3.org/1999/xhtml';
const DIVIDER_WIDTH = 7;
const MIN_WIDTHS = [225, 225, 290];

function minimums(total, count = 3) {
  const widths = MIN_WIDTHS.slice(0, count);
  const breakpoint = widths.reduce((sum, width) => sum + width, 0);
  return widths.map((width) => width * Math.min(1, total / breakpoint));
}

function fitWidths(total, ratios) {
  const min = minimums(total);
  const widths = ratios.map((ratio) => total * ratio);
  let deficit = 0;
  let available = 0;
  for (let i = 0; i < widths.length; i++) {
    deficit += Math.max(0, min[i] - widths[i]);
    available += Math.max(0, widths[i] - min[i]);
  }
  return widths.map((width, i) =>
    available
      ? Math.max(min[i], width - (deficit * Math.max(0, width - min[i])) / available)
      : min[i],
  );
}

export class TranslationColumns {
  constructor({ doc, reader, panel, load, save, resized }) {
    this.win = doc.defaultView;
    this.original = reader._iframe;
    this.nativeFlex = this.original.getAttribute('flex');
    this.original.removeAttribute('flex');
    this.tab = this.original.parentNode;
    this.panel = panel;
    this.context = doc.getElementById('zotero-context-pane');
    this.nativeSplitter = doc.getElementById('zotero-context-splitter');
    this.row = this.context?.parentElement;
    this.deck = this.tab.parentElement;
    this.load = load;
    this.save = save;
    this.resized = resized;
    const left = this.divider(doc, 0, '调整原文与译文宽度');
    const right = this.divider(doc, 1, '调整译文与对话宽度');
    this.handles = [left, right];
    this.tab.insertBefore(left, panel);
    this.tab.insertBefore(right, panel.nextSibling);
    this.resize = new this.win.ResizeObserver(() => this.refresh());
    this.resize.observe(this.deck);
    if (this.row) this.resize.observe(this.row);
    if (this.context) {
      this.changes = new this.win.MutationObserver(() => this.refresh());
      this.changes.observe(this.context, {
        attributes: true,
        attributeFilter: ['class', 'collapsed'],
      });
    }
    this.refresh();
  }
  divider(doc, index, label) {
    const node = doc.createElementNS(NS, 'div');
    node.className = 'cfz-column-divider';
    node.tabIndex = 0;
    node.title = label;
    node.setAttribute('role', 'separator');
    node.setAttribute('aria-label', label);
    node.setAttribute('aria-orientation', 'vertical');
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.drag || !this.selected) return;
      event.preventDefault();
      node.focus({ preventScroll: true });
      node.setPointerCapture(event.pointerId);
      this.drag = { index, pointer: event.pointerId, x: event.clientX, widths: this.measure() };
      this.tab.classList.add('cfz-columns-dragging');
      node.classList.add('active');
    });
    node.addEventListener('pointermove', (event) => {
      if (this.drag?.pointer !== event.pointerId) return;
      this.drag.changed =
        this.move(index, event.clientX - this.drag.x, this.drag.widths) || this.drag.changed;
    });
    const finish = (event) => {
      if (this.drag?.pointer === event.pointerId) this.finish();
    };
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
    node.addEventListener('lostpointercapture', finish);
    node.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const changed = this.move(
        index,
        (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10),
        this.measure(),
      );
      if (changed) this.save(this.ratios);
      this.resized();
    });
    return node;
  }
  measure() {
    const panes = [this.original, this.panel];
    if (this.three) panes.push(this.context);
    return panes.map((pane) => pane.getBoundingClientRect().width);
  }
  move(index, delta, initial) {
    if (initial.length <= index + 1) return false;
    const total = initial.reduce((sum, width) => sum + width, 0);
    if (total <= 0) return false;
    const min = minimums(total, initial.length);
    const widths = [...initial];
    const shift = Math.max(
      min[index] - widths[index],
      Math.min(widths[index + 1] - min[index + 1], delta),
    );
    widths[index] += shift;
    widths[index + 1] -= shift;
    if (this.three) {
      this.ratios = widths.map((width) => width / total);
    } else {
      const pdfShare = this.ratios[0] + this.ratios[1];
      const left = (widths[0] / total) * pdfShare;
      this.ratios = [left, pdfShare - left, this.ratios[2]];
    }
    this.apply(widths);
    return true;
  }
  apply(widths) {
    this.tab.style.setProperty('--cfz-original-width', `${widths[0]}px`);
    if (this.three) this.context.style.setProperty('--cfz-chat-width', `${widths[2]}px`);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const min = minimums(total, widths.length);
    let before = 0;
    for (let i = 0; i < widths.length - 1; i++) {
      const pair = widths[i] + widths[i + 1];
      const percent = (value) => Math.round((value / total) * 100);
      const handle = this.handles[i];
      handle.setAttribute('aria-valuemin', percent(before + min[i]));
      handle.setAttribute('aria-valuemax', percent(before + pair - min[i + 1]));
      before += widths[i];
      handle.setAttribute('aria-valuenow', percent(before));
    }
  }
  refresh() {
    const selected = this.win.Zotero_Tabs?.selectedID === this.tab.id;
    const three =
      selected &&
      this.context &&
      this.nativeSplitter &&
      this.row &&
      !this.context.classList.contains('stacked') &&
      this.context.getAttribute('collapsed') !== 'true';
    if (selected && !this.selected) {
      const saved = this.load();
      const contextWidth = three ? this.context.getBoundingClientRect().width : 0;
      const total = this.tab.clientWidth + contextWidth;
      const chat = total && contextWidth ? contextWidth / total : 0.26;
      this.ratios = saved || [(1 - chat) / 2, (1 - chat) / 2, chat];
    }
    this.selected = selected;
    const wasThree = this.three;
    this.three = !!three;
    if (!this.three && this.context?.dataset.cfzColumnOwner === this.tab.id) {
      this.context.classList.remove('cfz-sized-chat');
      delete this.context.dataset.cfzColumnOwner;
      this.context.style.removeProperty('--cfz-chat-width');
      this.nativeSplitter.classList.remove('cfz-replaced-splitter');
    }
    this.handles[1].hidden = !this.three;
    if (!selected || wasThree !== this.three) this.finish();
    if (!selected || this.drag) return;
    if (this.three) {
      if (this.context.dataset.cfzColumnOwner !== this.tab.id) {
        this.context.dataset.cfzColumnOwner = this.tab.id;
      }
      if (!this.context.classList.contains('cfz-sized-chat')) {
        this.context.classList.add('cfz-sized-chat');
        this.nativeSplitter.classList.add('cfz-replaced-splitter');
      }
      const total = this.row.clientWidth - 2 * DIVIDER_WIDTH;
      if (total > 0) this.apply(fitWidths(total, this.ratios));
    } else {
      const total = this.tab.clientWidth - DIVIDER_WIDTH;
      const share = this.ratios[0] / (this.ratios[0] + this.ratios[1]);
      const min = Math.min(MIN_WIDTHS[0], total / 2);
      if (total > 0) {
        const left = Math.min(total - min, Math.max(min, share * total));
        this.apply([left, total - left]);
      }
    }
  }
  finish() {
    if (!this.drag) return;
    const { index, pointer, changed } = this.drag;
    this.drag = null;
    const node = this.handles[index];
    if (node.hasPointerCapture(pointer)) node.releasePointerCapture(pointer);
    this.tab.classList.remove('cfz-columns-dragging');
    node.classList.remove('active');
    if (changed) this.save(this.ratios);
    this.resized();
  }
  close() {
    this.finish();
    this.resize.disconnect();
    this.changes?.disconnect();
    if (this.context?.dataset.cfzColumnOwner === this.tab.id) {
      this.context.classList.remove('cfz-sized-chat');
      delete this.context.dataset.cfzColumnOwner;
      this.context.style.removeProperty('--cfz-chat-width');
      this.nativeSplitter.classList.remove('cfz-replaced-splitter');
    }
    this.tab.style.removeProperty('--cfz-original-width');
    if (this.nativeFlex !== null) this.original.setAttribute('flex', this.nativeFlex);
    for (const handle of this.handles) handle.remove();
  }
}
