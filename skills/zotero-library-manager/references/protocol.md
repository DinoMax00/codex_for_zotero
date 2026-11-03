# 后台协议

`~/.local/state/codex/zotero-paper-annotator/bridge.json` 是本机 Codex for Zotero 的共享发现文件。0.5.0 起含 `libraryURL`，端点为 `POST /codex-for-zotero/library`。脚本读取私有随机凭据和实例 ID；不输出密钥，不访问外部服务器，不复用在线 zotero.org API key。

请求带 `Authorization: Bearer <插件凭据>`；JSON 必须含对应 `serverID` 和 `library: users/0` 或 `groups/<ID>`。拒绝浏览器 Origin、错误实例和任意代码执行。

操作：

- `status`：目标文库与写权限。
- `collections`：现有分类的键、父键与完整路径数组。
- `ensure-collection`：按明确的根路径逐层复用/创建，只在同一父节点下匹配名称；遇同名歧义停止。
- `resolve`：DOI/arXiv，调用 Zotero Search 翻译器，`libraryID:false`，不保存。
- `parse`：RIS/BibTeX，调用 Import 翻译器，`libraryID:false`，不保存。
- `add`：接收 `metadata` 或 `itemKey`，以及 `collectionKey` 或 `path`；可带 `createCollection`、`pdfPath` 或 `pdfURL`。先查重，再使用原生数据 API 保存，分类成员关系做并集，不覆盖旧条目。

条目与分类使用 Zotero 事务保存，PDF 作为父论文的子附件单独保存；PDF 失败回执会保留已完成的入库状态。旧分类、条目和源文件均不会因失败被删除。

参考：[Zotero JavaScript 数据 API](https://www.zotero.org/support/dev/client_coding/javascript_api)。本机按 Zotero 10.0.7 的 collections、items、attachments 与 translate 实现验证。
