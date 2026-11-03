# 插件后台批注接口

读取论文元数据及本地文件 URL 仍用 Zotero 本地 API；批注保存与复读使用 Codex for Zotero 0.4.0+ 内置后台接口，避免旧本地 API 批量标签写入失败和子批注检索不完整。禁止回退到“执行 JavaScript”窗口。

- 插件启动后写入 `~/.local/state/codex/zotero-paper-annotator/bridge.json`，权限 0600，含随机凭据、本机端点与 Zotero 实例 ID。凭据不输出，不改写 Zotero 的原生 API 授权文件。
- `POST /codex-for-zotero/annotations`，`Authorization: Bearer <插件凭据>`。拒绝浏览器 Origin、错误实例和非 JSON 数据。
- 操作仅限 `status/list/append/cleanup`。目标须为实际存在的 PDF 附件，写入检查文库权限，append 检查 PDF SHA-256、键、页码、矩形和父附件。
- append 接收每批最多 50 条高亮，插件通过 `Zotero.Annotations.saveFromJSON` 保存；不执行传入 JavaScript，不返回任意文件。
- 作者与自动化标签留空，定位指纹只存插件配置目录的 `annotation-metadata.json`。稳定键冲突不会覆盖旧对象。批量结果须检查 `success/unchanged/failed`，再复读原文、评论与坐标。
- cleanup 先备份原生 JSON，迁移旧指纹，随后仅移除保留前缀的自动化标签和 Codex 作者名；评论、位置、颜色及用户标签保留。

坐标为 PDF 原始坐标，`position` 为 `{"pageIndex":0,"rects":[[x1,y1,x2,y2],...]}`。PyMuPDF 字形经 `~page.transformation_matrix` 转回 PDF 坐标；预览再应用正向和旋转矩阵。不要只用页面高减 y。`sortIndex` 格式为 `00000|000000|00000`。

源 PDF 字节不改写；原生批注保存在 Zotero，可按需另行导出带批注 PDF。参考：[Zotero PDF 阅读器](https://www.zotero.org/support/pdf_reader)。
