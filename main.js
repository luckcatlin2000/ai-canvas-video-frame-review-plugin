// Plugin-owned translations; serialized field names and user text stay unchanged.
const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];
const MESSAGES = {
    "逐帧拉片必须包含 1-{0} 个画面": ["Frame review requires 1–{0} frames","フレーム分析には1～{0}枚のフレームが必要です","프레임 분석에는 프레임 1~{0}개가 필요합니다"],
    "第 {0} 个画面数据无效": ["Invalid data for frame {0}","フレーム{0}のデータが無効です","프레임 {0}의 데이터가 올바르지 않습니다"],
    "画面 key 无效或重复": ["Invalid or duplicate frame key","フレームkeyが無効か重複しています","프레임 key가 올바르지 않거나 중복됩니다"],
    "画面 {0} 缺少派生资源": ["Frame {0} is missing its derived resource","フレーム{0}の派生リソースがありません","프레임 {0}에 파생 리소스가 없습니다"],
    "镜头 ID、入出点或代表帧无效": ["Invalid shot ID, range or representative frame","ショットID、範囲または代表フレームが無効です","샷 ID, 구간 또는 대표 프레임이 올바르지 않습니다"],
    "镜头区间不能重叠或倒序": ["Shot ranges cannot overlap or be reversed","ショット範囲は重複・逆順にできません","샷 구간은 겹치거나 역순일 수 없습니다"],
    "镜头 ID 重复": ["Duplicate shot ID","ショットIDが重複しています","샷 ID가 중복됩니다"],
    "请先确认缺失结果和人工修改的复核状态": ["Confirm missing results and manual edits before continuing","不足した結果と手動編集の確認を完了してください","누락된 결과와 수동 수정의 검토 상태를 먼저 확인하세요"],
    "未标注": ["Unspecified","未指定","미지정"],
    "未返回分析": ["No analysis returned","分析結果なし","분석 결과 없음"],
    "无法从画面判断": ["Cannot determine from the image","画面からは判断できません","화면만으로 판단할 수 없음"],
    "切": ["Cut","カット","컷"],
    "来源视频时长无效": ["Invalid source video duration","元動画の長さが無効です","원본 영상 길이가 올바르지 않습니다"],
    "画面表示无效，必须为原图或线稿": ["Representation must be original or line art","表示形式は元画像または線画にしてください","표현 방식은 원본 또는 선화여야 합니다"],
    "线稿图片尺寸无效，请重新转换当前批次": ["Invalid line-art size. Convert the current batch again.","線画サイズが無効です。現在のバッチを再変換してください。","선화 크기가 올바르지 않습니다. 현재 배치를 다시 변환하세요."],
    "{0} · 线稿": ["{0} · Line art","{0} · 線画","{0} · 선화"],
    "逐帧拉片 · {0} 镜": ["Frame Review · {0} shots","フレーム分析 · {0}ショット","프레임 분석 · 샷 {0}개"],
    "逐帧拉片 · 线稿 · {0} 镜": ["Frame Review · Line art · {0} shots","フレーム分析 · 線画 · {0}ショット","프레임 분석 · 선화 · 샷 {0}개"],
    "已生成逐帧线稿节点": ["Line-art nodes created","線画ノードを生成しました","선화 노드가 생성되었습니다"],
    "已生成逐帧原图节点": ["Original image nodes created","元画像ノードを生成しました","원본 이미지 노드가 생성되었습니다"],
    "已生成逐帧线稿与分镜表": ["Line-art nodes and storyboard created","線画ノードと絵コンテを生成しました","선화 노드와 스토리보드가 생성되었습니다"],
    "已生成逐帧原图与分镜表": ["Original image nodes and storyboard created","元画像ノードと絵コンテを生成しました","원본 이미지 노드와 스토리보드가 생성되었습니다"]
  };
  const normalizeLocale = (value) => LOCALES.includes(value) ? value : 'zh-CN';
  const messagePatterns = Object.keys(MESSAGES).filter((key) => /\{\d+\}/.test(key)).map((key) => {
    const parts = key.split(/(\{\d+\})/);
    const slots = [];
    const pattern = parts.map((part) => {
      if (/^\{\d+\}$/.test(part)) { slots.push(part); return '(.+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { key, slots, pattern: new RegExp('^' + pattern + '$', 's') };
  }).sort((a, b) => b.key.replace(/\{\d+\}/g, '').length - a.key.replace(/\{\d+\}/g, '').length);
  function translate(text, locale, depth = 0) {
    if (typeof text !== 'string' || normalizeLocale(locale) === 'zh-CN') return text;
    const index = LOCALES.indexOf(locale) - 1;
    if (Object.prototype.hasOwnProperty.call(MESSAGES, text)) return MESSAGES[text][index];
    if (depth > 3) return text;
    for (const entry of messagePatterns) {
      const match = entry.pattern.exec(text);
      if (!match) continue;
      return MESSAGES[entry.key][index].replace(/\{\d+\}/g, (slot) => {
        const value = match[entry.slots.indexOf(slot) + 1];
        return translate(value, locale, depth + 1);
      });
    }
    return text;
  }
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

function normalizeFrames(parameters, locale = 'zh-CN') {
  const t = (text) => translate(text, locale);
  const rawFrames = Array.isArray(parameters.frames) ? parameters.frames : [];
  if (rawFrames.length < 1 || rawFrames.length > MAX_FRAME_COUNT) {
    throw new Error(t(`逐帧拉片必须包含 1-${MAX_FRAME_COUNT} 个画面`));
  }

  const keys = new Set();
  return rawFrames.map((rawFrame, index) => {
    if (!rawFrame || typeof rawFrame !== 'object' || Array.isArray(rawFrame)) {
      throw new Error(t(`第 ${index + 1} 个画面数据无效`));
    }
    const key = typeof rawFrame.key === 'string' ? rawFrame.key : '';
    const resourceId = typeof rawFrame.resourceId === 'string' ? rawFrame.resourceId.trim() : '';
    if (!FRAME_KEY_PATTERN.test(key) || keys.has(key)) throw new Error(t('画面 key 无效或重复'));
    if (!resourceId) throw new Error(t(`画面 ${key} 缺少派生资源`));
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
      || requestedTime < inPoint || requestedTime >= outPoint) throw new Error(t('镜头 ID、入出点或代表帧无效'));
    if (index > 0 && inPoint < rawFrames[index - 1].outPoint) throw new Error(t('镜头区间不能重叠或倒序'));
    if (rawFrames.slice(0, index).some((frame) => frame.shotId === shotId)) throw new Error(t('镜头 ID 重复'));
    if (rawFrame.analysisError || rawFrame.reviewStatus === 'edited') throw new Error(t('请先确认缺失结果和人工修改的复核状态'));
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
      shotSize: cleanText(rawFrame.shotSize, t('未标注'), 80),
      camera: cleanText(rawFrame.camera, t('未标注'), 240),
      content: cleanText(rawFrame.content, t('未返回分析'), 2000),
      dialogue: cleanText(rawFrame.dialogue, t('无法从画面判断'), 1000),
      audio: cleanText(rawFrame.audio, t('无法从画面判断'), 1000),
      transition: cleanText(rawFrame.transition, t('切'), 80),
      duration: outPoint - inPoint,
      note: cleanText(rawFrame.note, '', 1000),
      confidence: typeof rawFrame.confidence === 'number' && Number.isFinite(rawFrame.confidence)
        ? Math.max(0, Math.min(1, rawFrame.confidence)) : null,
      analysisError: cleanText(rawFrame.analysisError, '', 240),
    };
  });
}

function buildNodeSet(parameters, locale = 'zh-CN') {
  const t = (text) => translate(text, locale);
  if (!Number.isFinite(parameters.videoDuration) || parameters.videoDuration <= 0) throw new Error(t('来源视频时长无效'));
  const imageRepresentation = parameters.imageRepresentation === undefined ? 'original' : parameters.imageRepresentation;
  if (!['original', 'lineart'].includes(imageRepresentation)) throw new Error(t('画面表示无效，必须为原图或线稿'));
  if (imageRepresentation === 'lineart' && (!Array.isArray(parameters.frames) || parameters.frames.some((frame) => !frame
    || ![frame.width, frame.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1024)))) {
    throw new Error(t('线稿图片尺寸无效，请重新转换当前批次'));
  }
  const frames = normalizeFrames(parameters, locale);
  const outputMode = parameters.outputMode === 'images' ? 'images' : 'shotlist';
  const imageNodes = frames.map((frame) => ({
    key: frame.key,
    nodeType: 'ai-image',
    resourceId: frame.resourceId,
    representation: imageRepresentation,
    data: {
      label: t(`${formatTimecode(frame.actualTime)} · ${frame.shotSize}${imageRepresentation === 'lineart' ? ' · 线稿' : ''}`),
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
          label: t(`逐帧拉片${imageRepresentation === 'lineart' ? ' · 线稿' : ''} · ${frames.length} 镜`),
          shotlistRows,
        },
      },
    ],
    edges: frames.map((frame) => ({ sourceKey: frame.key, targetKey: shotlistKey })),
  };
}

definePlugin({
  tools: {
    'video-frame-review': (input) => {
      const locale = normalizeLocale(input && input.locale);
      const t = (text) => translate(text, locale);
      return {
        data: buildNodeSet(input && input.parameters ? input.parameters : {}, locale),
        message: input && input.parameters && input.parameters.outputMode === 'images'
          ? (input.parameters.imageRepresentation === 'lineart' ? t('已生成逐帧线稿节点') : t('已生成逐帧原图节点'))
          : (input && input.parameters && input.parameters.imageRepresentation === 'lineart' ? t('已生成逐帧线稿与分镜表') : t('已生成逐帧原图与分镜表')),
      };
    },
  },
});
