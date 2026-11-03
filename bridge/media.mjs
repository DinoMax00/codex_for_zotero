import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function mediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)))
    return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |qt  )$/.test(bytes.toString('ascii', 8, 12))
  )
    return {
      kind: 'video',
      mime: bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4',
      ext: 'mp4',
    };
  if (
    bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    bytes.includes(Buffer.from('webm'))
  )
    return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  throw new Error('不支持的媒体文件，仅支持 PNG、JPEG、GIF、WebP 和 MP4、WebM、MOV 视频');
}
export function byteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid range');
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new Error('Invalid range');
  return { start, end, partial: true };
}
export class MediaStore {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.capabilities = new Map();
  }
  async init() {
    await mkdir(this.projectRoot, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.projectRoot);
    this.imagesDir = path.join(this.root, 'zotero-images');
    await mkdir(this.imagesDir, { recursive: true, mode: 0o700 });
    if ((await realpath(this.imagesDir)) !== this.imagesDir)
      throw new Error('图片目录不能是符号链接');
  }
  async file(source) {
    if (typeof source !== 'string' || /[\x00-\x1f]/.test(source)) throw new Error('无效的媒体路径');
    const filename = await realpath(path.resolve(this.root, source));
    const relative = path.relative(this.root, filename);
    if (
      !relative ||
      relative.startsWith('..' + path.sep) ||
      relative === '..' ||
      path.isAbsolute(relative)
    )
      throw new Error('仅展示 paper reading 工作目录内的媒体，请让 Codex 将文件保存到该目录');
    // Open without following a final symlink; recheck the opened descriptor below.
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const resolved = await realpath(filename);
      const stats = await handle.stat();
      const check = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await check.stat();
        if (resolved !== filename || current.ino !== stats.ino || current.dev !== stats.dev)
          throw new Error('媒体文件已变化');
      } finally {
        await check.close();
      }
      if (!stats.isFile() || !stats.size) throw new Error('媒体文件不可用');
      const prefix = Buffer.alloc(64);
      await handle.read(prefix, 0, 64, 0);
      return { handle, stats, filename, ...mediaType(prefix) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async register(source) {
    const file = await this.file(source);
    await file.handle.close();
    const now = Date.now();
    for (const [key, value] of this.capabilities)
      if (value.expires < now) this.capabilities.delete(key);
    if (this.capabilities.size >= 2048)
      this.capabilities.delete(this.capabilities.keys().next().value);
    const ticket = randomBytes(24).toString('hex');
    this.capabilities.set(ticket, { path: file.filename, expires: now + 24 * 60 * 60 * 1000 });
    return {
      route: '/media/' + ticket,
      kind: file.kind,
      mime: file.mime,
      name: path.basename(file.filename),
    };
  }
  async stage({ source, dataURL, name }) {
    let bytes;
    if (source) {
      // Only the authenticated file picker uses this path. Output reads remain workspace-scoped.
      const handle = await open(source, 'r');
      try {
        const st = await handle.stat();
        if (!st.isFile() || !st.size || st.size > MAX_IMAGE_BYTES)
          throw new Error('每张图片不能超过 20 MB');
        bytes = Buffer.alloc(st.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset !== st.size) throw new Error('图片文件发生变化');
        bytes = bytes.subarray(0, offset);
      } finally {
        await handle.close();
      }
      name = path.basename(source);
    } else {
      if (typeof dataURL !== 'string' || dataURL.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100)
        throw new Error('每张图片不能超过 20 MB');
      const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        dataURL,
      );
      if (!match) throw new Error('粘贴的图片格式不受支持');
      bytes = Buffer.from(match[1], 'base64');
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('每张图片不能超过 20 MB');
    const type = mediaType(bytes);
    if (type.kind !== 'image') throw new Error('只能发送图片附件');
    const id = randomUUID() + '.' + type.ext;
    const filename = path.join(this.imagesDir, id);
    await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(filename, 0o600);
    return {
      id,
      name: String(name || '图片').slice(0, 200),
      path: filename,
      ...(await this.register(filename)),
    };
  }
  async inputs(ids = []) {
    if (!Array.isArray(ids) || ids.length > 8) throw new Error('每条消息最多 8 张图片');
    const result = [];
    let total = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}\.(?:png|jpg|gif|webp)$/.test(id))
        throw new Error('图片附件标识无效');
      const file = await this.file(path.join(this.imagesDir, id));
      try {
        if (file.kind !== 'image' || file.stats.size > MAX_IMAGE_BYTES)
          throw new Error('图片附件无效');
        total += file.stats.size;
        if (total > 50 * 1024 * 1024) throw new Error('一条消息的图片合计不能超过 50 MB');
        result.push({ type: 'localImage', path: file.filename });
      } finally {
        await file.handle.close();
      }
    }
    return result;
  }
  async serve(ticket, req, res) {
    const grant = this.capabilities.get(ticket);
    if (!grant || grant.expires < Date.now()) {
      res.writeHead(404);
      res.end();
      return;
    }
    let file;
    try {
      file = await this.file(grant.path);
      let range;
      try {
        range = byteRange(req.headers.range, file.stats.size);
      } catch {
        res.writeHead(416, { 'Content-Range': `bytes */${file.stats.size}` });
        res.end();
        return;
      }
      const headers = {
        'Content-Type': file.mime,
        'Content-Length': range.end - range.start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      };
      if (range.partial)
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.stats.size}`;
      res.writeHead(range.partial ? 206 : 200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = file.handle.createReadStream({
        start: range.start,
        end: range.end,
        autoClose: true,
      });
      file = null;
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    } finally {
      await file?.handle.close();
    }
  }
}
