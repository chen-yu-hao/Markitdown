# Markedown Windows 0.3.7

Windows 10 22H2 / Windows 11，x64。提供未签名安装程序与便携 ZIP。

## 本次更新

- 表格支持类似 Excel 的单元格编辑：双击或按 Enter 编辑，Enter 提交，Esc 取消，失焦提交；编辑内容直接写回 Markdown，保留粗体、链接和转义管道符。
- 默认表格样式改为科研三线表，新增网格表和简洁横线表，可在“偏好设置 → Markdown → Markdown 语法偏好 → 表格样式”中切换。
- 即时排版与 HTML/PDF/PNG 导出共用表格样式设置；行列增删、合并拆分等电子表格操作暂未加入。

## 安装与更新

安装版：保存文稿并退出旧版，运行新版 Setup.exe 安装到原目录。便携版：解压新版到新目录，复制旧版的 `data` 目录后启动；另行存放的文稿和图片保留在原位置。

发布附件保留安装版 EXE 和便携 ZIP；Source code（zip / tar.gz）由 GitHub 按版本标签自动生成。许可证和依赖说明随程序包与源码提供。

使用与构建说明见 [README.md](../README.md)，验证范围见 [Validation.md](Validation.md)。
