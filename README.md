# Markedown Windows

Markedown 是一款 Windows Markdown 编辑器，提供即时排版、多标签、文件夹管理与多种导出格式。文稿以本地 Markdown 文件保存。

目标系统为 Windows 10 22H2、Windows 11，构建架构为 x64。运行安装版或便携版不需要另装 Node.js。工作区扫描使用系统自带的 Windows PowerShell，通过后台进程读取真实的隐藏与重解析点属性。

## 下载

当前版本为 **Markedown 0.3.2**，适用于 **Windows x64**。安装程序和便携程序均未签名。

- [最新版本与发布说明](https://github.com/chen-yu-hao/Markitdown/releases/latest)
- [下载 0.3.2 安装程序 EXE](https://github.com/chen-yu-hao/Markitdown/releases/download/v0.3.2/Markedown-0.3.2-Windows-x64-Setup.exe)
- [下载 0.3.2 便携版 ZIP](https://github.com/chen-yu-hao/Markitdown/releases/download/v0.3.2/Markedown-0.3.2-Windows-x64.zip)

## 界面与设置

紧凑顶栏包含：文件、编辑、视图、主题、帮助与原生 Windows 窗口按钮共用一行。移除原来的 Logo 操作栏，格式工具栏默认关闭。偏好设置位于 **编辑 → 偏好设置**（Ctrl+,）；顶部主题菜单提供 Github、Newsprint、Night、Pixyll、Whitey 五种主题样式。

正文、各级标题至分隔线归入 **编辑 → 格式** 二级菜单；打开、保存和导出位于 **文件**。二级菜单支持鼠标悬停、方向键和分层 Escape。

Markdown 设置新增独立代码缩进、默认代码语言及触发方式、Shift+Tab 语法缩进、LaTeX 分隔符、math 代码块、physics 公式、兼容解析和独立公式编号。公式可复制为离线 SVG 或 MathML；无样式 HTML 使用同一选择。编辑与内建 HTML/PDF/PNG 导出分别设置空格与换行，支持首行缩进和编辑时的换行标记，切换设置不会改写源码。Shift+Tab 语法缩进支持 JavaScript、TypeScript、CSS 和 HTML；其他语言反缩进一级。

**偏好设置 → 导出 → Word** 可调整中文与西文字体、文字颜色、正文和 H1-H6 字号、标题粗体及斜体。默认宋体、Times New Roman、黑色文字，正文 12 pt，标题 18/16/14/12/12/12 pt，标题加粗且不倾斜。Word 导出仍需 Pandoc。

偏好设置支持搜索，并分为文件、编辑器、图像、Markdown、导出、外观、通用七页。已接通启动行为、切换保存、最近记录、文件筛选、缩进与配对、Emoji 补全、复制、换行、拼写检查、标题与列表样式、数学和上下标、高亮、Github 警报框、智能标点、代码行号与换行、图片目录、导出预设、独立深色主题、缩放、阅读速度、自定义快捷键与资源管理器新建菜单。数值和路径输入在离开输入框或按 Enter 时保存；其他设置即时生效。窗口框架样式在重启后生效。

新增 HTML 无样式、MediaWiki、reStructuredText、Textile、OPML 导出，以及通过 Pandoc 导入 DOCX、ODT、EPUB、HTML、RST、Textile、OPML。导入的图片保留在应用管理的导入目录；导出使用当前未保存内容及当前主题。可添加、删除、重命名和排序导出预设。

当前支持内建主题和手动升级，暂不支持 Mermaid 图表预览、外部主题安装及自动更新。实际验证范围见 `resources/Validation.md`。

## 论文写作

**编辑 → 学术引用** 提供文献检索、公式引用、公式标签和参考文献列表入口。Zotero 需在本机运行并启用本地 API，连接地址为 `http://localhost:23119/api/`，当前读取个人文库 `users/0`。已读取的文献缓存在应用数据目录，离线仍可排版。

直接输入 `[@D9PGQUM4; @T4IQZGRM; @MRHTZ5CI]`，或按 `Ctrl+Shift+C` 检索并多选插入文献。数字制按首次引用顺序编号、重复引用共用一条书目；Markdown 偏好设置可切换作者年份制。缺失条目明确提示，导出前需完成解析。

首次输入或插入引用时，文末自动加入独立一行的 `<!-- markedown:bibliography -->`。移动这一行即可调整参考文献列表的位置。打开已有文稿不会自动改写源码；没有占位符时，文末显示临时列表，导出快照也补在文末。

行间公式默认自动编号。在公式中加入 `\label{eq:energy}`，正文使用 `\eqref{eq:energy}`、`\ref{eq:energy}` 或 `[@eq:energy]` 引用。行内公式如 `$E=mc^2\label{eq:energy}$` 同样可以引用。编号支持整篇连续或按一级标题分节；选择“仅带标签”可隐藏无标签公式的编号。标签引用会随前文公式增删更新，并可点击定位。重复或缺失标签会提示并阻止导出。

编辑和 HTML/PDF/PNG 共用学术排版。Pandoc 导出保留当前引用和书目位置；Word 公式使用原生可编辑数学对象。Word 中的编号和参考文献是本次 Markdown 快照的结果，不是 Word 引文管理器或自动编号域。

LaTeX、RST、Textile、MediaWiki 等文本导出会在目标旁生成 `markedown-assets-*` 图片目录，移动导出文件时需同时移动此目录。DOCX、EPUB、ODT、RTF 的图片嵌入文件中。

详细说明见 [学术写作](resources/AcademicWriting.md)，可直接打开 [论文示例](resources/AcademicExample.md)。已预留版本 1 的 Markdown 语法和文献提供器接口，内建功能使用同一注册表；未来接入说明见 [扩展接口](resources/Extensions.md)。当前还没有外部插件加载或插件市场。

## 启动与使用

- 安装版：运行发布目录中的 `Markedown-0.3.2-Windows-x64-Setup.exe`。安装器注册 Markdown 的“打开方式”，不强制改变默认应用。
- 便携版：将 `Markedown-0.3.2-Windows-x64.zip` 完整解压到可写目录，运行 `Markedown.exe`。保留同目录中的 `portable.json` 标记及其余文件。
- 可从资源管理器拖入文稿，或运行 `Markedown.exe "C:\文稿\笔记.md"`。同一文件重复打开时激活已有文稿。
- DOCX、EPUB、LaTeX、RTF、ODT、MediaWiki、RST、Textile、OPML 导出需要另外安装 Pandoc。程序检查 `PATH` 与常见 Pandoc 安装目录，也可以在设置中指定 `pandoc.exe`。内建 HTML、PDF、PNG 导出不需要 Pandoc。
- 图片粘贴、拖入与选择导入保留原图；静态图片最多 2.56 亿像素，动画或多页图片合计最多 8000 万像素、500 帧。单张文件最多 64 MiB，每批最多 100 张、合计 256 MiB；大图预览默认使用 2048 像素以内的缓存缩略图。

常用快捷键：

| 操作 | 快捷键 |
| --- | --- |
| 新文稿 / 新窗口 | `Ctrl+N` / `Ctrl+Shift+N` |
| 打开文稿 / 文件夹 | `Ctrl+O` / `Ctrl+Shift+O` |
| 保存 / 另存为 | `Ctrl+S` / `Ctrl+Shift+S` |
| 查找 / 替换 | `Ctrl+F` / `Ctrl+H` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` |
| 加粗 / 斜体 | `Ctrl+B` / `Ctrl+I` |
| 源码模式 / 侧栏 | `Ctrl+/` / `Ctrl+Shift+L` |
| 专注 / 打字机模式 | `F8` / `F9` |
| 设置 | `Ctrl+,` |

## 从源码构建

使用 Windows x64、Node.js 24 LTS 和 npm。本次核心测试环境为 Node.js `24.14.0`、npm `11.9.0`。第一次安装依赖需要访问 npm 与 Electron 下载服务；具体依赖版本以 `package-lock.json` 为准。

在本工程目录打开 PowerShell：

```powershell
npm ci
node node_modules/electron/install.js
npm run dev
```

Electron 44 的运行时需要单独安装。每次重新执行 `npm ci` 后，运行上述 `install.js`，它会按锁定版本下载并校验 Electron；已安装时直接复用。

开发命令会构建主进程、启动 Vite，并打开实际 Electron 窗口。终端显示的地址用于当前开发会话；需要 Electron 提供文件访问接口。界面代码由 Vite 更新，主进程或 preload 改动后需重新启动开发命令。

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:ui
node scripts/verify-menus.mjs
node scripts/verify-markdown-advanced.mjs
node scripts/verify-academic.mjs
node scripts/verify-large-images.mjs
node scripts/verify-caret-position.mjs
node scripts/verify-editor.mjs
```

`npm test` 使用 Vitest；`test:e2e` 使用 Playwright 启动实际 Electron 程序；`test:ui` 检查顶栏、主题、分类设置、切换保存和自定义快捷键。新增脚本分别验证二级菜单、公式设置、代码输入、真实剪贴板及四种内建导出。修改依赖后须更新并提交锁文件，再使用 `npm ci` 重装确认。

```powershell
npm run pack
npm run dist
```

`pack` 生成 `release/win-unpacked`，适合检查解包后的程序；`dist` 构建 NSIS 安装程序与 ZIP，并执行发布整理脚本。`prebuild` 自动收集许可证，`afterPack` 为解包目录添加 `portable.json`；NSIS 安装时删除该标记，因此安装版使用用户应用数据目录。首次打包还需要下载 electron-builder 使用的 Windows 打包工具。

`release` 中的正式交付文件：

| 文件 | 内容 |
| --- | --- |
| `Markedown-0.3.2-Windows-x64-Setup.exe` | 未签名 NSIS 安装程序 |
| `Markedown-0.3.2-Windows-x64.zip` | 含 `portable.json` 的便携程序 |
| `Markedown-0.3.2-Windows-Source.zip` | Windows 源码、测试、脚本、锁文件、文档和 macOS 对照资料 |
| `THIRD_PARTY_LICENSES.txt` | 从已安装运行依赖收集的原始许可证文本 |
| `THIRD_PARTY_DEPENDENCIES.json` | 依赖版本、许可证声明、来源、原生组件版本和待核实项 |
| `ThirdPartyNotices.md` / `README.zh-CN.md` | 来源说明 / 中文说明 |
| `SHA256SUMS.txt` | 以上 7 个文件的 SHA-256 校验值 |

源码 ZIP 内包含单一 `Markedown-0.3.2-Windows-Source` 顶层目录，排除依赖安装目录、构建产物、发布目录、缓存和 Git 元数据。便携 ZIP 会执行完整性检查，并检查版本对应的便携标记。

```powershell
npm run notices
node scripts/release.mjs --check
node scripts/release.mjs
```

`--check` 只检查源码输入和工具解析器，不创建 ZIP；不带参数时要求安装程序和便携 ZIP 已存在，再重新生成源码归档、说明副本和校验文件。检查下载文件时可使用 `Get-FileHash -Algorithm SHA256 .\release\Markedown-0.3.2-Windows-x64-Setup.exe`，将结果与 `SHA256SUMS.txt` 对照。

构建使用未签名的 Windows 可执行文件，没有自动更新服务。

## 文稿与数据

安装版使用 Electron 的用户应用数据目录，通常为 `%APPDATA%\Markedown`；便携版使用 `Markedown.exe` 旁的 `data`。数据目录包含 `settings.json`、`recovery` 恢复记录以及运行时缓存。`MARKEDOWN_DATA_DIR` 可为测试指定独立目录。便携目录不可写时程序报错，需将整个便携目录移动到可写位置。

编辑器内文本统一为 LF。打开 UTF-8 文件时保留 BOM 信息；混合 LF/CRLF 以多数为准，相同数量时使用首先出现的类型，孤立 CR 归一为换行但不参与判定。保存采用同目录临时文件、刷新及原子替换，并比较文件内容摘要；文件被外部修改或删除时不会静默覆盖。保存过程中继续输入的内容保持未保存状态。

修改后约 220 毫秒写入恢复记录。开启自动保存且文稿已有路径时，约 1.1 秒后保存。恢复文稿始终显示未保存，必须手动保存一次后才允许自动写回；一条恢复记录损坏不会阻止其他记录加载。恢复记录可能包含完整的未保存文稿，请与原文稿一样管理其访问权限。

图片导入默认写入文稿旁的 `assets`，可在“图像”设置中调整目录与路径形式，因此未保存文稿需先选择保存路径。撤销插入会撤销 Markdown 文本，已落盘的图片文件仍保留。文稿移动时需要同时移动其相对路径资源。

## 边界与验证

- 只编辑 UTF-8 文本；无效 UTF-8 或含 NUL 的二进制文件会被拒绝。
- 超过 1 MiB 的文稿默认源码模式，超过 5 MiB 强制源码模式。大文稿源码模式暂停输入时的全文学术索引和自动参考文献占位符插入，主动插入、刷新或导出时仍解析引用。
- 工作区检索最多返回 500 条匹配，默认过滤隐藏文件、符号链接、目录联接与原版定义的包目录。可设置显示隐藏项和文件类型；重解析点仍跳过以防循环遍历。受权限限制的子目录会跳过；Windows PowerShell 被系统策略禁用时会报告扫描失败。
- 预览默认阻止远程图片，原始 HTML 不作为任意 HTML 执行。HTML 导出可单独允许远程图片；PDF、PNG 和 Pandoc 导出不读取远程图片。
- PNG 最长边不超过 16,384 像素、总像素不超过 40,000,000，超出时缩小。图片过多或原始尺寸超出限制时会明确报错。
- 首版没有表格行列编辑、Mermaid、自定义 CSS、文件操作撤销、自动更新或代码签名。

核心测试位于 `tests/storage.test.ts`，覆盖换行/BOM、中文与组合字符、内容冲突、删除、取消后发生的新外部修改、真实 Windows `FileShare.None` 独占锁、保存中继续编辑、并发保存目标、批量关闭回滚、恢复保护、Windows 隐藏属性、目录联接、包目录、检索上限和取消。文件锁测试已在当前 OneDrive 工作区运行，但不代表覆盖所有同步提供程序或杀毒软件行为。真实文件符号链接测试因当前 Windows 缺少创建权限跳过，另有真实目录联接及模拟文件链接测试。

`tests/release.test.mjs` 使用独立临时目录验证许可证收集、便携标记及输出路径约束、源码归档的包含与排除规则；这些测试不运行真实安装器。

发布验收还应以实际产物检查安装、卸载、便携启动、文件关联，以及中文输入法和不同 Windows 显示缩放；自动化输入事件不能代替真实输入法组合过程。完整验证结果以本次交付记录及测试输出为准，不将待验证场景记为通过。

独立验证脚本：`node scripts/verify-main.mjs` 检查主进程关闭与文件交互；`node scripts/verify-editor.mjs` 检查编辑器事务；`node scripts/verify-exports.mjs` 检查真实 PDF/PNG 和 Pandoc 导出。`npm run test:e2e` 覆盖完整界面流程，截图及结果写入 `test-results`。`scripts/verify-install.ps1` 默认只读检查，传入 `-Execute` 才会在隔离目录实际安装并卸载，且拒绝覆盖已有 Markedown 安装或关联。

素材与依赖说明见 [resources/ThirdPartyNotices.md](resources/ThirdPartyNotices.md)。
