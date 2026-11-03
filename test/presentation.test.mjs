import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownWithMath, visibleTurnItems, parseFileCitation } from '../src/presentation.mjs';

test('math survives Markdown, supports Chinese labels, and leaves code/currency untouched', () => {
  const rendered = markdownWithMath(
    '内联 \\(s_t\\)，\\[\\underbrace{\\text{未来 32 步奖励}}_{\\text{模型推演}} + \\xi\\]，$x^2$。\n\n`$not_math$`\n\n```tex\n\\[not_rendered\\]\n```\n\n价格 $20 和 $30。',
  );
  assert.equal(rendered.formulae.length, 3);
  assert.ok(rendered.formulae.every((f) => f.markup.includes('<math')));
  assert.match(rendered.formulae[1].markup, /<munder>/);
  assert.match(rendered.formulae[1].markup, /未来 32 步奖励/);
  assert.match(rendered.html, /<code>\$not_math\$<\/code>/);
  assert.match(rendered.html, /not_rendered/);
  assert.match(rendered.html, /价格 \$20 和 \$30/);
});
test('finished answers exclude summaries, commentary and tool work; streaming may show summaries', () => {
  const items = [
    { id: 'u', type: 'userMessage' },
    { id: 'r', type: 'reasoning', summary: ['summary'], content: ['raw'] },
    { id: 'c', type: 'agentMessage', phase: 'commentary' },
    { id: 'p', type: 'agentMessage', phase: 'partial_answer' },
    { id: 'a', type: 'agentMessage', phase: 'final_answer' },
    { id: 'cmd', type: 'commandExecution' },
  ];
  assert.deepEqual(
    visibleTurnItems({ status: 'completed', items }).map((i) => i.id),
    ['u', 'p', 'a'],
  );
  assert.deepEqual(
    visibleTurnItems({ status: 'inProgress', items }).map((i) => i.id),
    ['u', 'r', 'c', 'p', 'a'],
  );
  assert.deepEqual(
    visibleTurnItems({
      status: 'completed',
      items: [
        { id: 'a', type: 'agentMessage' },
        { id: 'b', type: 'agentMessage' },
      ],
    }).map((i) => i.id),
    ['b'],
  );
});

test('native PDF citations hide raw directives and paths without breaking surrounding math', () => {
  const path = '/Users/example/Papers/zotero-papers/1-ABCDEFGH/session/Example paper.pdf';
  const raw = `:codex-file-citation{path=${JSON.stringify(path)} purpose="source"}`;
  const result = markdownWithMath(`对应原文 §3.3、公式 (2)(3)：${raw}。变量 \\(s_t\\)。`);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].path, path);
  assert.equal(result.citations[0].valid, true);
  assert.doesNotMatch(result.html, /codex-file-citation|\/Users\//);
  assert.match(result.html, /对应原文 §3.3/);
  assert.equal(result.formulae.length, 1);
});
test('citation syntax inside code remains literal while actual citations render', () => {
  const raw = ':codex-file-citation{path="/tmp/paper.pdf" purpose="source"}';
  const result = markdownWithMath('`' + raw + '`\n\n```text\n' + raw + '\n```\n\n' + raw);
  assert.equal(result.citations.length, 1);
  assert.match(result.html, /<code>/);
  assert.equal((result.html.match(/codex-file-citation/g) || []).length, 2);
});
test('streaming partial file citations never expose local paths', () => {
  const prefix = ':codex-file-citation{';
  const suffix = 'path="/Users/example/paper reading/论文.pdf" purpose="source"}';
  for (let i = 0; i < suffix.length; i++) {
    const result = markdownWithMath('来源：' + prefix + suffix.slice(0, i));
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].pending, true);
    assert.doesNotMatch(result.html, /codex-file-citation|\/Users/);
  }
  assert.equal(markdownWithMath(prefix + suffix).citations[0].valid, true);
});
test('citation targets reject executable schemes and unsafe file types; optional page remains explicit', () => {
  for (const path of [
    'javascript:alert(1)',
    'https://example.test/paper.pdf',
    '//remote/paper.pdf',
    '/tmp/program.command',
    'relative/paper.pdf',
    '/tmp/paper\n.pdf',
  ])
    assert.equal(
      parseFileCitation(`:codex-file-citation{path=${JSON.stringify(path)}}`).valid,
      false,
    );
  assert.equal(parseFileCitation(':codex-file-citation{path="/tmp/paper.pdf#page=3"}').page, 3);
  assert.equal(
    parseFileCitation(':codex-file-citation{path="/tmp/paper.pdf" page_number="4"}').page,
    4,
  );
  assert.equal(parseFileCitation(':codex-file-citation{path="/tmp/paper.pdf"}').page, undefined);
});
test('quoted braces and HTML-like characters in filenames never enter the HTML renderer', () => {
  const path = '/tmp/quoted } <img onerror=bad> "name".pdf';
  const result = markdownWithMath(
    `来源：:codex-file-citation{path=${JSON.stringify(path)} purpose="source"}`,
  );
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].path, path);
  assert.doesNotMatch(result.html, /<img|onerror|quoted/);
});
