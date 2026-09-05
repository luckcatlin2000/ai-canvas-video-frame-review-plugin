# 开源拉片项目研读与落地

调研日期：2026-09-05。以下依据项目公开文档与相关源码，不代表已安装或运行验证，也不采用作者自述作为生产可靠性背书。本插件独立实现交互原则，未复制第三方代码或新增依赖。

| 项目 | 值得学习 | 本次落地 |
| --- | --- | --- |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | [自适应阈值、最低内容差异和最短镜头](https://www.scenedetect.com/docs/latest/api/detectors.html)共同抑制运动误检 | 低分辨率帧差与自适应基线、最短镜头、单帧闪光抑制；只学习设计，算法与参数并不等价 |
| [ShotBoard](https://github.com/madjyc/ShotBoard) | 逐帧校正、拆合镜头；[有界撤销历史](https://github.com/madjyc/ShotBoard/blob/main/shotboard_cmd.py) | 镜头编辑、真实帧步进、30 步撤销/重做 |
| [PyMoviePrint](https://github.com/eldorado230/PyMoviePrint) | 可交互选帧、联系表；[状态快照与显式序列化](https://github.com/eldorado230/PyMoviePrint/blob/main/state_manager.py) | 编辑与输出分离、结构化报告，避免把临时图片/资源句柄放进报告 |
| [Breakdown Studio](https://github.com/thevfxsupervisor/breakdown-studio) | 稳定镜头身份、首中尾采样、边界 QC、人工纠错 | ID 随编辑/节点保存；AI 原文、人工覆盖与复核状态独立记录 |

## 适配取舍

- 不直接嵌入这些项目的桌面 UI。插件仍运行在主窗口的 sandbox iframe，媒体解码及输出由宿主授权。
- 不引入 Python、OpenCV、TransNetV2 或额外 FFmpeg；因此本次自动切镜只是可校正的初筛，不能宣称达到专业检测器的准确率。
- 联系表保留完整画面，不自动裁切黑边或时间码；保证拉片依据不被隐式改变。
- AI 仅看到所选代表帧的联系表。运镜、声音和台词不得当成已从完整视频验证的事实。
- 镜头发生变化必须重新抽帧和分析；同批 AI 重试保留人工覆盖，避免反复分析抹掉人的判断。

## 后续可单独评估

1. 跨会话保存/导入编辑草稿，并与来源视频资产身份绑定。
2. 可选专业检测后端和真实样片基准，比较硬切、叠化、闪光与高速运动的误检/漏检。
3. 按镜头时长比例显示时间线、长视频分批队列和完整项目联系表。

这些后续项涉及新的持久化/执行范围，不包含在本次实现中。
