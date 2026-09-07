# Windows 0.3.0 验证记录

环境：Windows 11 x64、Node.js 24.14.0、Electron 44.2.0、Zotero 9.0.6、本机 Pandoc 2.12。日期：2026-09-07。

## 已完成

- TypeScript 检查与生产构建通过。
- 220 项单元测试通过，1 项真实文件符号链接测试因 Windows 创建权限跳过。覆盖原有文件可靠性、设置、复制与导出，以及新增公式索引、引用扫描、CRLF 源码映射、手动公式编号、CSL 排版、Zotero 缓存、扩展注册生命周期和学术导出。
- 实际 Electron 学术编辑流程共 9 组通过，并在打包 EXE 上复验：旧文稿不改源码的临时文献列表，多选引用的顺序与真实选区插入，一次撤销/重做，公式标签与跳转，过期搜索与离线缓存，普通正文不重复解析文献，刷新途中继续编辑，组合输入结束后补占位符，以及桌面、700px 窄窗口与深色主题。无渲染错误。
- 学术面板的 Ctrl+A 与后台命令隔离通过；Ctrl+V 验证键事件未被应用截获，此检查不等同于真实系统剪贴板粘贴。启动署名显示、窄窗布局及显示结束均已检查。
- 实际 Electron 全流程回归 16 组通过，覆盖 Unicode/Chromium IME 组合事件、跨标签撤销、模式切换、查找替换、大纲与工作区搜索、批量图片及撤销、BOM/CRLF 保存、未保存内容及本地图片的 HTML/PDF 导出、窗口尺寸和大文稿规则。35 万字符文稿打开测量为 52ms，仅代表当前机器与测试样例。
- 紧凑顶栏、主题、七类可搜索设置、持久化、自定义快捷键和切换保存的 8 组检查通过；二级菜单的 4 组检查通过。
- Markdown 功能的 5 组实际 Electron 检查通过：LaTeX 分隔符、physics、math 代码块及跨区域编号、代码输入与缩进、SVG/MathML 系统剪贴板，以及 HTML/无样式 HTML/PDF/PNG 未保存内容导出。
- 实际 Pandoc DOCX 测试验证原生 OMML 分式、矩阵与行内公式，同行编号、引用锚点、中文/空格/# 图片路径、文献位置和数字条目段落；原有 Word 字体、颜色、字号和标题设置仍生效。缺失引用和重复公式标签在覆盖输出前被拒绝。文本导出的图片资源持久化与失败清理通过。
- 最终构建连接真实 Zotero 9.0.6，三个样例条目键解析和精确键搜索通过；在真实编辑器输入未保存内容后，通过实际 IPC 导出 HTML、PDF、PNG、DOCX。PDF 为 3 页，长图为 1200×2291，Word 16.0 成功读取 12 个原生公式及 1 张嵌入图片，并生成 2 页 PDF。逐页检查公式与同行编号、文献位置、表格、图片和中文，无遮挡或裁切；Word 实际版心宽度与公式制表位一致。测试仅关闭通过文稿 HWND 和启动时间确认的新 Word 实例，原有 Word 进程保持运行；原 Markdown 磁盘内容未改变。
- 学术状态字段的 10 次事务测量：1 MiB 源码文稿平均约 6-7ms，5 MiB 约 27-31ms；样例分别为普通正文或公式/引文。此为状态字段事务测量，不是整个应用的键盘到屏幕延迟。大源码文稿暂停自动全文学术解析，显式操作和导出按需计算。
- 打包程序的 ASAR 启动、独立数据目录、Sharp 图片导入、本地图片协议/缩略图、HTML/PDF/PNG 导出及窗口清理通过；100%/125%/150%/200% 应用显示缩放下的桌面与紧凑窗口无空白、横向溢出或渲染错误。

## 验证范围

目标平台为 Windows 10 22H2 / Windows 11 x64；本次未使用 Windows 10 实机。Chromium IME 组合事件不等同于真实微软拼音候选框操作。应用缩放不等同于所有系统显示配置。本次未执行真实安装/卸载测试。安装包未签名，没有自动更新。

可重复的学术界面脚本使用隔离的测试文献传输，不将该测试误作真实 Zotero 连接。真实 Zotero 与导出的独立检查使用 `verify-academic-live.mjs`，要求本机运行 Zotero 并存在样例中的三个条目键，且安装 Word、Poppler 的 `pdftoppm`，以及包含 `pypdf` 的 Python。可通过 `PDFTOPPM`、`MARKEDOWN_QA_PYTHON` 指定程序路径；也可用 `PDFTOTEXT` 指定文本提取程序以替代 Python。

## 可重复执行

```powershell
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:e2e
node scripts/verify-menus.mjs
node scripts/verify-markdown-advanced.mjs
node scripts/verify-academic.mjs
node scripts/verify-academic-live.mjs
node scripts/verify-packaged.mjs
node scripts/verify-academic.mjs release/win-unpacked/Markedown.exe
```

测试使用独立数据目录，结果和截图保存在 `test-results`。学术界面证据为 `academic/results.json`，真实文库与导出为 `academic-live/results.json`，常规打包验证为 `packaged-results.json`。历史验证记录保存在 `validation-history`。
