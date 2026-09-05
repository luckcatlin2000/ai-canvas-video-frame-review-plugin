# 架构与数据流

## 文件边界

- `manifest.json`：声明节点入口、最小权限、自定义 UI、允许输出的节点类型和字段。
- `ui.js`：运行在主窗口 Modal 内的 sandboxed iframe，负责选帧、模型调用和结果编辑。
- `main.js`：QuickJS 最终写回入口，只把 UI 提交的数据映射成受控节点集。
- `scripts/`：只使用 Node.js 内置模块进行 syntax、integrity 和发布结构校验。

## 主流程

1. UI 从 `resources.self` 选择当前节点的视频不透明句柄。
2. 首个 `video.extractFrames` effect 生成 12 张有界胶片预览。
3. 用户选择最多 24 个时间点；第二个 effect 批量抽取分析帧并登记派生资源及联系表。
4. 第三个 `model.generate` effect 把联系表交给支持图片输入的文本模型，要求返回按 key 对齐的 JSON。
5. UI 将结果映射回每个派生帧，允许人工修订；模型漏项会显式标错。
6. UI `submit` 后，`main.js` 返回 `create-node-set`：图片节点携带帧 `resourceId`，分镜行使用临时 `frameKey`。
7. 宿主保存图片、生成真实 nodeId、解析分镜绑定和内部边，并通过一次 Store Action 写入画布。

## 生命周期与恢复

- 派生图片只存在于当前 UI invocation 的内存租约中。
- 关闭、取消、换项目、改画布、停用插件或插件 revision 变化都会使租约失效。
- 同一选帧集合会复用已抽取的联系表，保留一次模型 JSON 失败后的重试机会。
- 任一最终资源失效或节点集校验失败时整批拒绝；宿主负责回收本次准备阶段创建的文件。
