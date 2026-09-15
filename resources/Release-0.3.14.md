# Markit 0.3.14

## 本次更新

- 参考 Nomo 的 Markdown-first 节点交互，加入文档元数据、正文目录、脚注、注释、安全 HTML、代码块标题和 Mermaid 图表节点。
- Mermaid 离线渲染支持流程图、时序图、类图、状态图、饼图、甘特图和 ER 图；渲染结果经过安全过滤，不执行文档脚本或外部资源。
- 表格节点编辑面板增加表格缩放、拖拽移动、原生尺寸调整和最大化/还原，输入、Tab、批量粘贴和滚动保持稳定。
- 图片节点支持对齐、宽度、替代文本、标题、复制路径、查看大图、缩放和平移。
- 文内脚注、正文目录和相对 Markdown 链接可直接定位目标；文件链接沿用安全白名单。
- 保留 A4 双栏、公式编号、Zotero 引用、科研三线表、源码与即时排版共用 Markdown 数据源。

## 示例文档

安装包内提供 [`ElementShowcase.md`](../resources/ElementShowcase.md)，覆盖全部新增元素。也可以直接打开 Nomo 的 `samples/sample.md`，使用“编辑 → 插入节点”补充元数据、目录、表格、脚注、提示块和 Mermaid 图表。

## 更新方式

安装版运行新版 EXE 安装到原目录；便携版解压到新目录并复制旧版 `data` 目录。更新前请保存并退出旧版。

提供 Windows x64 安装版与便携 ZIP、Linux x64 AppImage、DEB、RPM 和 tar.gz；GitHub 自动提供 Source code。
