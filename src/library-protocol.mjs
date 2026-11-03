export const LIBRARY_ROUTE = '/codex-for-zotero/library';
export function doiOf(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}
export function arxivOf(value) {
  const text = String(value || '').trim(),
    id = '((?:\\d{4}\\.\\d{4,5}|[a-z.-]+/\\d{7}))';
  const match =
    text.match(new RegExp('arxiv(?:\\s*:\\s*|\\.org/(?:abs|pdf)/)' + id + '(?:v\\d+)?', 'i')) ||
    text.match(new RegExp('^' + id + '(?:v\\d+)?(?:\\.pdf)?$', 'i'));
  return match ? match[1].toLowerCase() : '';
}
export function titleOf(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function collectionPath(value) {
  const parts = typeof value === 'string' ? value.split('/') : value;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.length > 20 ||
    parts.some(
      (p) =>
        typeof p !== 'string' ||
        !p.trim() ||
        p.trim().length > 200 ||
        ['.', '..'].includes(p.trim()),
    )
  )
    throw new Error('请提供明确的分类路径，例如 robotics/whole body');
  return parts.map((p) => p.trim().normalize('NFC'));
}
export function duplicateCandidates(record, items) {
  const doi = doiOf(record.DOI),
    arxiv = arxivOf(`${record.url || ''} ${record.extra || ''} ${record.archiveID || ''}`),
    title = titleOf(record.title);
  const strong = [],
    sameTitle = [];
  for (const item of items) {
    const otherDOI = doiOf(item.DOI),
      otherArxiv = arxivOf(`${item.url || ''} ${item.extra || ''} ${item.archiveID || ''}`);
    if ((doi && doi === otherDOI) || (arxiv && arxiv === otherArxiv)) {
      strong.push(item);
      continue;
    }
    if (title && title === titleOf(item.title)) sameTitle.push(item);
  }
  if (strong.length) return { matches: strong, conflicts: [] };
  const conflicts = sameTitle.filter((i) => doi && doiOf(i.DOI) && doi !== doiOf(i.DOI));
  return { matches: sameTitle.filter((i) => !conflicts.includes(i)), conflicts };
}
