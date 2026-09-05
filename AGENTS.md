# 项目规则

本仓库是 AI-Canvas Plugin API v1 的“逐帧拉片”视频节点工具插件。

- 发布入口只有根目录 `manifest.json`、`main.js` 和 `ui.js`；不要提交构建缓存。
- 插件运行时和开发期保持零依赖；新增 npm 依赖前必须先说明必要性并取得确认。
- `ui.js` 只能使用宿主注入的 `props`，禁止直接联网、访问本地路径、Tauri IPC、宿主 DOM 或 Store。
- 帧资源只保存 invocation 内的 `resourceId`；持久化文件和节点 ID 必须由宿主在最终提交时生成。
- 修改 `ui.js` 后运行 `npm run build` 更新 `manifest.ui.integrity`。
- 完成前运行 `npm test`、`npm run build` 和 `git diff --check`。
- 版本发布时保持 `package.json` 与 `manifest.json` 版本一致；Git tag 与 Manifest version 一致。

架构与数据流见 `docs/ARCHITECTURE.md`，项目范围与验收见 `docs/PROJECT_CONTRACT.md`。
