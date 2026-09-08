const MAX_FRAME_COUNT = 24;
const FRAME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ANALYSIS_FIELDS = ['shotSize', 'camera', 'content', 'dialogue', 'audio', 'transition', 'note'];

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
    const shotId = rawFrame.shotId;
    const inPoint = rawFrame.inPoint;
    const outPoint = rawFrame.outPoint;
    if (typeof shotId !== 'string' || !FRAME_KEY_PATTERN.test(shotId)
      || ![inPoint, outPoint].every((value) => typeof value === 'number' && Number.isFinite(value))
      || inPoint < 0 || outPoint <= inPoint || outPoint > parameters.videoDuration
      || requestedTime < inPoint || requestedTime >= outPoint) throw new Error('镜头 ID、入出点或代表帧无效');
    if (index > 0 && inPoint < rawFrames[index - 1].outPoint) throw new Error('镜头区间不能重叠或倒序');
    if (rawFrames.slice(0, index).some((frame) => frame.shotId === shotId)) throw new Error('镜头 ID 重复');
    if (rawFrame.analysisError || rawFrame.reviewStatus === 'edited') throw new Error('请先确认缺失结果和人工修改的复核状态');
    const overrideFields = Array.isArray(rawFrame.overrideFields)
      ? [...new Set(rawFrame.overrideFields.filter((field) => ANALYSIS_FIELDS.includes(field)))] : [];
    const aiOriginal = {};
    if (rawFrame.aiOriginal && typeof rawFrame.aiOriginal === 'object') {
      ANALYSIS_FIELDS.forEach((field) => {
        if (typeof rawFrame.aiOriginal[field] === 'string') aiOriginal[field] = rawFrame.aiOriginal[field].slice(0, field === 'content' ? 2000 : 1000);
      });
      aiOriginal.confidence = typeof rawFrame.aiOriginal.confidence === 'number' && Number.isFinite(rawFrame.aiOriginal.confidence)
        ? Math.max(0, Math.min(1, rawFrame.aiOriginal.confidence)) : null;
    }
    return {
      key,
      resourceId,
      requestedTime,
      actualTime,
      frameDuration,
      width,
      height,
      shotId, inPoint, outPoint,
      sampleRole: ['start', 'middle', 'end', 'custom'].includes(rawFrame.sampleRole) ? rawFrame.sampleRole : 'custom',
      reviewStatus: rawFrame.reviewStatus === 'reviewed' ? 'reviewed' : 'unreviewed',
      overrideFields, aiOriginal,
      shotSize: cleanText(rawFrame.shotSize, '未标注', 80),
      camera: cleanText(rawFrame.camera, '未标注', 240),
      content: cleanText(rawFrame.content, '未返回分析', 2000),
      dialogue: cleanText(rawFrame.dialogue, '无法从画面判断', 1000),
      audio: cleanText(rawFrame.audio, '无法从画面判断', 1000),
      transition: cleanText(rawFrame.transition, '切', 80),
      duration: outPoint - inPoint,
      note: cleanText(rawFrame.note, '', 1000),
      confidence: typeof rawFrame.confidence === 'number' && Number.isFinite(rawFrame.confidence)
        ? Math.max(0, Math.min(1, rawFrame.confidence)) : null,
      analysisError: cleanText(rawFrame.analysisError, '', 240),
    };
  });
}

function buildNodeSet(parameters) {
  if (!Number.isFinite(parameters.videoDuration) || parameters.videoDuration <= 0) throw new Error('来源视频时长无效');
  const imageRepresentation = parameters.imageRepresentation === undefined ? 'original' : parameters.imageRepresentation;
  if (!['original', 'lineart'].includes(imageRepresentation)) throw new Error('画面表示无效，必须为原图或线稿');
  if (imageRepresentation === 'lineart' && (!Array.isArray(parameters.frames) || parameters.frames.some((frame) => !frame
    || ![frame.width, frame.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1024)))) {
    throw new Error('线稿图片尺寸无效，请重新转换当前批次');
  }
  const frames = normalizeFrames(parameters);
  const outputMode = parameters.outputMode === 'images' ? 'images' : 'shotlist';
  const imageNodes = frames.map((frame) => ({
    key: frame.key,
    nodeType: 'ai-image',
    resourceId: frame.resourceId,
    representation: imageRepresentation,
    data: {
      label: `${formatTimecode(frame.actualTime)} · ${frame.shotSize}${imageRepresentation === 'lineart' ? ' · 线稿' : ''}`,
      imageWidth: frame.width,
      imageHeight: frame.height,
      frameAnalysis: {
        shotId: frame.shotId,
        inPoint: frame.inPoint,
        outPoint: frame.outPoint,
        sampleRole: frame.sampleRole,
        reviewStatus: frame.reviewStatus,
        overrideFields: frame.overrideFields,
        aiOriginal: frame.aiOriginal,
        requestedTime: frame.requestedTime,
        actualTime: frame.actualTime,
        frameDuration: frame.frameDuration,
        shotSize: frame.shotSize,
        camera: frame.camera,
        content: frame.content,
        dialogue: frame.dialogue,
        audio: frame.audio,
        transition: frame.transition,
        duration: frame.duration,
        note: frame.analysisError ? `${frame.note ? `${frame.note}；` : ''}${frame.analysisError}` : frame.note,
        confidence: frame.confidence,
      },
    },
  }));

  if (outputMode === 'images') return { nodes: imageNodes, edges: [] };

  const shotlistKey = 'shotlist';
  const shotlistRows = frames.map((frame, index) => ({
    id: frame.shotId,
    shotNo: String(index + 1),
    frameKey: frame.key,
    shotSize: frame.shotSize,
    camera: frame.camera,
    content: frame.content,
    dialogue: frame.dialogue,
    audio: frame.audio,
    transition: frame.transition,
    duration: frame.duration,
    frameAnalysis: imageNodes[index].data.frameAnalysis,
    note: frame.analysisError ? `${frame.note ? `${frame.note}；` : ''}${frame.analysisError}` : frame.note,
  }));
  return {
    nodes: [
      ...imageNodes,
      {
        key: shotlistKey,
        nodeType: 'ai-shotlist',
        data: {
          label: `逐帧拉片${imageRepresentation === 'lineart' ? ' · 线稿' : ''} · ${frames.length} 镜`,
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
        ? (input.parameters.imageRepresentation === 'lineart' ? '已生成逐帧线稿节点' : '已生成逐帧原图节点')
        : (input && input.parameters && input.parameters.imageRepresentation === 'lineart' ? '已生成逐帧线稿与分镜表' : '已生成逐帧原图与分镜表'),
    }),
  },
});
