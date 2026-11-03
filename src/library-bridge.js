import { collectionPath, duplicateCandidates, doiOf, arxivOf } from './library-protocol.mjs';

export class LibraryOperations {
  constructor(env) {
    Object.assign(this, env);
  }
  async library(name, write = false) {
    const { Zotero } = this;
    let id;
    if (name === 'users/0' || name === `users/${Zotero.Users.getCurrentUserID()}`)
      id = Zotero.Libraries.userLibraryID;
    else if (/^groups\/\d+$/.test(name || ''))
      id = Zotero.Groups.getLibraryIDFromGroupID(Number(name.split('/')[1]));
    const library = id && Zotero.Libraries.get(id);
    if (!library) throw new Error('目标文库不存在');
    if (write && !library.editable) throw new Error('目标文库没有写权限');
    await library.waitForDataLoad('item');
    await library.waitForDataLoad('collection');
    return library;
  }
  collections(library) {
    const rows = this.Zotero.Collections.getByLibrary(library.libraryID, true),
      byID = new Map(rows.map((c) => [c.id, c]));
    const path = (c) => {
      const parts = [],
        seen = new Set();
      while (c) {
        if (seen.has(c.id)) throw new Error('分类层级异常');
        seen.add(c.id);
        parts.unshift(c.name);
        c = c.parentID ? byID.get(c.parentID) : null;
      }
      return parts;
    };
    return rows.map((c) => ({
      key: c.key,
      name: c.name,
      parentKey: c.parentKey || null,
      path: path(c),
    }));
  }
  async targetCollection(library, data) {
    const { Zotero } = this;
    if (data.collectionKey) {
      if (!/^[A-Z0-9]{8}$/.test(data.collectionKey)) throw new Error('无效的分类键');
      const c = await Zotero.Collections.getByLibraryAndKeyAsync(
        library.libraryID,
        data.collectionKey,
      );
      if (!c || c.deleted) throw new Error('指定分类不存在');
      return { collection: c, created: [] };
    }
    const parts = collectionPath(data.path),
      created = [];
    let parent = null;
    for (const name of parts) {
      const candidates = Zotero.Collections.getByLibrary(library.libraryID, true).filter(
        (c) =>
          !c.deleted &&
          (c.parentID || null) === (parent?.id || null) &&
          c.name.normalize('NFC') === name,
      );
      if (candidates.length > 1)
        throw new Error(`同一父分类下有多个“${name}”，请改用分类键明确目标`);
      if (candidates.length) {
        parent = candidates[0];
        continue;
      }
      if (!data.createCollection)
        throw new Error(`分类“${parts.join('/')}”不存在；如需新建，请明确启用创建分类`);
      const c = new Zotero.Collection();
      c.libraryID = library.libraryID;
      c.name = name;
      if (parent) c.parentID = parent.id;
      await c.save();
      parent = c;
      created.push(c.key);
    }
    return { collection: parent, created };
  }
  canonical(raw) {
    const { Zotero } = this;
    if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !raw.title.trim())
      throw new Error('论文元数据缺少标题');
    const type = raw.itemType || 'journalArticle',
      typeID = Zotero.ItemTypes.getID(type);
    if (!typeID || ['attachment', 'annotation', 'note', 'feedItem'].includes(type))
      throw new Error('只接受正常论文或图书条目');
    const record = { itemType: type, title: raw.title.trim() };
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'title' || !['string', 'number'].includes(typeof value)) continue;
      const field = Zotero.ItemFields.getID(key);
      if (!field) continue;
      const mapped = Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, field) || field;
      if (Zotero.ItemFields.isValidForType(mapped, typeID))
        record[Zotero.ItemFields.getName(mapped)] = String(value);
    }
    if (record.DOI) {
      record.DOI = doiOf(record.DOI);
      if (!/^10\.\d{4,9}\/\S+$/.test(record.DOI))
        throw new Error('元数据 DOI 无效，请核对来源或省略未知 DOI');
    }
    record.creators = (raw.creators || [])
      .filter((c) => c && typeof c === 'object')
      .map((c) =>
        c.name || c.fieldMode
          ? { name: c.name || c.lastName || '', creatorType: c.creatorType || 'author' }
          : {
              firstName: c.firstName || '',
              lastName: c.lastName || '',
              creatorType: c.creatorType || 'author',
            },
      )
      .filter((c) => c.name || c.lastName);
    return record;
  }
  async resolve(data) {
    const { Zotero } = this;
    let translate;
    if (data.text !== undefined) {
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1000000)
        throw new Error('RIS/BibTeX 内容为空或过大');
      translate = new Zotero.Translate.Import();
      translate.setString(data.text);
    } else {
      let identifier;
      if (data.DOI) {
        const doi = doiOf(data.DOI);
        if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error('DOI 格式无效');
        identifier = { DOI: doi };
      } else if (data.arXiv) {
        const id = arxivOf(data.arXiv);
        if (!id) throw new Error('arXiv 标识无效');
        identifier = { arXiv: id };
      } else throw new Error('请提供 DOI、arXiv 标识或 RIS/BibTeX 文本');
      translate = new Zotero.Translate.Search();
      translate.setIdentifier(identifier);
    }
    translate.setHandler('select', (_obj, items, callback) =>
      callback(Object.keys(items).length === 1 ? items : {}),
    );
    const translators = await translate.getTranslators();
    if (!translators.length) throw new Error('没有可用的 Zotero 元数据转换器');
    translate.setTranslator(data.text !== undefined ? translators[0] : translators);
    const rows = await translate.translate({ libraryID: false, saveAttachments: false });
    const records = rows
      .filter((r) => r.itemType && !['note', 'attachment', 'annotation'].includes(r.itemType))
      .map((raw) => ({
        metadata: this.canonical(raw),
        pdfCandidates: (raw.attachments || [])
          .filter(
            (a) =>
              typeof a.url === 'string' &&
              /^https?:\/\//.test(a.url) &&
              (a.mimeType === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(a.url)),
          )
          .map((a) => a.url),
      }));
    if (!records.length) throw new Error('没有解析出论文记录');
    return { records, saved: false };
  }
  async find(library, record) {
    const { Zotero } = this,
      items = (await Zotero.Items.getAll(library.libraryID, true, false)).filter((i) =>
        i.isRegularItem(),
      );
    await Zotero.Items.loadDataTypes(items, ['itemData']);
    const candidates = items.map((item) => ({
      key: item.key,
      item,
      title: item.getField('title'),
      DOI: item.getField('DOI'),
      url: item.getField('url'),
      extra: item.getField('extra'),
    }));
    return duplicateCandidates(record, candidates);
  }
  async hashFile(path) {
    const bytes = await this.IOUtils.read(path),
      hash = this.Cc['@mozilla.org/security/hash;1'].createInstance(this.Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), (c) =>
      c.charCodeAt(0).toString(16).padStart(2, '0'),
    ).join('');
  }
  async attach(item, data) {
    const { Zotero, IOUtils } = this;
    if (!data.pdfPath && !data.pdfURL) return { status: 'not-requested' };
    await item.loadDataType('childItems');
    const children = Zotero.Items.get(item.getAttachments()).filter((a) => a.isPDFAttachment());
    if (data.pdfPath) {
      if (
        typeof data.pdfPath !== 'string' ||
        !data.pdfPath.startsWith('/') ||
        !/\.pdf$/i.test(data.pdfPath) ||
        !(await IOUtils.exists(data.pdfPath))
      )
        throw new Error('本地 PDF 路径无效');
      const prefix = await IOUtils.read(data.pdfPath, { maxBytes: 1024 });
      if (!String.fromCharCode(...prefix).includes('%PDF-')) throw new Error('文件不是 PDF');
      const hash = await this.hashFile(data.pdfPath);
      for (const a of children) {
        const path = await a.getFilePathAsync();
        if (path && (await IOUtils.exists(path)) && (await this.hashFile(path)) === hash)
          return { status: 'existing', key: a.key };
      }
      const a = await Zotero.Attachments.importFromFile({
        file: data.pdfPath,
        parentItemID: item.id,
        contentType: 'application/pdf',
      });
      return { status: 'saved', key: a.key };
    }
    if (typeof data.pdfURL !== 'string' || !/^https?:\/\/[^\s]+$/.test(data.pdfURL))
      throw new Error('PDF URL 无效');
    const existing = children.find((a) => a.getField('url') === data.pdfURL);
    if (existing) return { status: 'existing', key: existing.key };
    const a = await Zotero.Attachments.importFromURL({
      url: data.pdfURL,
      parentItemID: item.id,
      contentType: 'application/pdf',
    });
    if (!a?.isPDFAttachment()) throw new Error('未能下载有效 PDF');
    return { status: 'saved', key: a.key };
  }
  async add(library, data) {
    const { Zotero } = this;
    let item,
      record,
      created = false;
    if (data.itemKey) {
      if (!/^[A-Z0-9]{8}$/.test(data.itemKey)) throw new Error('论文条目键无效');
      item = await Zotero.Items.getByLibraryAndKeyAsync(library.libraryID, data.itemKey);
      if (!item?.isRegularItem() || item.deleted) throw new Error('指定论文不存在');
    } else {
      record = this.canonical(data.metadata);
      const found = await this.find(library, record);
      if (found.conflicts.length || found.matches.length > 1)
        throw new Error(
          '存在同名不同 DOI 或多个候选，请指定论文条目键：' +
            [...found.conflicts, ...found.matches].map((i) => i.key).join(', '),
        );
      item = found.matches[0]?.item;
    }
    let collection,
      membershipAdded,
      createdCollections = [];
    await Zotero.DB.executeTransaction(async () => {
      const target = await this.targetCollection(library, data);
      collection = target.collection;
      createdCollections = target.created;
      if (!item) {
        item = new Zotero.Item(record.itemType);
        item.libraryID = library.libraryID;
        item.fromJSON(record);
        created = true;
      } else await item.loadAllData();
      membershipAdded = !item.getCollections().includes(collection.id);
      if (membershipAdded) item.addToCollection(collection.id);
      if (created || membershipAdded) await item.save();
    });
    let pdf;
    try {
      pdf = await this.attach(item, data);
    } catch (e) {
      pdf = { status: 'failed', error: e.message };
    }
    await item.reload(['collections'], true);
    if (!item.getCollections().includes(collection.id))
      throw new Error('分类成员复读验证失败，请先检查结果再重试');
    return {
      created,
      itemKey: item.key,
      title: item.getField('title'),
      collection: {
        key: collection.key,
        path: this.collections(library).find((c) => c.key === collection.key)?.path,
      },
      createdCollections,
      membershipAdded,
      pdf,
      verified: true,
    };
  }
  async dispatch(data) {
    if (data.action === 'resolve' || data.action === 'parse') return this.resolve(data);
    const library = await this.library(
      data.library,
      ['ensure-collection', 'add'].includes(data.action),
    );
    if (data.action === 'status')
      return {
        available: true,
        version: this.pluginVersion,
        library: data.library,
        name: library.name,
        editable: library.editable,
        silent: true,
      };
    if (data.action === 'collections') return { collections: this.collections(library) };
    if (data.action === 'ensure-collection') {
      let result;
      await this.Zotero.DB.executeTransaction(async () => {
        result = await this.targetCollection(library, { ...data, createCollection: true });
      });
      return {
        collection: this.collections(library).find((c) => c.key === result.collection.key),
        created: result.created,
      };
    }
    if (data.action === 'add') return this.add(library, data);
    throw new Error('不支持的论文入库操作');
  }
}
