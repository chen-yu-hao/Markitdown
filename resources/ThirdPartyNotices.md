# Markedown Windows 第三方与来源说明

## 用户提供的原始工程和素材

Windows 版本以用户提供的 `Markedown-authored-source-0.1.6-2026-09-06.zip` 为行为和素材来源。对照资料保存在 `reference/macos/Markedown`。原工程 README 声明界面与图标为原创；本工程沿用 Markedown 名称与其中的图标，不为原归档添加新的授权条款。

- `resources/icon.png` 与原工程 `Resources/Assets.xcassets/AppIcon.appiconset/markedown-icon-256.png` 内容一致，SHA-256 为 `2958645e18020083f8ec0f64aa65481373bef53ebd6ab7fddb1e84ef75497f4b`。
- `resources/icon.ico` 封装原工程的 16、32、64、128、256 像素 PNG，供 Windows 在不同显示尺寸下使用。
- `resources/FeatureTour.md` 与原工程 `Samples/FeatureTour.md` 内容一致，SHA-256 为 `9c7676202343445162b5ae3b931eb6ffeb21450c1548f5fcde09843079271f86`。
- 原版的 Swift 依赖声明保留在 `reference/macos/Markedown/Resources/ThirdPartyNotices.md` 和 `Vendor/PROVENANCE.md`。这些 Swift 依赖不参与 Windows 编译；作者源码归档中的 `Vendor` 仅含来源记录，不能将其描述为完整的第三方依赖源码包。

## Windows 直接运行依赖

下表来自当前已安装包的 `package.json`。它是索引，不替代各包完整的版权、许可证及 NOTICE 文本；精确版本以 `package-lock.json` 和发布时生成的依赖清单为准。

| 组件 | 包中声明的许可证 |
| --- | --- |
| Electron | MIT；Chromium 和其他内置组件另有各自条款 |
| React、React DOM | MIT |
| CodeMirror 6 相关包、`@lezer/markdown` | MIT |
| markdown-it | MIT |
| KaTeX | MIT；其分发文件中的字体说明需同时保留 |
| MathJax (`mathjax-full`) | Apache-2.0 |
| citeproc | npm 声明 `CPAL-1.0 OR AGPL-1.0`；源码声明 CPAL 1 或更高版本、或 AGPL 3 或更高版本。本次分发采用 CPAL 1.0，详见下文 |
| fflate | MIT |
| `@xmldom/xmldom` | MIT |
| highlight.js | BSD-3-Clause |
| lucide-react | ISC；同时保留包内相关图标来源说明 |
| DOMPurify | MPL-2.0 OR Apache-2.0 |
| sharp | Apache-2.0；预编译 libvips 及其组件按各自许可证分发 |
| `@img/sharp-win32-x64` | Apache-2.0 AND LGPL-3.0-or-later |

Electron 分发目录随附 `LICENSE` 和 `LICENSES.chromium.html`。electron-builder 可能将 Electron 的许可证重命名为 `LICENSE.electron.txt`。交付时保留这些随运行时分发的文件，以及 `sharp` / `@img` 中的许可证和第三方说明。

Pandoc 是用户另行安装的可选外部程序，不包含在本项目的 Windows 运行时中。

## 依赖清单与发布

首先执行 `npm ci`，再运行 `npm run notices`。`scripts/notices.mjs` 从锁文件及实际安装的生产依赖读取包名、版本、许可证声明、仓库信息，并收集包内 `LICENSE*`、`LICENCE*`、`COPYING*`、`NOTICE*` 等原始文件；Electron 虽列在开发依赖中，其运行时许可证也纳入收集。它生成 `resources/THIRD_PARTY_LICENSES.txt` 与 `resources/THIRD_PARTY_DEPENDENCIES.json`，不会覆盖本页。不能根据本页表格推断全部间接依赖的许可证。

```powershell
npm run notices
npm run dist
```

`prebuild` 会自动运行许可证生成步骤，`dist` 在打包后调用 `scripts/release.mjs`。如仅需重新整理现有构建产物，可直接运行该脚本。许可证、依赖清单与本说明随安装版和便携版提供，位于程序可执行文件旁；GitHub 的 [Source code (zip)](https://github.com/chen-yu-hao/Markitdown/archive/refs/tags/v0.3.6.zip) 中也保留了 `resources` 目录下的对应文件。这些说明不再作为单独的 Release 附件。

本地 `release/` 目录仍会生成说明文件副本，并将其纳入本地 `SHA256SUMS.txt`，用于交付归档与校验。生成依赖清单时保留未声明许可证的条目，标记为待核实，不自动赋予 MIT 或其他默认许可证。

当前锁定的 `@img/sharp-win32-x64@0.34.5` 声明 `Apache-2.0 AND LGPL-3.0-or-later`，但其已安装 `LICENSE` 仅包含 Apache-2.0。`resources/native-licenses` 补充了官方 libvips 8.17.3 Windows 发行包中的 LGPL-2.1 正文、GNU 官方 LGPL-3/GPL-3 正文，以及已安装 sharp 包的原始署名表。官方发行包中的 DLL 与本地 DLL 逐字节一致，28 个原生组件版本也匹配；来源、摘要和验证范围保存在 `provenance.json`，并纳入自动生成的许可证与依赖清单。

这些补充材料仍不是每个静态链接组件的完整版权、许可证和对应源码集合，`provenance.json` 明确标记 `completeComponentLicenseTexts: false` 并列出缺项。不得把通用 GPL/LGPL 正文视为所有组件的完整归属声明。生成器会核对补充文件摘要、sharp 包版本及对应 DLL 摘要，依赖更新后需要重新核实来源。Electron 的完整 Chromium HTML 通知另随运行时保留，不重复塞入纯文本汇总。

`mj-context-menu@0.6.1` 是 MathJax 的间接依赖，声明 Apache-2.0，但 npm 包及对应上游提交均缺少包级 `LICENSE` / `NOTICE`。`resources/native-licenses/mj-context-menu-0.6.1-*` 保存了固定提交中 `ts/context_menu.ts` 的原始版权注释，以及注释指向的 Apache 官方 2.0 许可证正文。独立的 `mj-context-menu-0.6.1-provenance.json` 记录 npm 发布提交、标签提交、来源和 SHA-256；这些材料会由生成器验证并收录，保留上游文件缺失的说明。

## citeproc-js

本版本使用 `citeproc@2.4.63`，Copyright (c) 2009-2019 Frank Bennett。npm 元数据中的 `AGPL-1.0` 与包内 `LICENSE`、源码注释及上游 CPAL Exhibit A 中明确写出的 AGPL 第 3 版不一致，因此保留原始元数据并单独记录源码声明。本次仅为此组件选择 CPAL 1.0 分发选项，不改变应用整体的许可证，也不删除接收者在原始双重许可中的选择。

完整 CPAL、AGPLv3、原始 LICENSE 和 Exhibit B 署名已保存在 `resources/native-licenses/citeproc-2.4.63-*`。CPAL 第 14 条及 Exhibit B 要求 Larger Work 启动或开始会话时显著展示 `(c) Frank Bennett`、`citeproc-js implements the Citation Style Language` 和 `https://citationstyles.org/`；仅把信息放在需主动打开的关于窗口中不满足其启动展示条件。许可证要求显示足够时间供合理知悉，未规定固定秒数。

citeproc-js 的受许可源码按 CPAL 1.0 提供，位于随包附带的 `resources/source-archives/citeproc-js-73bc1b44bc7d54d0bfec4e070fd27f5efe024ff9.tar.gz`，也可从 [固定上游提交](https://github.com/Juris-M/citeproc-js/tree/73bc1b44bc7d54d0bfec4e070fd27f5efe024ff9) 获取。该归档包括 930 个上游文件及其构建脚本；其中 `citeproc_commonjs.js` 与已安装运行库逐字节一致。Markedown 未修改上游源码，构建时通过 esbuild 将运行库机械合并到主进程程序中，集成日期为 2026-09-07。原始代码和署名来源均为 Frank Bennett 的 citeproc-js；应用适配源码、构建配置与此归档一同随源码包提供。

CPAL 的源码通知、修改说明、署名和分发条件继续适用于其中的 Covered Code。来源记录会校验所附源码归档、许可证及本地运行库的 SHA-256；生成清单同时列明原始元数据、源码中的授权表达及本次选用的许可，不把 CPAL 表述为 MIT 或其他宽松许可。

本说明不更改第三方的许可范围或署名要求。
