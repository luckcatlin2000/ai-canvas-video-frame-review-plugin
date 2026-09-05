const MAX_FRAME_COUNT = 24;
const FRAME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function asFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return (text || fallback).slice(0, maxLength);
}

function formatTimecode(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function normalizeFrames(parameters) {
  const rawFrames = Array.isArray(parameters.frames) ? parameters.frames : [];
  if (rawFrames.length < 1 || rawFrames.length > MAX_FRAME_COUNT) {
    throw new Error(`逐帧拉片必须包含 1-${MAX_FRAME_COUNT} 个画面`);
  }

  const keys = new Set();
  return rawFrames.map((rawFrame, index) => {
    if (!rawFrame || typeof rawFrame !== 'object' || Array.isArray(rawFrame)) {
      throw new Error(`第 ${index + 1} 个画面数据无效`);
    }
    const key = typeof rawFrame.key === 'string' ? rawFrame.key : '';
    const resourceId = typeof rawFrame.resourceId === 'string' ? rawFrame.resourceId.trim() : '';
    if (!FRAME_KEY_PATTERN.test(key) || keys.has(key)) throw new Error('画面 key 无效或重复');
    if (!resourceId) throw new Error(`画面 ${key} 缺少派生资源`);
    keys.add(key);

    const requestedTime = Math.max(0, asFiniteNumber(rawFrame.requestedTime, 0));
    const actualTime = Math.max(0, asFiniteNumber(rawFrame.actualTime, requestedTime));
    const frameDuration = Math.max(0, asFiniteNumber(rawFrame.frameDuration, 0));
    const width = Math.max(1, Math.round(asFiniteNumber(rawFrame.width, 1)));
    const height = Math.max(1, Math.round(asFiniteNumber(rawFrame.height, 1)));
    return {
      key,
      resourceId,
      requestedTime,
      actualTime,
      frameDuration,
      width,
      height,
      shotSize: cleanText(rawFrame.shotSize, '未标注', 80),
      camera: cleanText(rawFrame.camera, '未标注', 240),
      content: cleanText(rawFrame.content, '未返回分析', 2000),
      dialogue: cleanText(rawFrame.dialogue, '无法从画面判断', 1000),
      audio: cleanText(rawFrame.audio, '无法从画面判断', 1000),
      transition: cleanText(rawFrame.transition, '切', 80),
      duration: Math.max(0, asFiniteNumber(rawFrame.duration, 0)),
      note: cleanText(rawFrame.note, '', 1000),
      confidence: Math.max(0, Math.min(1, asFiniteNumber(rawFrame.confidence, 0))),
      analysisError: cleanText(rawFrame.analysisError, '', 240),
    };
  });
}

function resolvedDuration(frames, index, videoDuration) {
  const frame = frames[index];
  if (frame.duration > 0) return Math.min(frame.duration, 3600);
  const next = frames[index + 1];
  if (next && next.actualTime > frame.actualTime) return Math.max(0.04, next.actualTime - frame.actualTime);
  if (videoDuration > frame.actualTime) return Math.max(0.04, videoDuration - frame.actualTime);
  return Math.max(0.04, frame.frameDuration || 1);
}

function buildNodeSet(parameters) {
  const frames = normalizeFrames(parameters);
  const outputMode = parameters.outputMode === 'images' ? 'images' : 'shotlist';
  const videoDuration = Math.max(0, asFiniteNumber(parameters.videoDuration, 0));
  const imageNodes = frames.map((frame, index) => ({
    key: frame.key,
    nodeType: 'ai-image',
    resourceId: frame.resourceId,
    data: {
      label: `${formatTimecode(frame.actualTime)} · ${frame.shotSize}`,
      imageWidth: frame.width,
      imageHeight: frame.height,
      frameAnalysis: {
        requestedTime: frame.requestedTime,
        actualTime: frame.actualTime,
        frameDuration: frame.frameDuration,
        shotSize: frame.shotSize,
        camera: frame.camera,
        content: frame.content,
        dialogue: frame.dialogue,
        audio: frame.audio,
        transition: frame.transition,
        duration: resolvedDuration(frames, index, videoDuration),
        note: frame.analysisError ? `${frame.note ? `${frame.note}；` : ''}${frame.analysisError}` : frame.note,
        confidence: frame.confidence,
      },
    },
  }));

  if (outputMode === 'images') return { nodes: imageNodes, edges: [] };

  const shotlistKey = 'shotlist';
  const shotlistRows = frames.map((frame, index) => ({
    id: `shot-${index + 1}`,
    shotNo: String(index + 1),
    frameKey: frame.key,
    shotSize: frame.shotSize,
    camera: frame.camera,
    content: frame.content,
    dialogue: frame.dialogue,
    audio: frame.audio,
    transition: frame.transition,
    duration: resolvedDuration(frames, index, videoDuration),
    note: frame.analysisError ? `${frame.note ? `${frame.note}；` : ''}${frame.analysisError}` : frame.note,
  }));
  return {
    nodes: [
      ...imageNodes,
      {
        key: shotlistKey,
        nodeType: 'ai-shotlist',
        data: {
          label: `逐帧拉片 · ${frames.length} 镜`,
          shotlistRows,
        },
      },
    ],
    edges: frames.map((frame) => ({ sourceKey: frame.key, targetKey: shotlistKey })),
  };
}

definePlugin({
  tools: {
    'video-frame-review': (input) => ({
      data: buildNodeSet(input && input.parameters ? input.parameters : {}),
      message: input && input.parameters && input.parameters.outputMode === 'images'
        ? '已生成逐帧图片节点'
        : '已生成逐帧图片与分镜表',
    }),
  },
});
