import { LibraryOperations } from './library-bridge.js';
import { LIBRARY_ROUTE } from './library-protocol.mjs';
import { ANNOTATION_ROUTE, isInternalTag, validateAnnotation } from './annotation-protocol.mjs';

// A narrow plugin-owned endpoint. It never executes caller-supplied JavaScript.
export class AnnotationBridge {
  constructor(env) {
    Object.assign(this, env);
    this.records = {};
    this.queue = Promise.resolve();
  }
  async start() {
    const { Zotero, PathUtils, IOUtils, Services } = this;
    await Zotero.Server.init();
    this.serverID = Zotero.Server.LocalAPI.getServerID();
    const dir = PathUtils.join(Zotero.Profile.dir, 'codex-for-zotero');
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, permissions: 0o700 });
    this.metadataFile = PathUtils.join(dir, 'annotation-metadata.json');
    try {
      this.records = JSON.parse(await IOUtils.readUTF8(this.metadataFile)).records || {};
    } catch (e) {
      if (await IOUtils.exists(this.metadataFile)) throw e;
    }
    this.token = [Services.uuid.generateUUID(), Services.uuid.generateUUID()]
      .join('')
      .replace(/[{}-]/g, '');
    const stateDir = PathUtils.join(
      this.home,
      '.local',
      'state',
      'codex',
      'zotero-paper-annotator',
    );
    await IOUtils.makeDirectory(stateDir, { ignoreExisting: true, permissions: 0o700 });
    this.discoveryFile = PathUtils.join(stateDir, 'bridge.json');
    this.libraryOperations = new LibraryOperations(this);
    const owner = this;
    this.Endpoint = class {
      supportedMethods = ['POST'];
      supportedDataTypes = ['application/json'];
      permitBookmarklet = false;
      async init(request) {
        const get = (name) => request.headers.get?.(name) || request.headers[name.toLowerCase()];
        if (get('Origin') || get('Authorization') !== `Bearer ${owner.token}`)
          return owner.response(403, { error: '本地批注连接验证失败' });
        if (request.data?.serverID !== owner.serverID)
          return owner.response(409, { error: 'Zotero 实例不一致，请重新提取论文' });
        if (JSON.stringify(request.data).length > 1500000)
          return owner.response(400, { error: '批注请求过大' });
        try {
          return owner.response(
            200,
            await owner.serial(() =>
              request.pathname === LIBRARY_ROUTE
                ? owner.libraryOperations.dispatch(request.data)
                : owner.dispatch(request.data),
            ),
          );
        } catch (e) {
          return owner.response(400, { error: e.message });
        }
      }
    };
    Zotero.Server.Endpoints[ANNOTATION_ROUTE] = this.Endpoint;
    Zotero.Server.Endpoints[LIBRARY_ROUTE] = this.Endpoint;
    await IOUtils.writeUTF8(
      this.discoveryFile,
      JSON.stringify({
        version: this.pluginVersion,
        url: `http://127.0.0.1:${Zotero.Server.port}${ANNOTATION_ROUTE}`,
        libraryURL: `http://127.0.0.1:${Zotero.Server.port}${LIBRARY_ROUTE}`,
        token: this.token,
        serverID: this.serverID,
      }),
      { permissions: 0o600 },
    );
    await IOUtils.setPermissions(this.discoveryFile, 0o600);
  }
  response(status, data) {
    return [
      status,
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Zotero-Server-ID': this.serverID,
      },
      JSON.stringify(data),
    ];
  }
  async serial(fn) {
    const next = this.queue.catch(() => {}).then(fn);
    this.queue = next;
    return next;
  }
  async saveMetadata() {
    await this.IOUtils.writeUTF8(
      this.metadataFile,
      JSON.stringify({ version: 1, records: this.records }),
      { tmpPath: this.metadataFile + '.tmp', permissions: 0o600 },
    );
    await this.IOUtils.setPermissions(this.metadataFile, 0o600);
  }
  async target(data) {
    const { Zotero } = this;
    let libraryID;
    if (data.library === 'users/0' || data.library === `users/${Zotero.Users.getCurrentUserID()}`)
      libraryID = Zotero.Libraries.userLibraryID;
    else if (/^groups\/\d+$/.test(data.library || ''))
      libraryID = Zotero.Groups.getLibraryIDFromGroupID(Number(data.library.split('/')[1]));
    if (!libraryID || !/^[A-Z0-9]{8}$/.test(data.attachmentKey || ''))
      throw new Error('无效的目标文库或 PDF 附件');
    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, data.attachmentKey);
    if (!attachment?.isPDFAttachment() || attachment.deleted)
      throw new Error('目标 PDF 不存在或已删除');
    if (data.action !== 'list' && !Zotero.Libraries.get(libraryID).editable)
      throw new Error('此文库没有批注写入权限');
    await attachment.loadDataType('childItems');
    return attachment;
  }
  recordKey(item) {
    return `${item.libraryID}:${item.key}`;
  }
  async list(attachment) {
    await attachment.reload(['childItems'], true);
    const rows = [];
    for (const item of attachment.getAnnotations()) {
      await item.loadAllData();
      rows.push({
        key: item.key,
        data: item.toJSON(),
        codexAnchor: this.records[this.recordKey(item)]?.anchor || null,
      });
    }
    return rows;
  }
  async digest(attachment) {
    const path = await attachment.getFilePathAsync();
    if (!path) throw new Error('PDF 尚未下载');
    const bytes = await this.IOUtils.read(path),
      hash = this.Cc['@mozilla.org/security/hash;1'].createInstance(this.Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), (c) =>
      c.charCodeAt(0).toString(16).padStart(2, '0'),
    ).join('');
  }
  async dispatch(data) {
    if (data.action === 'status')
      return { available: true, version: this.pluginVersion, silent: true };
    if (!['list', 'append', 'cleanup'].includes(data.action)) throw new Error('不支持的批注操作');
    const attachment = await this.target(data);
    if (data.action === 'list') return { annotations: await this.list(attachment) };
    if (data.action === 'cleanup') return this.cleanup(attachment);
    if (
      !/^[a-f0-9]{64}$/.test(data.pdfSha256 || '') ||
      (await this.digest(attachment)) !== data.pdfSha256
    )
      throw new Error('PDF 内容已经变化，停止保存旧批注计划');
    if (!Array.isArray(data.items) || !data.items.length || data.items.length > 50)
      throw new Error('每批需包含 1–50 条批注');
    const clean = data.items.map((item) => validateAnnotation(item, attachment.key));
    const existing = await this.list(attachment),
      successful = {},
      success = {},
      unchanged = {},
      failed = {};
    for (let i = 0; i < clean.length; i++) {
      const incoming = data.items[i],
        json = clean[i];
      try {
        const collision = await this.Zotero.Items.getByLibraryAndKeyAsync(
          attachment.libraryID,
          json.key,
        );
        const sameAnchor =
          incoming.codexAnchor && existing.find((row) => row.codexAnchor === incoming.codexAnchor);
        if (sameAnchor) {
          unchanged[i] = sameAnchor.key;
          continue;
        }
        if (collision) {
          if (
            collision.parentID === attachment.id &&
            collision.annotationType === 'highlight' &&
            collision.annotationText === json.text &&
            JSON.stringify(JSON.parse(collision.annotationPosition)) ===
              JSON.stringify(json.position)
          ) {
            unchanged[i] = collision.key;
            continue;
          }
          throw new Error('批注标识与已有对象冲突，未覆盖');
        }
        const item = await this.Zotero.Annotations.saveFromJSON(attachment, json);
        this.records[this.recordKey(item)] = {
          attachmentKey: attachment.key,
          anchor: incoming.codexAnchor || null,
        };
        await this.saveMetadata();
        success[i] = item.key;
        successful[i] = { key: item.key };
      } catch (e) {
        failed[i] = { key: json.key, code: 400, message: e.message };
      }
    }
    return { successful, success, unchanged, failed };
  }
  async cleanup(attachment) {
    const { Zotero } = this,
      changes = [];
    for (const item of attachment.getAnnotations()) {
      await item.loadAllData();
      const tags = item.getTags(),
        owned = tags.some((t) => isInternalTag(t.tag));
      if (!owned) continue;
      const marker = tags.find((t) => /^codex-anchor:[a-f0-9]{16,64}$/i.test(t.tag));
      const old = this.records[this.recordKey(item)] || {};
      this.records[this.recordKey(item)] = {
        ...old,
        attachmentKey: attachment.key,
        anchor:
          marker?.tag.slice('codex-anchor:'.length, 'codex-anchor:'.length + 24) ||
          old.anchor ||
          null,
      };
      changes.push({ item, old: item.toJSON(), tags: tags.filter((t) => !isInternalTag(t.tag)) });
    }
    if (!changes.length) return { cleaned: 0, keys: [] };
    const backup = this.PathUtils.join(
      Zotero.Profile.dir,
      'codex-for-zotero',
      `annotation-cleanup-${attachment.key}-${Date.now()}.json`,
    );
    await this.IOUtils.writeUTF8(backup, JSON.stringify(changes.map((c) => c.old)), {
      permissions: 0o600,
    });
    await this.IOUtils.setPermissions(backup, 0o600);
    // Persist deduplication records before removing visible legacy tags.
    await this.saveMetadata();
    for (const { item, tags } of changes) {
      item.setTags(tags);
      if (item.annotationAuthorName === 'Codex') item.annotationAuthorName = '';
      await item.saveTx();
    }
    return { cleaned: changes.length, keys: changes.map((c) => c.item.key), backup };
  }
  async stop() {
    await this.queue.catch(() => {});
    if (this.Zotero.Server.Endpoints[ANNOTATION_ROUTE] === this.Endpoint)
      delete this.Zotero.Server.Endpoints[ANNOTATION_ROUTE];
    if (this.Zotero.Server.Endpoints[LIBRARY_ROUTE] === this.Endpoint)
      delete this.Zotero.Server.Endpoints[LIBRARY_ROUTE];
    try {
      const current = JSON.parse(await this.IOUtils.readUTF8(this.discoveryFile));
      if (current.token === this.token) await this.IOUtils.remove(this.discoveryFile);
    } catch {}
  }
}
