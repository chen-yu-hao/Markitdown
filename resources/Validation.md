# Windows 0.3.4 验证记录

环境：Windows 11 x64、Node.js 24.14.0、Electron 44.2.0、Zotero 9.0.6、本机 Pandoc 2.12。日期：2026-09-07。

## 本次验证（0.3.4）

- TypeScript 检查与生产构建通过。`npm test -- --maxWorkers=2`：268 项通过，1 项真实文件符号链接测试因 Windows 创建权限跳过。
- 新增 10 项文稿迁移单元测试通过。实际 Electron 主进程的 16 组迁移检查和既有 8 组主进程回归通过，覆盖成功确认、失败回滚、超时、窗口关闭、失效归属回收、恢复保护、保存互斥及窗口位置约束。
- 实际 Electron 标签界面的 7 组综合流程通过：右键非当前标签、单标签关闭及取消、关闭其他标签的整体确认和窗口隔离、移窗后文稿 ID/未保存内容/选区/滚动/模式与撤销重做、文件去重、拖回/按 Esc/关闭按钮拖动取消，以及移出窗口后松开鼠标。无渲染错误。
- 已检查迁移后的编辑器和菜单截图，覆盖 700 DIP 窄窗口及 125%/200% Chromium 设备缩放；窄窗按现有抽屉交互收起侧栏后操作标签。
- 18 组实际 Electron 编辑器回归通过，包括中文组合输入事件、Unicode、跨标签撤销、模式切换、查找替换、异步批量图片插入、选区及点击定位。无渲染错误。
- 0.3.4 打包 EXE 的全部 7 组标签工作流复验通过。滚动恢复检查等待键盘选区触发的滚动完成后，再同时校验编辑器 DOM 与主进程记录，确认非当前标签的 450px 滚动位置及撤销/重做记录随文稿迁移。
- 0.3.4 常规打包验证通过：实际 ASAR、隔离数据目录、原生 Sharp 图片导入及本地缩略图、包含当前未保存内容的 HTML/PDF/PNG 导出、导出窗口清理，以及 100%/125%/150%/200% 应用显示缩放。桌面和紧凑窗口无空白、横向溢出或渲染错误。

## 既有验收（0.3.3）

- TypeScript 检查与生产构建通过。`npm test -- --maxWorkers=2`：258 项通过，1 项真实文件符号链接测试因 Windows 创建权限跳过。
- 实际 Electron 公式布局检查通过：菜单插入行间公式及一次撤销/重做、默认全部编号、六种公式对齐和编号位置组合、多行公式单编号、手动编号、禁止编号、行内公式、设置持久化，以及 700×480 窗口。切换布局不修改 Markdown 源码，无渲染错误。
- HTML、独立 SVG 无样式 HTML、PDF、PNG 检查了公式左/编号右与公式右/编号左两种布局，覆盖未保存内容、交叉引用、多行和超宽公式。已检查编辑器、设置及导出截图；短多行公式没有内层滚动条，超宽公式在 PDF/PNG 中完整缩放且编号保持正常字号。
- 独立浏览器检查通过 54 组布局：KaTeX、SVG、MathML，三种宽度和六种对齐组合，覆盖多行、长公式和长编号。
- 实际 Word 六种布局均打开并成功渲染 PDF；每个样例包含 5 个原生可编辑公式、3 张独立无边框公式布局表和 8 个书签。逐张检查了公式对齐、编号垂直居中、无边框及相邻公式分隔。Pandoc 的 Word、EPUB、LaTeX 布局测试通过。
- 本次重新运行光标回归：134 组坐标定位和 17 组点击后立即输入检查全部通过，无渲染错误。18 组编辑回归通过，包括选区操作、中文组合输入事件、跨标签撤销、模式切换、查找替换及异步批量图片插入。
- 0.3.3 打包 EXE 的公式布局全流程复验通过，常规打包检查通过：ASAR、独立数据目录、原生 Sharp 图片导入、HTML/PDF/PNG 未保存内容导出、窗口清理，以及 100%/125%/150%/200% 应用缩放。HTML 预览取证改用保持隐藏并唤醒渲染的 Electron 捕获接口，修复测试中隐藏窗口截图超时的问题。

## 既有验收（0.3.2）

- TypeScript 检查与生产构建通过。`npm test -- --maxWorkers=2`：236 项通过，1 项真实文件符号链接测试因 Windows 创建权限跳过。
- `verify-editor.mjs` 的 18 组真实 Electron 编辑检查通过，包括 Shift+点击、鼠标拖选、双击选词、三击选行、非空旧选区外点击，以及既有 Unicode/Chromium IME 组合输入、跨标签撤销、模式切换、查找替换和异步批量图片插入。未出现渲染错误。
- `verify-caret-position.mjs` 的 134 组坐标检查和 17 组点击后立即输入检查通过。覆盖 100%/125%/150%/200% 应用缩放、1280/620 窗宽、普通正文/粗体/链接/公式、软换行/显式换行、前置标题/表格/代码/行间公式、上下段源码展开收起、长短文稿及源码模式。全部源码位置准确，最大纵向偏差约 0.307 CSS px（断言上限 2px），无渲染错误。已检查短文链接、公式点击前后的截图。

## 既有验收（0.3.1）

- TypeScript 检查与生产构建通过。
- 全套命令 `npm test -- --maxWorkers=2` 通过：227 项单元测试通过，1 项真实文件符号链接测试因 Windows 创建权限跳过。默认并发的首次运行中，一项 Windows 平台测试超过 5 秒超时；降低并发后完整复验通过。覆盖文件可靠性、设置、复制与导出、公式索引、引用扫描、CRLF 源码映射、手动公式编号、CSL 排版、Zotero 缓存、扩展注册生命周期和学术导出。
- 新增 7 项图片回归测试通过：真实 10000×8001 PNG 导入保留原始字节、2048×1639 预览、完整尺寸响应及 HTML 嵌入；超过 2.56 亿像素时在写入前拒绝并显示尺寸；损坏图片与混合批次不留下新增资源；动画总像素上限和 500/501 帧边界保持有效；头部有效但 IDAT 损坏的 PNG 不作为完整图片返回，处理队列在失败后仍能响应下一张正常图片。
- 0.3.1 实际 Electron 大图粘贴的 6 组检查通过：原生系统剪贴板 Ctrl+V 输入 10000×8001 PNG，资产全部像素哈希一致，2048×1639 预览非空，真实行中光标插入、一次撤销/重做、未保存内容与完整原图 HTML 导出，以及 700×480 窗口的图像设置换行。无渲染错误，测试前系统剪贴板已恢复。测试确认剪贴板 PNG 就绪并将测试窗口置于前台，避免系统剪贴板空文件和后台帧节流影响自动化。

## 既有验收（0.3.0）

以下界面与集成验收来自 0.3.0。

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
npm test -- --maxWorkers=2
npm run build
npm run test:ui
npm run test:e2e
node scripts/verify-menus.mjs
node scripts/verify-markdown-advanced.mjs
node scripts/verify-academic.mjs
node scripts/verify-academic-live.mjs
node scripts/verify-large-images.mjs
node scripts/verify-caret-position.mjs
node scripts/verify-equation-layout.mjs
node scripts/verify-editor.mjs
node scripts/verify-document-transfer.mjs
node scripts/verify-document-tabs.mjs
node scripts/verify-packaged.mjs
node scripts/verify-document-tabs.mjs release/win-unpacked/Markedown.exe
node scripts/verify-equation-layout.mjs release/win-unpacked/Markedown.exe
node scripts/verify-academic.mjs release/win-unpacked/Markedown.exe
```

测试使用独立数据目录，结果和截图保存在 `test-results`。标签操作为 `document-tabs/run-*/results.json`，公式布局为 `equation-layout/run-*/results.json`，本机 Word 布局为 `equation-layout-word/results.json`，学术界面为 `academic/results.json`，真实文库与导出为 `academic-live/results.json`，常规打包验证为 `packaged-results.json`。历史验证记录保存在 `validation-history`。
