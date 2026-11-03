export const ANNOTATION_ROUTE = '/codex-for-zotero/annotations';
export const isInternalTag = (tag) =>
  tag === 'codex-paper-reading' ||
  tag.startsWith('codex-paper-reading:') ||
  /^codex-anchor:[a-f0-9]{16,64}$/i.test(tag);
export function validateAnnotation(item, parentKey) {
  if (
    !item ||
    item.itemType !== 'annotation' ||
    item.annotationType !== 'highlight' ||
    item.parentItem !== parentKey ||
    item.version !== 0 ||
    !/^[A-Z0-9]{8}$/.test(item.key || '')
  )
    throw new Error('只能向指定 PDF 新增高亮批注');
  if (
    typeof item.annotationText !== 'string' ||
    !item.annotationText.trim() ||
    item.annotationText.length > 20000 ||
    typeof item.annotationComment !== 'string' ||
    !item.annotationComment.trim() ||
    item.annotationComment.length > 8000
  )
    throw new Error('批注原文或中文评论无效');
  if (
    !/^#[a-f0-9]{6}$/i.test(item.annotationColor || '') ||
    !/^\d{5}\|\d{6}\|\d{5}$/.test(item.annotationSortIndex || '')
  )
    throw new Error('批注颜色或排序位置无效');
  const position =
    typeof item.annotationPosition === 'string'
      ? JSON.parse(item.annotationPosition)
      : item.annotationPosition;
  if (
    !position ||
    !Number.isInteger(position.pageIndex) ||
    position.pageIndex < 0 ||
    !Array.isArray(position.rects) ||
    !position.rects.length ||
    position.rects.length > 100 ||
    position.rects.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        r.some((n) => !Number.isFinite(n) || Math.abs(n) > 100000) ||
        r[0] >= r[2] ||
        r[1] >= r[3],
    )
  )
    throw new Error('批注坐标无效');
  if (item.codexAnchor && !/^[a-f0-9]{24,64}$/.test(item.codexAnchor))
    throw new Error('批注定位标识无效');
  return {
    key: item.key,
    type: 'highlight',
    authorName: '',
    text: item.annotationText,
    comment: item.annotationComment,
    color: item.annotationColor,
    pageLabel: String(item.annotationPageLabel || position.pageIndex + 1),
    sortIndex: item.annotationSortIndex,
    position,
    tags: [],
  };
}
