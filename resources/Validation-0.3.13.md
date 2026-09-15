# Markit 0.3.13 验证记录

本地环境：Windows 11 x64、Node.js 24.14.0、Electron 44.2.0，2026-09-15。所有样例在隔离数据目录运行，不修改用户文稿或 Zotero 文库。

## 核心检查

- TypeScript 检查与生产构建通过；41 个测试文件中 384 项通过，1 项需要 Windows 符号链接权限的测试跳过。
- `verify-paste-heading.mjs` 使用真实鼠标拖选、Ctrl+C 和系统剪贴板 Ctrl+V：标题开头复制包含 `#`；单栏即时排版与源码模式分别验证光标位于视口内、上方和下方，原阅读内容保持屏幕位置，粘贴可一步撤销。
- `verify-article-layout.mjs` 验证 A4 比例、每页两栏、页间分隔、后续页面编辑、保存、跨模式撤销/重做、中文组合输入、系统剪贴板图片粘贴、多标签、窄窗口及 HTML/PDF/PNG 导出。
- `verify-academic-scroll.mjs` 使用 37 条合成文献、长表格和公式，验证两次完整滚动往返；A4 表格续栏重复表头且不丢行，文献顺序与数量完整，结束续页内容编辑不跳回第一段。另覆盖初始 1024px 窗口及四次宽度调整，检查重新分页后各栏不溢出、表格行数及文献顺序完整。
- `verify-editor.mjs` 覆盖单栏表格打开不修改源码、Unicode、跨标签撤销、模式切换、查找替换、异步图片插入、Chromium 中文组合输入、偏好重配与鼠标选区。
- `verify-node-editors.mjs` 验证单元格 Unicode 与竖线转义、Tab、保存、行列选择和右键增删、对齐、尺寸调整、电子表格粘贴及单步撤销；行内/行间公式实时预览、标签和编号、取消与键盘退出；A4 续表第 88 个正文行的中文组合输入、映射与滚动位置。
- `verify-line-numbers.mjs` 覆盖视图菜单、独立源码行号、15,000 行文稿、不同主题与窗口尺寸；`verify-save-scroll.mjs` 覆盖保存、复制和保存期间继续输入。
- PDF 页图已检查正文双栏、公式、表格、长图和页码；`pdfinfo` 确认 A4 纸张。新增的 README 图来自公开示例 `PaperExample.md` 的真实应用截图。

中文输入通过 Chromium 组合输入事件验证，未将其计为人工 Windows 中文输入法验收。Linux 软件包由发布工作流在 Ubuntu 构建，不将 Windows UI 检查计为 Linux 桌面验证。

## 发布门禁

GitHub Actions 在打包后对实际 `Markit.exe` 运行启动、图片、导出、四档显示缩放、行号、保存、A4 双栏、粘贴与标题复制、公式滚动、主题数字、文稿标签、学术滚动和侧栏专项检查。全部通过后上传 Windows 安装版及便携 ZIP；随后构建 Linux 软件包。

可复验命令：

```powershell
npm ci
node node_modules/electron/install.js
npm test -- --maxWorkers=2
npm run dist:win
node scripts/verify-packaged.mjs
node scripts/verify-paste-heading.mjs release/win-unpacked/Markit.exe
node scripts/verify-article-layout.mjs release/win-unpacked/Markit.exe
node scripts/verify-academic-scroll.mjs release/win-unpacked/Markit.exe
node scripts/verify-node-editors.mjs release/win-unpacked/Markit.exe
```
