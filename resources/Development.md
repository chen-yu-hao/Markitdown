# 开发与构建

本文面向从源码运行、测试和打包 Markedown 的开发者。安装使用说明见[项目首页](../README.md)。

## 环境准备

- Windows x64。
- Node.js 24 LTS 和 npm。Windows 发布工作流使用 Node.js `24.14.0`。
- 首次安装需要访问 npm、Electron 下载服务和 electron-builder 的打包工具下载服务。
- Pandoc 仅用于扩展格式的导入、导出和相关集成验证。

可下载 GitHub 按版本标签生成的 [Source code (zip)](https://github.com/chen-yu-hao/Markitdown/archive/refs/tags/v0.3.6.zip)，或克隆仓库：

```powershell
git clone https://github.com/chen-yu-hao/Markitdown.git
cd Markitdown
npm ci
node node_modules/electron/install.js
npm run dev
```

依赖以 `package-lock.json` 为准。Electron 44 需要显式安装运行时，因此每次 `npm ci` 后都应执行 `node node_modules/electron/install.js`；安装器按包内版本与摘要下载并校验，已安装时直接复用。

`npm run dev` 构建主进程、启动 Vite 并打开 Electron。界面改动由 Vite 更新，主进程或 preload 改动后需重启开发命令。编辑器依赖 Electron 提供文件接口，不能仅通过普通浏览器使用完整功能。

## 检查与测试

```powershell
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run test:e2e
npm run test:ui
```

`npm test` 运行 Vitest 测试；`test:e2e` 和 `test:ui` 使用 Playwright 启动真实 Electron 程序。功能专项验证命令见[验证记录](Validation.md)，包括编辑事务、光标定位、大图粘贴、学术引用、导出及实际打包程序。

UI 验证使用独立数据目录，结果和截图写入 `test-results`。部分集成检查需要 Pandoc、Zotero、Word 或额外工具，应按验证记录准备对应环境；跳过的检查不代表已通过。

## Windows 打包

```powershell
npm run pack
```

生成 `release/win-unpacked`，可直接检查解包后的程序。生成完整发行包使用：

```powershell
npm run dist
node scripts/verify-packaged.mjs
```

`dist` 执行生产构建，生成 NSIS 安装程序和便携 ZIP，并整理源码、许可证与校验文件。`verify-packaged.mjs` 在隔离数据目录中启动 `release/win-unpacked/Markedown.exe`，验证图片导入、HTML/PDF/PNG 导出及多档应用缩放。

以下文件保存在本地 `release/` 目录，用于交付归档与校验：

| 本地产物 | 内容 |
| --- | --- |
| `Markedown-<版本>-Windows-x64-Setup.exe` | 未签名 NSIS 安装程序 |
| `Markedown-<版本>-Windows-x64.zip` | 含 `portable.json` 的便携程序 |
| `Markedown-<版本>-Windows-Source.zip` | 源码、测试、脚本、锁文件、文档和 macOS 对照资料 |
| `README.zh-CN.md` | 中文使用与构建说明入口 |
| `THIRD_PARTY_LICENSES.txt` | 运行依赖许可证文本及补充材料 |
| `THIRD_PARTY_DEPENDENCIES.json` | 依赖版本、许可证声明和来源记录 |
| `ThirdPartyNotices.md` | 第三方与素材来源说明 |
| `SHA256SUMS.txt` | 以上七个文件的 SHA-256 校验值 |

`prebuild` 自动收集依赖许可证。`afterPack` 为解包程序添加便携标记，NSIS 安装时删除该标记，使安装版使用用户应用数据目录。

源码归档排除 `node_modules`、构建产物、缓存和用户数据。便携 ZIP 会进行完整性与版本标记检查。需要单独检查或重新整理发布文件时，可运行：

```powershell
npm run notices
node scripts/release.mjs --check
node scripts/release.mjs
```

`--check` 只检查源码输入和工具解析，不生成归档。不带参数时要求安装程序与便携 ZIP 已存在，会重新生成源码包、说明副本与校验文件。

## GitHub 发布

仓库的 [Windows Release 工作流](https://github.com/chen-yu-hao/Markitdown/blob/main/.github/workflows/release.yml)支持推送 `v*` 标签触发，也支持手动指定已有标签。标签必须与 `package.json` 中的版本一致。

工作流检出指定标签，安装锁定依赖与 Electron，完成测试、构建、打包及实际程序验证后，只上传 `Markedown-<版本>-Windows-x64-Setup.exe` 与 `Markedown-<版本>-Windows-x64.zip`。核对这两个附件后，草稿才会公开为最新版本；已公开的同名版本不会被工作流覆盖。

发布页的 Source code（zip / tar.gz）由 GitHub 按标签自动生成。许可证、依赖清单与第三方说明保留在程序可执行文件旁和源码的 `resources` 目录中，不再单独上传为 Release 附件。`scripts/release.mjs` 仍生成上表中的全部本地产物；其中自建源码 ZIP、说明副本和 `SHA256SUMS.txt` 留在本地 `release/` 目录，用于归档与校验。

Windows 检出时必须保留 `resources/native-licenses` 的原始字节，许可证来源校验会核对 SHA-256。仓库使用 `.gitattributes` 保护这些文件；工作流也在检出前关闭自动换行转换，以支持较早标签。不要通过修改预期摘要来绕过来源校验。

工作流将 `TEMP` 和 `TMP` 规范化为长路径，避免 Windows 的 `RUNNER~1` 短路径影响涉及路径比较的测试。

## 运行与排错

可通过命令行打开含中文或空格路径的文稿：

```powershell
.\Markedown.exe "C:\文稿\研究笔记.md"
```

安装版数据通常位于 `%APPDATA%\Markedown`；便携版位于程序旁的 `data`。`MARKEDOWN_DATA_DIR` 可为开发或验证指定独立目录，恢复记录可能包含完整未保存文稿。

工作区扫描使用系统 Windows PowerShell 读取隐藏与重解析点属性。受权限限制的子目录会跳过；PowerShell 被系统策略禁用时会报告扫描失败。搜索跳过符号链接和目录联接，避免循环遍历。

编辑器内部使用 LF，打开文件时记录 UTF-8 BOM 和换行格式。保存使用同目录临时文件、原子替换和内容摘要检查。恢复记录约在修改后 220 毫秒写入；启用自动保存的有路径文稿约在停输 1.1 秒后写回，恢复稿首次手动保存前禁止自动写回。

图片导入限制：静态图片最多 2.56 亿像素；动画或多页图片合计最多 8000 万像素、500 帧；单文件最多 64 MiB，每批最多 100 张且总计不超过 256 MiB。大图默认生成 2048 像素以内的缓存缩略图。PNG 导出最长边不超过 16,384 像素、总像素不超过 40,000,000，超出时缩小。

超过 1 MiB 的源码文稿暂停输入时的全文学术索引与自动参考文献占位符插入；主动插入、刷新和导出仍按需解析。此行为用于限制长文稿输入时的计算开销。

项目结构与未来扩展方式见[扩展接口](Extensions.md)，许可证来源和适用范围见[第三方与来源说明](ThirdPartyNotices.md)。
