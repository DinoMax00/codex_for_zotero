// Classify media before constructing DOM. Never turn arbitrary reply HTML into a player.
export function mediaReference(source, label = '', imageSyntax = false) {
  if (typeof source !== 'string' || /[\x00-\x1f]/.test(source)) return null;
  let value = source.trim(),
    remote = false;
  if (/^sandbox:\//.test(value)) value = value.slice(8);
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host !== 'localhost') return null;
      value = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost') ||
        url.hostname.startsWith('0.') ||
        /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname) ||
        url.hostname.startsWith('[')
      )
        return null;
      remote = true;
    } catch {
      return null;
    }
  } else if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(value)) return null;
  const pathname = remote ? new URL(value).pathname : value;
  if (/\.(?:svgz?|html?|xhtml|xml|js)$/i.test(pathname)) return null;
  const kind = /\.(?:mp4|m4v|webm|mov)$/i.test(pathname)
    ? 'video'
    : /\.(?:png|jpe?g|gif|webp)$/i.test(pathname) || (remote && imageSyntax)
      ? 'image'
      : null;
  if (!kind) return null;
  return {
    source: value,
    kind,
    remote,
    label: String(label || (kind === 'video' ? '视频' : '图片')).slice(0, 200),
  };
}
export function userImages(item) {
  return (item.content || [])
    .filter((c) => c.type === 'localImage' || c.type === 'image')
    .map((c) => {
      if (c.type === 'localImage') return mediaReference(c.path, '已发送图片', true);
      if (
        typeof c.url === 'string' &&
        /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(c.url) &&
        c.url.length <= 28 * 1024 * 1024
      )
        return { source: c.url, kind: 'image', inline: true, label: '已发送图片' };
      return mediaReference(c.url, '已发送图片', true);
    })
    .filter(Boolean);
}
