import { mediaReference } from './media-protocol.mjs';
import { Marked } from 'marked';
import katex from 'katex';

// Keep local citation data separate from HTML so Markdown cannot alter a path.
export function parseFileCitation(raw) {
  const attrs = Object.create(null);
  for (const match of raw.matchAll(
    /\b(path|purpose|page|page_number)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*'|[0-9]+)/g,
  )) {
    const value = match[2];
    try {
      attrs[match[1]] = value.startsWith('"')
        ? JSON.parse(value)
        : value.startsWith("'")
          ? value.slice(1, -1)
          : value;
    } catch {
      return { valid: false };
    }
  }
  if (typeof attrs.path !== 'string') return { valid: false };
  const path = attrs.path.match(/^(\/(?!\/)[^\u0000-\u001f]*\.pdf)(?:#page=(\d+))?$/i);
  if (!path) return { valid: false };
  const page = Number(attrs.page || attrs.page_number || path[2]);
  return {
    valid: true,
    path: path[1],
    purpose: attrs.purpose || 'source',
    ...(Number.isInteger(page) && page > 0 && page < 100000 ? { page } : {}),
  };
}

// Protect math and citations before Markdown consumes escapes; leave code literal.
export function markdownWithMath(text) {
  const formulae = [],
    citations = [],
    media = [];
  const pattern =
    /(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?\k<fence>|(?<code>`+)[^\n]*?\k<code>|(?<citation>:codex-file-citation\{(?:[^"'{}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*\})|(?<pending>:codex-file-citation(?:\{[^\n]*)?$)|\\\[(?<bracket>[\s\S]*?)\\\]|\\\((?<paren>[\s\S]*?)\\\)|\$\$(?<double>[\s\S]*?)\$\$|(?<![\\\w])\$(?!\s)(?<single>[^$\n]+?)(?<!\s)\$(?!\d)/g;
  const prefix = `CFZINLINE${Math.random().toString(36).slice(2)}X`;
  const protectedText = String(text).replace(pattern, (match, ...args) => {
    const g = args.at(-1);
    if (g.fence || g.code) return match;
    if (g.citation || g.pending) {
      const token = `${prefix}C${citations.length}END`;
      citations.push({
        token,
        ...(g.pending ? { pending: true, valid: false } : parseFileCitation(g.citation)),
      });
      return token;
    }
    const tex = g.bracket ?? g.paren ?? g.double ?? g.single;
    const display = g.bracket !== undefined || g.double !== undefined;
    const token = `${prefix}M${formulae.length}END`;
    formulae.push({
      token,
      display,
      markup: katex.renderToString(tex, {
        output: 'mathml',
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      }),
    });
    return display ? `\n\n${token}\n\n` : token;
  });
  const embed = (href, label, imageSyntax) => {
    const reference = mediaReference(href, label, imageSyntax);
    if (!reference) return imageSyntax ? '[不支持的图片]' : false;
    const token = `${prefix}V${media.length}END`;
    media.push({ token, ...reference });
    return token;
  };
  const parser = new Marked();
  parser.use({
    renderer: {
      image({ href, text }) {
        return embed(href, text, true);
      },
      link({ href, text }) {
        return embed(href, text, false);
      },
    },
  });
  const html = parser.parse(protectedText, { gfm: true, breaks: false });
  return { html, formulae, citations, media };
}
export function visibleTurnItems(turn) {
  const items = turn.items || [];
  if (turn.status === 'inProgress')
    return items.filter((i) =>
      ['userMessage', 'agentMessage', 'reasoning', 'plan', 'imageGeneration'].includes(i.type),
    );
  const agents = items.filter((i) => i.type === 'agentMessage' && i.phase !== 'commentary');
  const hasFinal = agents.some((i) => i.phase === 'final_answer');
  const last = agents.at(-1)?.id;
  return items.filter(
    (i) =>
      i.type === 'userMessage' ||
      (i.type === 'imageGeneration' && i.status === 'completed') ||
      (i.type === 'agentMessage' &&
        (i.phase === 'final_answer' ||
          i.phase === 'partial_answer' ||
          (!hasFinal && !i.phase && i.id === last))),
  );
}
