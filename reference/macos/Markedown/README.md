# Markedown

Markedown 是一个面向 macOS 15 及以上版本的原生 Markdown 编辑器。它使用 SwiftUI 构建窗口与状态界面，使用 AppKit/TextKit 编辑视图，并通过独立适配层接入 `swift-markdown-engine`。Markdown 文本始终是文档的唯一数据源。

## 当前版本

`0.1.6` 已完成编辑器基础和可日用版本的主体能力：

- 单画布即时排版与源码模式，支持中文输入法、组合字符、Emoji、选区、每个标签独立撤销栈和查找替换。
- 单文件、多标签、多窗口和文件夹工作区；侧栏包含按需文件树、大纲与全局文本搜索。
- 支持从 Finder 拖入 Markdown 文件自动打开，并注册到 Markdown 文件的“打开方式”菜单。
- 原子保存、UTF-8 BOM、CRLF/LF 保留、内容摘要冲突检测、外部修改检查和崩溃恢复；恢复内容必须显式保存后才写回原文件。
- CommonMark/GFM 基础语法、任务列表、代码高亮、表格显示、本地图片、删除线、高亮、`<sup>/<sub>` 上下标和基础 LaTeX；上下标保留内部转义语法并按继承字体缩放。
- 图多文档使用视口布局、滚动状态合并和大图预解码缩略图，避免滚动时反复处理文首布局与超大像素源图。
- 可从 Finder 或“照片”App 拖入、粘贴多张图片，按原顺序一次插入到真实光标位置并保存到文稿资源目录；整批操作可一次撤销。
- 专注模式、打字机模式、字数统计、浅色/深色主题与中英文界面。
- 内建安全 HTML、PDF 和长图导出；安装 Pandoc 后可导出 DOCX、EPUB、LaTeX、RTF 和 ODT。
- 默认阻止远程图片；只排版严格匹配且成对的 `<sup>/<sub>`，其他原始 HTML 作为源码保留，内建预览和导出不会执行其中的脚本。

以下完整功能对齐项仍属于后续里程碑，当前版本不将其标记为完成：原生表格行列编辑、Mermaid 即时渲染、脚注/YAML/TOC/GitHub Alerts 的专用交互、自定义 CSS 主题、文件操作撤销和命令行安装器。Developer ID 签名与公证也需要发布凭据。

## 工程

- Bundle ID：`com.zhuanz.markedown`
- 最低系统：macOS 15.0
- Swift：6，严格并发检查
- 工程生成：XcodeGen
- 主依赖：`swift-markdown-engine 0.12.0`、`swift-markdown 0.8.0`

依赖精确版本记录在 `Package.resolved`。为避免 Git 智能 HTTP 不稳定影响复现，已验证的官方 tag 源码归档同时保存在 `Vendor/`；两个包清单改为相邻本地路径，编辑器引擎另含有记录的 Apache-2.0 性能与扩展解析补丁。提交、归档校验值和补丁范围见 [Vendor/PROVENANCE.md](Vendor/PROVENANCE.md)，许可证见 [Resources/ThirdPartyNotices.md](Resources/ThirdPartyNotices.md)。

## 构建与测试

```sh
xcodegen generate
xcodebuild \
  -project Markedown.xcodeproj \
  -scheme Markedown \
  -configuration Debug \
  -derivedDataPath /private/tmp/MarkedownDerivedData \
  -destination 'platform=macOS,arch=arm64' \
  build

xcodebuild \
  -project Markedown.xcodeproj \
  -scheme Markedown \
  -configuration Debug \
  -derivedDataPath /private/tmp/MarkedownDerivedData \
  -destination 'platform=macOS,arch=arm64' \
  test
```

建议把 DerivedData 放在本地临时目录。同步盘或 File Provider 目录可能给测试包附加扩展属性，导致本机临时签名失败。

## 设计边界

Markedown 不包含 Typora 的名称、Logo、主题、截图、文案或安装资源，也不依赖其私有实现。项目只对齐公开的编辑工作流与功能类别，并使用原创界面和图标。
