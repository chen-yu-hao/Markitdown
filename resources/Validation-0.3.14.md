# Markit 0.3.14 验证记录

验证环境：Windows 11 x64、Node.js 24.14.0、Electron 44.2.0。验收日期：2026-09-16。

## 功能范围

本版覆盖 Nomo `samples/sample.md` 中的 Markdown 文档元素：标题、段落、行内格式、链接、列表与任务、提示块、表格、代码块、公式、七类 Mermaid 图、图片、受限 HTML、作者注释、脚注、目录和 YAML 元数据。样例后半部分描述的 Nomo 应用能力不等于 Markit 的功能承诺；具体支持范围见 README。

所有修改仍写回 Markdown。表格缩放和面板尺寸不写入文稿，也不改变正文缩放；单元格编辑保留撤销记录。元数据和作者注释只在编辑器显示，导出时省略。应用内部的公式编号和参考文献占位符继续使用各自的处理逻辑。

## 已执行的检查

- TypeScript 检查、生产构建及全量 Vitest：42 个测试文件，391 项通过，1 项因 Windows 符号链接权限跳过。
- 原始 Nomo 样例的隔离副本：七类 Mermaid 离线渲染、本地图片、文稿滚动、表格连续 Unicode 输入、尺寸调整、缩放，以及 HTML/PDF/PNG 导出。原文件未修改，也未收入仓库。
- 公开的 `ElementShowcase.md`：YAML、代码、HTML、脚注、注释的编辑与精确取消；代码内容出现连续反引号时保留合法围栏；图片原生右键设置、大图查看、相对文档链接；A4 目录和脚注跳转不误开启编辑器。
- 表格与公式节点：行列选择、插入删除、对齐、批量 TSV 粘贴与整批撤销、Tab 导航、输入与保存；公式预览、编号、取消；A4 续页表格的行号映射和输入法组合事件。
- 学术滚动：37 条缓存参考文献、长表格和公式，两轮滚轮往返与 75 次位置采样；停留时几何稳定；四种窗口宽度重新分页，不丢失表格行、不重复参考文献，继续编辑参考文献后阅读位置稳定。
- A4 编辑：页间分隔、跨页正文输入、图片粘贴、保存与撤销重做、标签切换，以及紧凑窗口；标题源码复制包含 `#`，粘贴保持视口；全文行号。
- PDF 视觉检查：原始样例 26 页单栏和公开样例 A4 双栏的图表、图片、三线表、公式与脚注。甘特图使用固定绘制宽度，避免窗口宽度把导出文字缩得过小。

## 可重复执行的命令

```powershell
npm ci
node node_modules/electron/install.js
npm run typecheck
npm test -- --maxWorkers=2
npm run build
node scripts/verify-document-elements.mjs
node scripts/verify-node-editors.mjs
node scripts/verify-article-layout.mjs
node scripts/verify-academic-scroll.mjs
node scripts/verify-paste-heading.mjs
node scripts/verify-line-numbers.mjs
npx electron-builder --win nsis zip --x64 --publish never
node scripts/verify-packaged.mjs
node scripts/verify-document-elements.mjs release/win-unpacked/Markit.exe
node scripts/release.mjs
```

发布工作流在实际 Windows 安装包解包程序上运行节点、滚动、图片、文件树、标签、行号及导出验收，完成后才上传安装程序和便携 ZIP。通用发行包验收覆盖 100%、125%、150%、200% 应用显示缩放。构建产物的 SHA-256 与依赖许可证随本地发布归档保存。

## 验证边界

中文输入通过 Chromium 输入法组合事件和 Unicode 文本验证；本次没有逐一人工验证所有第三方输入法。Linux 包由 Ubuntu 发布工作流构建，本地 Windows 测试不代表 Linux 桌面交互已经人工验收。安装包未签名。

Mermaid 使用内置引擎，禁止图表配置指令、外部资源和脚本；过大或语法错误的图表显示错误，导出失败时保留原文稿。GFM 表格不支持合并单元格；超过节点编辑尺寸限制时仍可编辑完整 Markdown 源码。
