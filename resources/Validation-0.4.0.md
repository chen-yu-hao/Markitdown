# Markit 0.4.0 验证记录

本记录对应 v0.4.0 发布候选版本。发布前应在 Windows 11 x64 和 Linux x64 工作流中执行以下检查，并将实际通过数量补充到发布说明。

## 重点验收

- 标签和侧栏文件右键菜单可复制完整路径，并可在系统文件夹中显示文稿。
- 表格节点支持内嵌单元格编辑、Tab/Enter 导航、行列选择、插入/删除、批量 TSV 粘贴、缩放和面板大小调整；修改可撤销，表格样式与导出一致。
- 光标进入粗体、链接、行内/行间公式等语法单元时只显示对应最小源码范围；离开后恢复排版视图。
- 审阅模式显示新增下划线和删除删除线；跟踪文件使用项目 `HEAD`，未跟踪文件创建明确命名的基线提交，非 Git 目录需确认后才初始化；逐条接受使用缓存补丁提交，全部接受提交当前文件，外部 Git HEAD 变化会刷新基线。
- A4 双栏、长表格、公式、图片、参考文献、行号和多窗口编辑保持滚动与定位稳定。

## 可重复执行的命令

```powershell
npm ci
node node_modules/electron/install.js
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run test:e2e
npm run test:ui
npx electron-builder --win nsis zip --x64 --publish never
node scripts/verify-packaged.mjs
```

发布工作流还应验证安装版覆盖升级、便携版 `data` 目录迁移、Windows 100%/125%/150%/200% 显示缩放，以及 Linux x64 四种软件包。发布附件只包含安装版、便携版和 GitHub 自动生成的 Source code。

## 已知边界

表格合并/拆分、外部主题安装和自动更新仍未提供。安装包未签名；审阅模式依赖本机 Git 可执行文件及项目工作区写权限，应用数据仅保存审阅元数据。超过大小阈值的文稿会自动转入源码模式。
