(function () {
  const MAX_FRAMES = 24;
  const MAX_SHOTS = 128;
  const FIELDS = ['shotSize', 'camera', 'content', 'dialogue', 'audio', 'transition', 'note'];
  const LABELS = ['景别', '运镜', '画面内容', '台词', '声音', '转场', '备注'];
  const DEFAULT_PROMPT = '依据画面分析景别、运镜、内容与转场。不臆测台词或声音；无法确认时写“无法从画面判断”。';
  function formatTimecode(time) {
    const ms = Math.max(0, Math.round(Number(time || 0) * 1000));
    return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60]
      .map((part) => String(part).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
  }
  function parseTimecode(raw) {
    if (!String(raw).trim() || !/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(String(raw).trim())) return NaN;
    const parts = String(raw).trim().split(':').map(Number);
    if (parts.some((part, i) => !Number.isFinite(part) || part < 0 || (i > 0 && part >= 60))) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  function sampleTime(shot) {
    if (shot.role === 'custom') return shot.customTime;
    if (shot.role === 'middle') return (shot.inPoint + shot.outPoint) / 2;
    if (shot.role === 'end') return shot.outPoint - Math.min(0.000001, (shot.outPoint - shot.inPoint) / 2);
    return shot.inPoint;
  }
  function filmstripState(shots, time, cursorTime) {
    const shot = shots.find((value) => time >= value.inPoint && time < value.outPoint);
    return {
      shotId: shot ? shot.id : '',
      selected: Boolean(shot && shot.selected),
      current: Number.isFinite(cursorTime) && Math.abs(time - cursorTime) < 0.000001,
    };
  }
  function filmstripFocusIndex(previews, time) {
    if (!previews.length) return -1;
    if (!Number.isFinite(time)) return 0;
    return previews.reduce((closest, frame, index) =>
      Math.abs(frame.actualTime - time) < Math.abs(previews[closest].actualTime - time) ? index : closest, 0);
  }
  function validateShots(shots, duration) {
    if (!shots.length || shots.length > MAX_SHOTS) throw new Error('镜头数量必须为 1–128');
    const ids = new Set();
    shots.forEach((shot, i) => {
      if (ids.has(shot.id)) throw new Error('镜头 ID 重复');
      ids.add(shot.id);
      if (![shot.inPoint, shot.outPoint].every(Number.isFinite) || shot.inPoint < 0 || shot.outPoint > duration
        || shot.outPoint <= shot.inPoint || (i && shot.inPoint < shots[i - 1].outPoint - 1e-8)) {
        throw new Error('镜头区间必须有序、不重叠且位于视频范围内');
      }
      const time = sampleTime(shot);
      if (!Number.isFinite(time) || time < shot.inPoint || time >= shot.outPoint) throw new Error('代表帧必须位于镜头区间内');
    });
    if (shots.filter((shot) => shot.selected).length > MAX_FRAMES) throw new Error('每批最多选择 24 镜');
    return shots;
  }
  function splitShot(shots, id, time, newId) {
    if (shots.length >= MAX_SHOTS) throw new Error('最多保留 128 个镜头');
    return shots.flatMap((shot) => {
      if (shot.id !== id) return [{ ...shot }];
      if (!Number.isFinite(time) || time <= shot.inPoint || time >= shot.outPoint) throw new Error('拆分点必须在镜头内部');
      return [{ ...shot, outPoint: time, role: 'middle' },
        { ...shot, id: newId, inPoint: time, role: 'middle', selected: false }];
    });
  }
  function mergeShots(shots) {
    const indices = shots.map((shot, i) => shot.selected ? i : -1).filter((i) => i >= 0);
    if (indices.length < 2) throw new Error('请勾选至少两个相邻镜头');
    const first = indices[0], last = indices[indices.length - 1];
    if (last - first + 1 !== indices.length
      || indices.slice(1).some((i) => Math.abs(shots[i].inPoint - shots[i - 1].outPoint) > 1e-8)) {
      throw new Error('只能合并连续相邻镜头');
    }
    return [...shots.slice(0, first), { ...shots[first], outPoint: shots[last].outPoint, role: 'middle' }, ...shots.slice(last + 1)];
  }
  function moveBoundary(shots, index, edge, time) {
    const next = shots.map((shot) => ({ ...shot }));
    const shot = next[index];
    if (!shot || !Number.isFinite(time)) throw new Error('镜头边界无效');
    const neighbor = next[index + (edge === 'inPoint' ? -1 : 1)];
    const oldBoundary = shot[edge];
    shot[edge] = time;
    shot.role = 'middle';
    if (neighbor && Math.abs(neighbor[edge === 'inPoint' ? 'outPoint' : 'inPoint'] - oldBoundary) < 1e-8) {
      neighbor[edge === 'inPoint' ? 'outPoint' : 'inPoint'] = time;
      neighbor.role = 'middle';
    }
    return next;
  }
  function parseAnalysisJson(text) {
    const source = String(text || '').trim();
    const start = source.indexOf('{'), end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象，已保留抽帧，可人工填写');
    const value = JSON.parse(source.slice(start, end + 1));
    if (!value || !Array.isArray(value.frames)) throw new Error('模型 JSON 缺少 frames');
    const keys = new Set();
    value.frames.forEach((frame) => {
      if (!frame || typeof frame.key !== 'string' || keys.has(frame.key)) throw new Error('模型返回重复或无效的画面 key');
      keys.add(frame.key);
    });
    return value.frames;
  }
  function mergeAnalysis(result, analysis) {
    const original = {};
    FIELDS.forEach((key) => { original[key] = typeof analysis[key] === 'string' ? analysis[key].trim().slice(0, key === 'content' ? 2000 : 1000) : ''; });
    original.confidence = typeof analysis.confidence === 'number' && Number.isFinite(analysis.confidence)
      && analysis.confidence >= 0 && analysis.confidence <= 1 ? analysis.confidence : null;
    const next = { ...result, aiOriginal: original, confidence: original.confidence };
    FIELDS.forEach((key) => { if (!result.overrideFields.includes(key)) next[key] = original[key]; });
    next.analysisError = next.content ? '' : '模型未返回画面内容，请人工填写并确认';
    // 人工确认只对当前版本有效；模型重试改动非覆盖字段后需重新复核。
    next.reviewStatus = result.overrideFields.length ? 'edited' : 'unreviewed';
    return next;
  }
  function publicFrame(frame) {
    const data = {};
    ['key', 'shotId', 'inPoint', 'outPoint', 'sampleRole', 'requestedTime', 'actualTime', 'frameDuration',
      'duration', 'confidence', 'reviewStatus', 'overrideFields', 'aiOriginal', 'analysisError', ...FIELDS]
      .forEach((key) => { if (frame[key] !== undefined) data[key] = frame[key]; });
    return data;
  }
  function csvCell(value) {
    let text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    if (/^\s*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function reportCsv(report) {
    const columns = ['sourceVideoNodeId', 'sourceVideoName', 'shotId', 'inPoint', 'outPoint', 'duration',
      'sampleRole', 'requestedTime', 'actualTime', 'frameDuration', ...FIELDS, 'confidence', 'reviewStatus', 'overrideFields', 'aiOriginal', 'analysisError'];
    return '\uFEFF' + [columns.map(csvCell).join(','), ...report.frames.map((frame) =>
      columns.map((key) => csvCell(key === 'sourceVideoNodeId' ? report.source.nodeId : key === 'sourceVideoName' ? report.source.name : frame[key])).join(','))].join('\r\n');
  }
  async function readSourceVideo(resource, read, isDisposed, onProgress) {
    if (!resource || !String(resource.mediaType).startsWith('video/') || !Number.isSafeInteger(resource.size) || resource.size <= 0) {
      throw new Error('当前节点没有可播放的视频资源');
    }
    if (resource.size > 16 * 1024 * 1024) throw new Error('原视频超过 16 MiB，仍可使用胶片和逐帧检查');
    // Base64 需低于宿主单字符串 256,000 字符上限，分段仅在此会话内组装。
    const parts = [], chunkBytes = 180 * 1024;
    for (let offset = 0; offset < resource.size; offset += chunkBytes) {
      if (isDisposed()) throw new Error('界面已关闭');
      const length = Math.min(chunkBytes, resource.size - offset);
      const result = await read({ type: 'resource.readRange', resourceId: resource.resourceId, offset, length });
      if (isDisposed()) throw new Error('界面已关闭');
      if (!result || result.offset !== offset || result.bytes !== length || typeof result.base64 !== 'string'
        || result.base64.length !== Math.ceil(length / 3) * 4
        || !result.resource || result.resource.resourceId !== resource.resourceId || result.resource.size !== resource.size) {
        throw new Error('原视频读取不完整，请关闭后重新打开');
      }
      const binary = atob(result.base64);
      if (binary.length !== length) throw new Error('原视频数据长度不匹配');
      parts.push(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
      onProgress(Math.round((offset + length) / resource.size * 100));
    }
    return new Blob(parts, { type: resource.mediaType });
  }
  const logic = { parseTimecode, sampleTime, filmstripState, filmstripFocusIndex, validateShots, splitShot, mergeShots, moveBoundary, parseAnalysisJson, mergeAnalysis, publicFrame, reportCsv, readSourceVideo };
  window.__AI_CANVAS_PLUGIN_HOST__.exports.FrameReviewLogic = logic;

  window.__AI_CANVAS_PLUGIN_HOST__.exports.VideoFrameReview = function mount(root, props) {
    let disposed = false, serial = 0, sourceVideoUrl = '';
    const prefix = 'shot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '-';
    const newId = () => prefix + (++serial);
    const state = { video: null, previews: [], shots: [], activeId: '', cursor: null, results: [], batch: null, sampling: 'interval',
      busy: false, loadingMessage: '', mode: 'interval', deckFlat: false, history: [], redo: [] };
    let appliedSamplingSignature = '';
    const videoResource = (props.resources && props.resources.self || []).find((r) => String(r.mediaType || '').startsWith('video/'));
    const sourceName = String(props.node && props.node.data && props.node.data.label || videoResource && videoResource.displayName || '来源视频').slice(0, 240);
    root.innerHTML = [
      '<style>',
      ':root{color-scheme:dark;--bg:#0d0d12;--panel:#191920;--card:#24242e;--inset:#121218;--line:#34343f;--edge:#51515f;--text:#ededf3;--muted:#a8a7b8;--soft:#858495;--accent:#8776e9;--accent2:#c7bbff;--on-accent:#fff;--danger:#ff8a9a;--success:#91bcae;--shadow:0 18px 45px rgba(0,0,0,.24)}',
      ':root[data-theme="light"]{color-scheme:light;--bg:#eeedf3;--panel:#faf9fc;--card:#e7e4f0;--inset:#f1eff6;--line:#d6d2df;--edge:#b5aebf;--text:#36313f;--muted:#736c80;--soft:#847c90;--accent:#7462cc;--accent2:#6553b6;--on-accent:#fff;--danger:#b7465a;--success:#547d6e;--shadow:0 18px 45px rgba(66,54,89,.09)}',
      '*{box-sizing:border-box;scrollbar-width:none} *::-webkit-scrollbar{display:none;width:0;height:0} html,body,#root{width:100%;height:100%;min-width:0;margin:0} body{overflow:auto;background:var(--bg);color:var(--text);font:13px "Segoe UI","Microsoft YaHei",sans-serif}',
      'button,input,select,textarea{font:inherit;color:inherit} button{cursor:pointer} button:disabled{opacity:.42;cursor:not-allowed} .app [hidden]{display:none}',
      '.app{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;background:var(--bg)} .workspace{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:16px}',
      '.studio{display:grid;grid-template-columns:minmax(0,1fr) 350px;grid-template-rows:minmax(280px,1fr) 238px;gap:14px;height:calc(100% - 2px);min-height:610px;max-height:880px} .panel{min-width:0}',
      '.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px} .section-title{display:flex;align-items:center;gap:8px;min-width:0} h3{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em} .eyebrow{font-size:11px;color:var(--soft)} .pill{border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:11px;color:var(--muted);white-space:nowrap}',
      '.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center} .spaced{margin-top:8px} .hint{color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere} .error{color:var(--danger)} .subtle{font-size:11px;color:var(--soft)} .step{font-size:11px;font-variant-numeric:tabular-nums;color:var(--accent2)}',
      'button{min-height:28px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12px;line-height:18px;background:var(--panel);transition:background .16s,border-color .16s,transform .16s} button:hover:not(:disabled){border-color:var(--edge);background:var(--card)} button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}',
      '.active{border-color:color-mix(in srgb,var(--accent) 50%,var(--line));color:var(--accent2);background:color-mix(in srgb,var(--accent) 13%,var(--panel))} .primary{border-color:var(--accent);color:var(--on-accent);background:var(--accent);font-weight:600} .primary:hover:not(:disabled){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 88%,var(--text))} .quiet{border-color:transparent;background:transparent;color:var(--muted)}',
      'label{display:flex;flex-direction:column;gap:7px;color:var(--muted);font-size:12px;min-width:0} input,select,textarea{width:100%;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--inset);padding:4px 8px;font-size:12px} input,select{height:28px} textarea{resize:vertical;min-height:70px;line-height:1.7} input[type=checkbox]{width:14px;height:14px;flex-shrink:0;accent-color:var(--accent)} select option{background:var(--panel);color:var(--text)} input:focus-visible,select:focus-visible,textarea:focus-visible{outline:1px solid var(--accent);outline-offset:1px}',
      '.source-panel{grid-column:1;grid-row:1;display:flex;flex-direction:column;min-height:0;padding:12px;border:1px solid var(--line);border-radius:22px;background:var(--panel);overflow:hidden} .viewer-toolbar{margin:0 2px 10px;flex-wrap:nowrap} .viewer-tabs{display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--inset);border:1px solid var(--line)} .viewer-tabs button{min-height:26px;white-space:nowrap;padding:3px 12px;background:transparent;border-color:transparent;border-radius:999px} .viewer-tabs [aria-pressed="true"]{background:var(--card);color:var(--text);box-shadow:0 1px 3px color-mix(in srgb,var(--bg) 50%,transparent)}',
      '.viewer-stage{position:relative;flex:1;min-height:0;overflow:hidden;border-radius:12px;background:var(--inset)} .video-view,.still-view{height:100%;min-height:0} .source-video{display:block;width:100%;height:100%;object-fit:contain;background:var(--inset)} .inspector{width:100%;height:100%;object-fit:contain;display:block} .inspect-empty{height:100%;display:grid;place-content:center;text-align:center;gap:10px;color:var(--soft);font-size:12px} .inspect-empty span:first-child{font-size:32px;color:var(--edge)} .viewer-caption{position:absolute;bottom:12px;left:12px;border:1px solid var(--edge);background:var(--panel);color:var(--text);border-radius:7px;padding:5px 8px;font-size:11px;font-variant-numeric:tabular-nums}',
      '.source-meta{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 2px 0;min-width:0} .source-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);flex:0 1 55%;margin:0;font-size:11px} .source-meta [data-source-status]{margin:0;font-size:10px;text-align:right;color:var(--soft);flex:1}',
      '.film-panel{grid-column:1;grid-row:2;display:flex;flex-direction:column;padding:0;min-width:0;overflow:hidden} .film-panel .section-head{margin:0 4px 0} .film-panel h3{font-size:12px} .film-tools{display:flex;gap:2px;align-items:center;padding:2px;border:1px solid var(--line);border-radius:999px;background:var(--panel)} .film-tools button{border-color:transparent;background:transparent;border-radius:999px;min-width:28px;min-height:24px;padding:2px 8px} .film-tools [aria-pressed="true"]{color:var(--accent2);background:var(--card)} .film-help{margin:0 4px;font-size:10px;color:var(--soft)}',
      '.filmstrip{display:flex;gap:0;min-width:0;width:100%;overflow-x:auto;overscroll-behavior-x:contain;padding:15px 18px 16px;isolation:isolate;justify-content:safe center;scroll-padding-inline:20px;background:radial-gradient(ellipse at 50% 80%,color-mix(in srgb,var(--accent) 7%,transparent),transparent 68%)} .frame{position:relative;flex:0 0 146px;height:162px;min-height:162px;margin-right:-46px;overflow:hidden;padding:3px;display:flex;flex-direction:column;gap:0;border:1px solid var(--edge);border-radius:10px;background:var(--card);box-shadow:2px 1px 0 var(--line),4px 2px 0 var(--inset),6px 12px 18px color-mix(in srgb,var(--bg) 80%,transparent),inset 0 1px 0 color-mix(in srgb,var(--text) 16%,transparent);transform:perspective(850px) rotateY(-40deg) translateY(3px);transform-origin:center;transition:transform .24s,box-shadow .24s,border-color .2s;z-index:1} .frame::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:linear-gradient(110deg,color-mix(in srgb,var(--text) 10%,transparent),transparent 15%,transparent 96%,color-mix(in srgb,var(--text) 12%,transparent))} .frame:last-child{margin-right:0} .frame img{width:100%;height:126px;object-fit:contain;background:var(--inset);border-radius:7px 7px 3px 3px;pointer-events:none} .frame-time{padding:7px 2px 2px;font-size:10px;font-variant-numeric:tabular-nums;color:var(--muted);letter-spacing:.02em}',
      '.frame--before{transform:perspective(850px) rotateY(40deg) translateY(3px)} .frame--focus,.frame:focus-visible{transform:perspective(850px) rotateY(0) translateY(-3px);z-index:4;border-color:var(--accent2);background:var(--card);box-shadow:2px 2px 0 var(--line),0 12px 26px color-mix(in srgb,var(--bg) 85%,transparent)} .frame:not(.frame--focus):hover:not(:disabled){border-color:var(--text)} .frame:focus-visible{z-index:5} .frame--unselected img{opacity:.58} .frame-index,.frame-selection,.frame-current{position:absolute;z-index:1;background:var(--inset);color:var(--text);font-size:10px;line-height:16px;padding:0 4px;border-radius:4px} .frame-index{top:7px;left:7px;font-variant-numeric:tabular-nums} .frame-selection{top:7px;right:7px} .frame--selected .frame-selection{color:var(--accent2)} .frame-current{bottom:34px;left:7px;color:var(--accent2)} .filmstrip--flat{gap:8px} .filmstrip--flat .frame{margin:0;transform:none;flex-basis:146px} .filmstrip--flat .frame--focus{border-color:var(--accent2)}',
      '.control-panel{grid-column:2;grid-row:1/3;display:flex;flex-direction:column;min-height:0;overflow:hidden;border:1px solid color-mix(in srgb,var(--edge) 60%,var(--line));border-radius:22px;background:linear-gradient(155deg,color-mix(in srgb,var(--accent) 9%,var(--panel)),var(--panel) 42%);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--text) 7%,transparent),var(--shadow)} .control-header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:18px 18px 14px} .control-header strong{font-size:14px;font-weight:600} .control-header .pill{font-size:10px;border:0;background:var(--card)}',
      '.workflow-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 14px 4px;padding:4px;gap:3px;background:var(--inset);border:1px solid var(--line);border-radius:12px} .workflow-tabs button{display:flex;align-items:center;justify-content:center;gap:6px;min-height:34px;border-color:transparent;background:transparent;color:var(--soft);border-radius:8px} .workflow-tabs button span{font-size:10px;font-variant-numeric:tabular-nums;opacity:.75} .workflow-tabs [aria-selected="true"]{background:var(--card);color:var(--text);border-color:var(--line);box-shadow:0 2px 4px color-mix(in srgb,var(--bg) 30%,transparent)}',
      '.workflow-body{flex:1;min-height:0;overflow:auto;padding:18px;display:flex;flex-direction:column} .workflow-page{display:flex;flex-direction:column;min-height:100%;gap:14px} .workflow-page .section-head{margin-bottom:0} .workflow-page h3{font-size:20px;letter-spacing:.02em;font-weight:600} .stage-description{margin:0;color:var(--soft);font-size:11px;line-height:1.7} .stage-next{width:100%;min-height:36px;margin-top:auto;text-align:left;display:flex;align-items:center;justify-content:space-between;border-color:var(--line);background:var(--card)} .stage-next span{color:var(--accent2)}',
      '.tabs{display:flex;gap:3px;padding:3px;border:1px solid var(--line);border-radius:10px;background:var(--inset)} .tabs button{flex:1;min-width:0;padding:4px;border-color:transparent;background:transparent;border-radius:7px;font-size:11px;white-space:nowrap} .tabs .active{background:var(--card);color:var(--accent2);border-color:var(--line)} .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px} .fields [data-group="step"]{grid-column:1/-1} .fields input{height:34px} .sampling-apply{display:flex;align-items:center;gap:10px;flex-wrap:wrap} .sampling-apply button{height:32px} .sampling-apply .hint{font-size:11px} .sampling-note{padding:12px;border-radius:12px;background:var(--inset);border:1px solid var(--line);color:var(--soft);font-size:11px;line-height:1.8}',
      '.correction-panel{gap:10px} .correction-panel h3{font-size:18px} .shot-tools{gap:4px} .shot-tools button{font-size:11px;padding-inline:6px} .shot-list{max-height:174px;min-height:74px;overflow:auto;min-width:0;border:1px solid var(--line);border-radius:10px;background:var(--inset)} .shot{display:flex;gap:5px;align-items:center;margin:0;padding:4px 6px;border:0;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);border-radius:0;background:transparent} .shot:last-child{border-bottom:0} .shot.active{background:var(--card);box-shadow:inset 2px 0 0 var(--accent)} .shot button{flex:1;min-width:0;text-align:left;overflow-wrap:anywhere;border-color:transparent;background:transparent;padding:2px 3px;font-size:11px} .shot select{width:63px;background:transparent;border-color:transparent;padding-inline:2px;font-size:11px} .shot select:hover{border-color:var(--line)} .shot small{display:block;color:var(--soft);margin-top:2px;font-size:9px;font-variant-numeric:tabular-nums;line-height:1.5}',
      '.inspect-controls{padding-top:10px;border-top:1px solid var(--line)} .inspect-controls .section-head{margin-bottom:9px} .inspect-controls h4{margin:0;font-size:12px;font-weight:500} .cursor-input{flex:1;min-width:40px;max-width:110px;font-variant-numeric:tabular-nums} .inspect-controls .row{gap:4px} .inspect-controls button{font-size:11px;padding-inline:6px} .boundary-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-top:6px} .inspect-controls .hint{font-size:10px;margin:6px 0 0}',
      '.batch-summary{display:flex;align-items:center;gap:13px;padding:12px 14px;background:color-mix(in srgb,var(--accent) 8%,var(--inset));border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:12px} .batch-count{font-size:30px;line-height:1.1;font-weight:500;letter-spacing:-.05em;font-variant-numeric:tabular-nums;color:var(--accent2)} .batch-caption{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text)} .batch-caption small{font-size:10px;color:var(--soft)} .analysis-grid{display:flex;flex-direction:column;gap:15px} .analysis-grid select{height:36px} .analysis-grid textarea{min-height:130px;padding:10px;line-height:1.8;font-size:12px} .analysis-actions{display:flex;flex-direction:column;gap:7px;margin-top:auto;padding-top:4px} .analysis-actions .primary{min-height:40px;border-radius:10px;box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 13%,transparent)} .analysis-actions .quiet{font-size:11px} .analysis-summary{display:block;color:var(--muted);font-size:11px;line-height:1.6;min-height:18px} .analysis-hint{font-size:10px;color:var(--soft);line-height:1.65;margin:0} .control-footer{display:flex;gap:6px;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--line);font-size:10px;color:var(--soft)} .control-footer button{font-size:11px;min-height:26px}',
      '.results-section{padding-top:24px;scroll-margin-top:12px} .results-heading{margin:0 2px 12px} .results{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:12px} .result{border:1px solid var(--line);border-radius:16px;overflow:hidden;min-width:0;background:var(--panel)} .result img{width:100%;height:180px;object-fit:contain;background:var(--inset)} .result-body{padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px} .wide{grid-column:1/-1} .empty{padding:14px 8px;color:var(--muted);text-align:center;font-size:12px}',
      '.result-preview{position:relative;min-height:180px} .result-loading{position:absolute;inset:0;display:grid;place-items:center;background:color-mix(in srgb,var(--bg) 65%,transparent)} .result-progress{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:8px;background:var(--card);padding:8px;margin-bottom:8px} .spinner{width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:frame-review-spin .8s linear infinite} @keyframes frame-review-spin{to{transform:rotate(360deg)}} @media(prefers-reduced-motion:reduce){.spinner{animation:none}}',
      '.status--busy{display:flex;align-items:center;gap:6px} .status--busy::before{content:"";width:12px;height:12px;flex-shrink:0;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:frame-review-spin .8s linear infinite} @media(prefers-reduced-motion:reduce){.status--busy::before{animation:none} .frame,button{transition:none}}',
      'footer{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;flex-shrink:0;padding:6px 12px;border-top:1px solid var(--line);background:var(--panel);max-height:38%;overflow:auto} .footer-actions{flex:0 1 auto;justify-content:flex-end;margin-left:auto} .status{flex:1 1 220px;min-width:0;margin:0;overflow-wrap:anywhere;font-size:11px}',
      '@media(max-width:1120px){.studio{grid-template-columns:minmax(0,1fr) 320px;gap:12px} .workspace{padding:12px} .workflow-body{padding:14px} .source-meta [data-source-status]{font-size:10px}}',
      '@media(max-width:900px){.studio{height:auto;min-height:0;max-height:none;grid-template-columns:minmax(0,1fr);grid-template-rows:340px 238px auto} .control-panel{grid-column:1;grid-row:3} .workflow-body{overflow:visible} .workflow-page{min-height:0} .analysis-grid{display:grid;grid-template-columns:minmax(0,.7fr) minmax(0,1.3fr)} .analysis-grid textarea{min-height:100px} .analysis-actions{display:grid;grid-template-columns:1fr auto;align-items:center} .analysis-actions .analysis-summary{grid-column:1/-1} .shot-list{max-height:185px} .source-meta [data-source-status]{display:block} .stage-next{margin-top:6px}}',
      '@media(max-width:480px){.workspace{padding:8px} .studio{grid-template-rows:300px 234px auto;gap:12px} .source-panel{padding:9px;border-radius:16px} .viewer-toolbar{gap:4px} .viewer-toolbar h3{font-size:12px} .viewer-tabs button{font-size:11px;padding-inline:8px} .source-meta [data-source-status]{font-size:10px} .source-meta{align-items:flex-start;flex-direction:column;gap:4px} .source-meta [data-source-status]{text-align:left} .source-name{flex-basis:auto;max-width:100%} .frame{flex-basis:132px;margin-right:-27px} .film-panel .eyebrow{display:none} .control-panel{border-radius:16px} .analysis-grid{display:flex} .analysis-actions{display:flex} .workflow-body{padding:16px} .film-help{font-size:9px} .footer-actions{gap:4px} footer button{font-size:11px;padding-inline:6px}}',
      '</style>',
      '<main class="app"><div class="workspace"><div class="studio">',
      '<section class="panel source-panel"><div class="section-head viewer-toolbar"><div class="section-title"><h3>画面预览</h3></div><div class="viewer-tabs" aria-label="预览方式"><button data-viewer="video" aria-pressed="true">原视频</button><button data-viewer="frame" aria-pressed="false">当前帧</button></div></div><div class="viewer-stage"><div class="video-view" data-video-view><video data-source-video class="source-video" controls playsinline preload="metadata" aria-label="原视频播放器"></video></div><div class="still-view" data-still-view hidden><img data-inspector class="inspector" alt="当前帧预览" hidden><div data-inspector-empty class="inspect-empty"><span aria-hidden="true">▧</span><span>点击下方胶片或右侧镜头<br>在这里检查实际画面</span></div><span data-viewer-caption class="viewer-caption" hidden></span></div></div><div class="source-meta"><p data-source-name class="source-name"></p><p data-source-status class="hint" role="status">正在加载原视频…</p></div></section>',
      '<section class="panel film-panel"><div class="section-head"><div class="section-title"><h3>视频胶片</h3><span class="eyebrow">预览序列 · 点击定位</span></div><div class="film-tools"><button data-view aria-pressed="true" title="切换立体或平铺胶片">立体</button><button data-left aria-label="向左浏览缩略图">←</button><button data-right aria-label="向右浏览缩略图">→</button></div></div><div data-filmstrip class="filmstrip" tabindex="0" aria-label="视频胶片横向浏览"></div><p class="film-help">✓ 表示所属镜头已选 · 点击只定位，勾选请在「校正」中调整。</p></section>',
      '<aside class="control-panel" aria-label="镜头参数"><div class="control-header"><strong>镜头工作台</strong><span data-workflow-count class="pill">准备镜头</span></div><div class="workflow-tabs" role="tablist" aria-label="拉片步骤"><button id="sampling-tab" role="tab" aria-selected="true" aria-controls="sampling-panel" data-workflow-tab="sampling"><span>01</span>采样</button><button id="correction-tab" role="tab" aria-selected="false" aria-controls="correction-panel" tabindex="-1" data-workflow-tab="correction"><span>02</span>校正</button><button id="analysis-tab" role="tab" aria-selected="false" aria-controls="analysis-panel" tabindex="-1" data-workflow-tab="analysis"><span>03</span>分析</button></div><div class="workflow-body">',
      '<section class="panel workflow-page" data-stage="sampling" id="sampling-panel" role="tabpanel" aria-labelledby="sampling-tab"><div class="section-head"><h3>从视频建立镜头</h3></div><p class="stage-description">确定采样范围，再挑选每个镜头的代表画面。</p><div class="tabs"><button data-mode="interval" class="active">固定间隔</button><button data-mode="manual">指定帧</button><button data-mode="auto">自动镜头</button></div><div data-group="range" class="fields"><label>入点（秒）<input data-start type="number" min="0" step="0.001" value="0"></label><label>出点（秒）<input data-end type="number" step="0.001"></label><label data-group="step">间隔（秒）<input data-step type="number" min="0.001" step="0.1" value="1"></label></div><label data-group="manual" hidden>时间码或秒数（逗号、分号或换行分隔）<textarea data-manual rows="3" placeholder="0, 00:00:02.500, 5"></textarea></label><div data-group="auto" class="fields" hidden><label>切镜阈值<input data-threshold type="number" min="0.05" max="0.95" step="0.01" value="0.28"></label><label>最短镜头（秒）<input data-minshot type="number" min="0.04" max="10" step="0.1" value="0.3"></label><span class="hint wide">阈值越小越敏感，每次最多扫描 300 秒。</span></div><div class="sampling-apply"><button data-apply>应用采样</button><span class="hint" data-selection></span></div><div class="sampling-note">下方胶片用于浏览原视频。实际参与分析的镜头，可在下一步勾选、拆分和合并。</div><p data-sampling-notice class="stage-description error" role="status" hidden>采样参数已修改，尚未应用。</p><button class="stage-next" data-go-stage="correction" data-sampling-next><span data-sampling-next-label>下一步 · 镜头校正</span><span aria-hidden="true">→</span></button></section>',
      '<section class="panel workflow-page correction-panel" data-stage="correction" id="correction-panel" role="tabpanel" aria-labelledby="correction-tab" hidden><div class="section-head"><h3>镜头校正</h3><span class="eyebrow">每批最多 24 镜</span></div><div class="row shot-tools"><button data-merge>合并勾选</button><button data-none>取消勾选</button><button data-undo>撤销</button><button data-redo>重做</button></div><div data-shots class="shot-list"></div><div class="inspect-controls"><div class="section-head"><h4>逐帧检查</h4><span data-editing-shot class="eyebrow">请选择镜头</span></div><div class="row"><button data-prev>← 前帧</button><input data-cursor class="cursor-input" aria-label="定位时间码" value="0"><button data-locate>定位</button><button data-next>后帧 →</button></div><div class="row spaced"><button data-custom>当前帧作代表</button><button data-split>在当前帧拆分</button></div><div class="boundary-tools"><button data-boundary="inPoint:-1">入点 −1 帧</button><button data-boundary="inPoint:1">入点 +1 帧</button><button data-boundary="outPoint:-1">出点 −1 帧</button><button data-boundary="outPoint:1">出点 +1 帧</button></div><p data-inspect-status class="hint">选择一个镜头，检查代表帧和边界。</p></div><button class="stage-next" data-go-stage="analysis">下一步 · 拉片分析<span aria-hidden="true">→</span></button></section>',
      '<section class="panel workflow-page analysis-panel" data-stage="analysis" id="analysis-panel" role="tabpanel" aria-labelledby="analysis-tab" hidden><div class="section-head"><h3>拉片分析</h3><button class="quiet" data-go-stage="correction">返回校正 ↗</button></div><div class="batch-summary"><strong data-analysis-count class="batch-count">00</strong><div class="batch-caption">已选镜头<small>每镜分析 1 张代表帧</small></div></div><div class="analysis-grid"><label>视觉模型<select data-model></select></label><label>分析要求<textarea data-prompt rows="5"></textarea></label></div><p class="analysis-hint">依据静态画面分析。运镜与声音仅作线索，结果可继续人工复核。</p><div class="analysis-actions"><span data-analysis-summary class="analysis-summary" role="status" aria-live="polite"></span><button data-analyze class="primary">开始 AI 拉片</button><button data-extract class="quiet">仅抽帧，稍后人工填写 →</button></div></section>',
      '</div><div class="control-footer"><span>采样 → 校正 → 分析</span><button data-results-link class="quiet" hidden>查看结果 ↓</button></div></aside>',
      '</div><section class="results-section" data-result-section data-stage="results" aria-busy="false" hidden><div class="section-head results-heading"><div class="section-title"><span class="step">04</span><h3 data-results-title tabindex="-1">拉片结果与人工复核</h3></div><button data-back-workbench class="quiet">返回工作台 ↑</button></div><div class="result-progress" data-loading hidden role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span data-loading-label></span></div><div class="results" data-results></div></section></div>',
      '<footer><div class="hint status" data-status role="status" aria-live="polite">正在读取视频…</div><div class="row footer-actions"><button data-images>生成图片节点</button><button data-shotlist class="primary">生成分镜表节点</button><button data-contact>导出联系表</button><button data-json>导出 JSON</button><button data-csv>导出 CSV</button></div></footer></main>',
    ].join('');
    const el = (name) => root.querySelector('[data-' + name + ']');
    const sourceVideo = el('source-video');
    function samplingSignature() {
      const fields = state.mode === 'manual' ? ['manual'] : state.mode === 'auto'
        ? ['start', 'end', 'threshold', 'minshot'] : ['start', 'end', 'step'];
      return JSON.stringify([state.mode, ...fields.map((name) => el(name).value)]);
    }
    const samplingDirty = () => Boolean(state.video && appliedSamplingSignature !== samplingSignature());
    // 步骤和预览只切换显隐，保留表单、播放器及本次镜头编辑状态。
    function setWorkflowStage(stage) {
      if (!['sampling', 'correction', 'analysis'].includes(stage)) return;
      root.querySelectorAll('[data-workflow-tab]').forEach((tab) => {
        const selected = tab.dataset.workflowTab === stage;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      });
      root.querySelectorAll('[role="tabpanel"]').forEach((panel) => { panel.hidden = panel.dataset.stage !== stage; });
      root.querySelector('.workflow-body').scrollTop = 0;
    }
    function setViewer(view) {
      if (view !== 'video' && view !== 'frame') return;
      if (view === 'frame') sourceVideo.pause();
      el('video-view').hidden = view !== 'video'; el('still-view').hidden = view !== 'frame';
      root.querySelectorAll('[data-viewer]').forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.viewer === view)));
    }
    const scrollTo = (target) => target.scrollIntoView({ block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const showResults = () => {
      if (state.results.length) { el('results-title').focus({ preventScroll: true }); scrollTo(el('result-section')); }
    };
    const workflowTabs = Array.from(root.querySelectorAll('[data-workflow-tab]'));
    workflowTabs.forEach((tab, index) => {
      tab.addEventListener('click', () => { if (!state.busy) setWorkflowStage(tab.dataset.workflowTab); });
      tab.addEventListener('keydown', (event) => {
        if (state.busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? workflowTabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + workflowTabs.length) % workflowTabs.length;
        setWorkflowStage(workflowTabs[next].dataset.workflowTab); workflowTabs[next].focus();
      });
    });
    root.querySelectorAll('[data-go-stage]').forEach((button) => button.addEventListener('click', () => {
      if (state.busy) return;
      const advance = () => { setWorkflowStage(button.dataset.goStage); workflowTabs.find((tab) => tab.dataset.workflowTab === button.dataset.goStage).focus(); };
      if (button.hasAttribute('data-sampling-next') && samplingDirty()) {
        let applied = false;
        void action(async () => { await applySampling(); applied = true; }, '正在应用采样…')
          .then(() => { if (applied && !disposed) advance(); });
      } else advance();
    }));
    root.querySelectorAll('[data-viewer]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) setViewer(button.dataset.viewer); }));
    el('results-link').addEventListener('click', showResults);
    el('back-workbench').addEventListener('click', () => {
      workflowTabs.find((tab) => tab.getAttribute('aria-selected') === 'true').focus({ preventScroll: true });
      scrollTo(root.querySelector('.studio'));
    });
    ['start', 'end', 'step', 'manual', 'threshold', 'minshot'].forEach((name) => el(name).addEventListener('input', controls));
    el('source-name').textContent = sourceName; el('source-name').title = sourceName;
    sourceVideo.addEventListener('loadedmetadata', () => {
      if (disposed) return;
      el('source-status').textContent = '播放 / 暂停、拖动进度条查看原视频';
      if (state.cursor) sourceVideo.currentTime = state.cursor.actualTime;
    });
    sourceVideo.addEventListener('error', () => {
      if (!disposed) el('source-status').textContent = '当前环境无法播放此视频格式，仍可使用胶片和逐帧检查';
    });
    async function loadSourceVideo() {
      try {
        const blob = await readSourceVideo(videoResource, effect, () => disposed, (progress) => {
          el('source-status').textContent = '正在加载原视频… ' + progress + '%';
        });
        if (disposed) return;
        sourceVideoUrl = URL.createObjectURL(blob);
        sourceVideo.src = sourceVideoUrl;
        el('source-status').textContent = '正在准备播放…';
      } catch (error) {
        if (!disposed) el('source-status').textContent = error instanceof Error ? error.message : '原视频加载失败';
      }
    }
    const listen = (name, fn, loadingMessage) => el(name).addEventListener('click', () => void action(fn, loadingMessage));
    const status = (message, error) => {
      el('status').textContent = message; el('status').classList.toggle('error', Boolean(error));
      if (state.busy && !error) { state.loadingMessage = message; el('loading-label').textContent = message; el('analysis-summary').textContent = message; }
    };
    function controls() {
      root.querySelectorAll('button,input,select,textarea').forEach((control) => { control.disabled = state.busy; });
      el('undo').disabled = state.busy || !state.history.length;
      el('redo').disabled = state.busy || !state.redo.length;
      const selectedCount = state.shots.filter((shot) => shot.selected).length;
      el('workflow-count').textContent = selectedCount + ' 镜已选 / ' + state.shots.length + ' 镜';
      el('analysis-count').textContent = String(selectedCount).padStart(2, '0');
      el('result-section').hidden = !state.results.length;
      el('results-link').hidden = !state.results.length;
      el('results-link').textContent = '查看 ' + state.results.length + ' 个结果 ↓';
      el('analysis-summary').classList.toggle('status--busy', state.busy);
      const unapplied = samplingDirty();
      el('sampling-notice').hidden = !unapplied;
      el('sampling-next-label').textContent = unapplied ? '应用采样并进入校正' : '下一步 · 镜头校正';
      el('workflow-count').textContent = unapplied ? '采样参数未应用' : selectedCount + ' 镜已选 / ' + state.shots.length + ' 镜';
      el('extract').disabled = state.busy || !selectedCount || unapplied;
      el('analyze').disabled = state.busy || !selectedCount || !el('model').value || unapplied;
      el('analyze').textContent = '开始 AI 拉片' + (selectedCount ? '（' + selectedCount + ' 镜）' : '');
      el('analysis-summary').textContent = !state.video ? '正在准备视频…'
        : state.busy ? state.loadingMessage || '正在处理，请稍候…' : unapplied ? '请返回采样，应用修改后的参数' : !selectedCount ? '请返回校正，勾选要分析的镜头'
        : '已选 ' + selectedCount + ' 镜 · ' + (el('model').value ? '可开始分析' : '请选择视觉模型');
      ['images', 'shotlist', 'contact', 'json', 'csv'].forEach((name) => { el(name).disabled = state.busy || !state.results.length; });
      el('result-section').setAttribute('aria-busy', String(state.busy));
      el('loading').hidden = !state.busy;
      el('loading-label').textContent = state.loadingMessage;
      el('status').classList.toggle('status--busy', state.busy);
      root.querySelectorAll('[data-card-loading]').forEach((overlay) => { overlay.hidden = !state.busy; });
    }
    async function action(fn, loadingMessage = '正在处理…') {
      if (state.busy || disposed) return;
      state.busy = true; state.loadingMessage = loadingMessage; controls();
      try { await fn(); } catch (error) { if (!disposed) status(error instanceof Error ? error.message : String(error), true); }
      finally { if (!disposed) { state.busy = false; state.loadingMessage = ''; controls(); } }
    }
    async function effect(request) {
      const response = await props.runEffect(request);
      if (disposed) throw new Error('界面已关闭');
      if (!response.ok) throw new Error(response.error || '宿主操作失败');
      return response.value;
    }
    function invalidate() {
      const hadResults = state.results.length > 0;
      state.results = []; state.batch = null; renderResults();
      if (hadResults) status('镜头已更新，请重新抽帧或分析。');
    }
    function commitShots(shots, record = true, sampling = state.sampling) {
      validateShots(shots, state.video.duration);
      if (record) {
        if (state.shots.length) state.history.push({ shots: state.shots.map((s) => ({ ...s })), sampling: state.sampling });
        if (state.history.length > 30) state.history.shift(); state.redo = [];
      }
      state.shots = shots;
      state.sampling = sampling;
      if (!shots.some((s) => s.id === state.activeId)) state.activeId = shots[0].id;
      invalidate(); renderShots(); controls();
    }
    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(label, fn) { const node = element('button', '', label); node.type = 'button'; node.addEventListener('click', () => void action(fn)); return node; }
    function activeShot() { const shot = state.shots.find((s) => s.id === state.activeId); if (!shot) throw new Error('请先选择镜头'); return shot; }
    async function inspect(time, direction = 0, boundary = false) {
      const frame = await effect({ type: 'video.inspectFrame', resourceId: videoResource.resourceId, time, direction, boundary });
      state.cursor = frame;
      if (sourceVideoUrl && sourceVideo.readyState >= 1) {
        sourceVideo.pause(); sourceVideo.currentTime = frame.actualTime;
      }
      el('inspector').hidden = false; el('inspector').src = frame.previewDataUrl;
      el('inspector-empty').hidden = true;
      const viewedShotIndex = state.shots.findIndex((shot) => frame.actualTime >= shot.inPoint && frame.actualTime < shot.outPoint);
      el('viewer-caption').textContent = (viewedShotIndex >= 0 ? '预览所属：镜头 ' + String(viewedShotIndex + 1).padStart(2, '0') + ' · ' : '') + formatTimecode(frame.actualTime);
      el('viewer-caption').hidden = false; setViewer('frame');
      el('cursor').value = String(frame.actualTime);
      el('inspect-status').textContent = '实际时间 ' + formatTimecode(frame.actualTime) + ' · 帧时长 ' + frame.frameDuration.toFixed(6) + ' 秒';
      syncFilmstrip();
      return frame;
    }
    function renderShots() {
      const editingIndex = state.shots.findIndex((shot) => shot.id === state.activeId);
      el('editing-shot').textContent = editingIndex >= 0 ? '正在编辑：镜头 ' + String(editingIndex + 1).padStart(2, '0') : '请选择镜头';
      el('shots').replaceChildren();
      const count = state.shots.filter((s) => s.selected).length;
      el('selection').textContent = state.shots.length + ' 镜 · 本批 ' + count + ' / 24';
      state.shots.forEach((shot, i) => {
        const row = element('div', 'shot' + (shot.id === state.activeId ? ' active' : ''));
        const check = element('input'); check.type = 'checkbox'; check.checked = shot.selected; check.setAttribute('aria-label', '选择镜头 ' + (i + 1));
        check.addEventListener('change', () => void action(() => {
          try { commitShots(state.shots.map((s) => s.id === shot.id ? { ...s, selected: check.checked } : s)); }
          catch (error) { check.checked = shot.selected; throw error; }
        }));
        const select = button('镜头 ' + String(i + 1).padStart(2, '0'), async () => {
          state.activeId = shot.id; renderShots(); await inspect(sampleTime(shot));
        });
        select.appendChild(element('small', '', formatTimecode(shot.inPoint) + ' → ' + formatTimecode(shot.outPoint) + ' · ' + (shot.outPoint - shot.inPoint).toFixed(3) + 's'));
        const role = element('select'); role.setAttribute('aria-label', '镜头 ' + (i + 1) + ' 代表帧');
        [['start', '首帧'], ['middle', '中帧'], ['end', '尾帧'], ['custom', '指定帧']].forEach(([value, label]) => {
          const option = element('option', '', label); option.value = value; option.disabled = value === 'custom' && !Number.isFinite(shot.customTime); role.appendChild(option);
        });
        role.value = shot.role;
        role.addEventListener('change', () => void action(async () => {
          const updated = { ...shot, role: role.value };
          state.activeId = shot.id; commitShots(state.shots.map((s) => s.id === shot.id ? updated : s)); await inspect(sampleTime(updated));
        }));
        row.append(check, select, role); el('shots').appendChild(row);
      });
      syncFilmstrip();
    }
    function syncFilmstrip() {
      // 原位更新标记，保留横向滚动位置与键盘焦点。
      const nodes = el('filmstrip').children;
      const shot = state.shots.find((item) => item.id === state.activeId);
      const focusIndex = filmstripFocusIndex(state.previews, state.cursor ? state.cursor.actualTime : shot ? sampleTime(shot) : NaN);
      state.previews.forEach((frame, index) => {
        const node = nodes[index];
        if (!node) return;
        const view = filmstripState(state.shots, frame.actualTime, state.cursor && state.cursor.actualTime);
        node.classList.toggle('frame--selected', view.selected);
        node.classList.toggle('frame--unselected', !view.selected);
        node.classList.toggle('frame--current', view.current);
        node.classList.toggle('frame--before', index < focusIndex);
        node.classList.toggle('frame--focus', index === focusIndex);
        const label = view.shotId ? (view.selected ? '✓ 镜头已选' : '○ 镜头未选') : '— 区间外';
        node.querySelector('[data-frame-selection]').textContent = view.shotId ? (view.selected ? '✓' : '○') : '—';
        node.querySelector('[data-frame-selection]').title = label;
        node.querySelector('[data-frame-current]').hidden = !view.current;
        node.setAttribute('aria-label', '定位 ' + formatTimecode(frame.actualTime) + ' · ' + label + (view.current ? ' · 查看中' : ''));
        if (view.current) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current');
      });
    }
    function renderFilmstrip() {
      el('filmstrip').replaceChildren();
      state.previews.forEach((frame, index) => {
        const node = button('', async () => {
          const view = filmstripState(state.shots, frame.actualTime);
          if (view.shotId) { state.activeId = view.shotId; renderShots(); }
          await inspect(frame.actualTime);
        });
        node.className = 'frame'; node.title = '定位 ' + formatTimecode(frame.actualTime);
        const image = element('img'); image.alt = '视频预览 ' + formatTimecode(frame.actualTime); image.src = frame.previewDataUrl;
        const selection = element('span', 'frame-selection'); selection.dataset.frameSelection = ''; selection.setAttribute('aria-hidden', 'true');
        const current = element('span', 'frame-current', '查看中'); current.dataset.frameCurrent = ''; current.setAttribute('aria-hidden', 'true'); current.hidden = true;
        node.append(image, element('span', 'frame-time', formatTimecode(frame.actualTime)), element('span', 'frame-index', String(index + 1).padStart(2, '0')), selection, current); el('filmstrip').appendChild(node);
      });
      syncFilmstrip();
    }
    async function applySampling() {
      if (!state.video) throw new Error('视频尚未就绪');
      let ranges, mode = state.mode;
      if (mode === 'manual') {
        const times = String(el('manual').value).split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean).map(parseTimecode).sort((a, b) => a - b);
        if (!times.length || times.length > MAX_SHOTS || times.some((t, i) => !Number.isFinite(t) || t < 0 || t >= state.video.duration || (i && t === times[i - 1]))) throw new Error('指定帧须为 1–128 个不重复且位于视频范围内的时间码');
        ranges = times.map((time, i) => ({ inPoint: time, outPoint: times[i + 1] ?? state.video.duration }));
      } else {
        const start = Number(el('start').value), end = Number(el('end').value), step = Number(el('step').value);
        if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > state.video.duration) throw new Error('请检查入点、出点与视频时长');
        if (mode === 'auto') {
          if (end - start > 300) throw new Error('自动镜头每次最多扫描 300 秒，请调整出点');
          status('正在逐帧检测切镜，请稍候；关闭插件可以取消…');
          const value = await effect({ type: 'video.detectShots', resourceId: videoResource.resourceId, start, end,
            threshold: Number(el('threshold').value), minShotDuration: Number(el('minshot').value) });
          ranges = value.shots;
        } else {
          if (!Number.isFinite(step) || step <= 0 || Math.ceil((end - start) / step - 1e-9) > MAX_SHOTS) throw new Error('间隔过小或超过 128 镜，请增大间隔');
          ranges = Array.from({ length: Math.ceil((end - start) / step - 1e-9) }, (_, i) => ({ inPoint: start + i * step, outPoint: Math.min(end, start + (i + 1) * step) }));
        }
      }
      commitShots(ranges.map((range, i) => ({ id: newId(), inPoint: range.inPoint, outPoint: range.outPoint, role: mode === 'auto' ? 'middle' : 'start', selected: i < MAX_FRAMES })), true, mode);
      appliedSamplingSignature = samplingSignature(); controls();
      status('已生成 ' + ranges.length + ' 镜' + (ranges.length > MAX_FRAMES ? '，仅勾选前 24 镜；其余可手动选择后分批处理' : '') + '。镜头编辑支持撤销。');
    }
    function renderResults() {
      el('results').replaceChildren();
      if (!state.results.length) { el('results').appendChild(element('div', 'empty', '选择镜头，抽帧后可 AI 分析或人工填写')); controls(); return; }
      state.results.forEach((result) => {
        const card = element('article', 'result'), body = element('div', 'result-body'), image = element('img');
        image.src = result.previewDataUrl; image.alt = result.shotId;
        const badge = element('div', 'hint wide');
        const updateBadge = () => { badge.textContent = result.shotId + ' · ' + formatTimecode(result.actualTime)
          + ' · ' + result.duration.toFixed(3) + 's · 模型自报置信度：' + (result.confidence === null ? '未提供' : Math.round(result.confidence * 100) + '%')
          + ' · ' + ({ unreviewed: '未复核', reviewed: '已复核', edited: '人工覆盖 ' + result.overrideFields.length + ' 项（待确认）' }[result.reviewStatus]); };
        updateBadge(); body.appendChild(badge);
        FIELDS.forEach((key, i) => {
          const label = element('label', ['content', 'dialogue', 'audio', 'note'].includes(key) ? 'wide' : '', LABELS[i]);
          const control = element(key === 'shotSize' || key === 'camera' || key === 'transition' ? 'input' : 'textarea');
          control.value = result[key] || ''; control.maxLength = key === 'content' ? 2000 : 1000;
          if (control.tagName === 'TEXTAREA') control.rows = 2;
          control.addEventListener('input', () => {
            result[key] = control.value; if (!result.overrideFields.includes(key)) result.overrideFields.push(key);
            result.reviewStatus = 'edited'; updateBadge();
          });
          label.appendChild(control); body.appendChild(label);
        });
        if (result.analysisError) body.appendChild(element('span', 'error wide', result.analysisError));
        const actions = element('div', 'row wide');
        actions.append(button('确认人工复核', () => {
          if (!String(result.content).trim()) throw new Error('请填写画面内容后再确认');
          result.analysisError = ''; result.reviewStatus = 'reviewed'; renderResults(); status('已确认 ' + result.shotId);
        }), button('恢复本次 AI 原文', () => {
          if (!Object.keys(result.aiOriginal).length) throw new Error('还没有 AI 原文');
          result.overrideFields = []; Object.assign(result, mergeAnalysis(result, result.aiOriginal)); renderResults();
        }));
        const preview = element('div', 'result-preview'), overlay = element('div', 'result-loading');
        overlay.setAttribute('data-card-loading', ''); overlay.setAttribute('aria-hidden', 'true');
        overlay.appendChild(element('span', 'spinner')); preview.append(image, overlay);
        body.appendChild(actions); card.append(preview, body); el('results').appendChild(card);
      });
      controls();
    }
    async function prepareFrames() {
      const shots = state.shots.filter((s) => s.selected);
      if (!shots.length) throw new Error('请至少勾选一个镜头');
      const signature = JSON.stringify(shots);
      if (state.batch && state.batch.signature === signature) return state.batch.value;
      status('正在批量抽帧…');
      const value = await effect({ type: 'video.extractFrames', resourceId: videoResource.resourceId, mode: 'analysis', replaceDerived: true,
        samples: shots.map((s) => ({ key: s.id, time: sampleTime(s) })) });
      state.batch = { signature, value };
      state.results = shots.flatMap((shot) => {
        const frame = value.frames.find((f) => f.key === shot.id);
        if (!frame || frame.error || !frame.resourceId) return [];
        return [{ ...frame, shotId: shot.id, inPoint: shot.inPoint, outPoint: shot.outPoint, sampleRole: shot.role,
          duration: shot.outPoint - shot.inPoint, shotSize: '', camera: '', content: '', dialogue: '无法从画面判断', audio: '无法从画面判断',
          transition: '', note: '', confidence: null, reviewStatus: 'unreviewed', overrideFields: [], aiOriginal: {}, analysisError: '未分析；可人工填写并确认' }];
      });
      renderResults();
      if (state.results.length !== shots.length) {
        state.batch = null;
        throw new Error('部分镜头抽帧失败（' + state.results.length + '/' + shots.length + '），请调整选帧后重试；不会静默提交缺帧结果');
      }
      return value;
    }
    function assertComplete() {
      if (!state.batch || state.results.length !== state.shots.filter((s) => s.selected).length) throw new Error('请先完整抽取当前选择的镜头');
    }
    async function analyze() {
      if (!el('model').value) throw new Error('请先选择支持图片输入的文本模型；也可仅抽帧后人工填写');
      const value = await prepareFrames();
      if (!value.contactSheetResourceId) throw new Error('宿主未返回联系表');
      status('正在调用视觉模型；AI 重试会保留人工覆盖字段…');
      const mapping = state.results.map((r) => ({ key: r.key, time: r.actualTime, inPoint: r.inPoint, outPoint: r.outPoint }));
      const prompt = el('prompt').value.trim() + '\n联系表 key 和时间：' + JSON.stringify(mapping)
        + '\n只输出 JSON：{"frames":[{"key":"上述key","shotSize":"","camera":"","content":"","dialogue":"","audio":"","transition":"","note":"","confidence":0.8}]}。'
        + '逐项覆盖全部 key；confidence 为模型自报 0–1，不确定可为 null。时长和边界由视频数据决定，不得编造。';
      const response = await effect({ type: 'model.generate', modelId: el('model').value, prompt, resourceIds: [value.contactSheetResourceId] });
      const analyses = parseAnalysisJson(response.text);
      const byKey = new Map(analyses.map((r) => [r.key, r]));
      state.results = state.results.map((result) => {
        const analysis = byKey.get(result.key);
        return analysis ? mergeAnalysis(result, analysis) : { ...result, analysisError: '模型缺少此镜头，请人工填写并确认' };
      });
      renderResults();
      await props.setParameters({ model: el('model').value, prompt: el('prompt').value.slice(0, 8000) });
      status('分析完成；请留意未复核、缺失结果与模型自报置信度。');
    }
    function report() {
      assertComplete();
      return { schemaVersion: 1, source: { nodeId: props.node.id, name: sourceName, duration: state.video.duration },
        sampling: state.sampling, frames: state.results.map(publicFrame) };
    }
    async function exportReport(kind) {
      const data = report();
      const content = kind === 'json' ? JSON.stringify(data, null, 2) : reportCsv(data);
      if (content.length > 256000) throw new Error('报告超过导出上限，请减少镜头或缩短文字');
      const saved = await effect({ type: 'resource.createText', content, suggestedName: 'frame-review.' + kind });
      status('已保存到项目：' + saved.fileName);
    }
    async function submit(outputMode) {
      assertComplete();
      if (state.results.some((r) => r.analysisError || r.reviewStatus === 'edited')) throw new Error('请先确认缺失结果和人工修改的复核状态');
      status(outputMode === 'images' ? '正在保存画面并生成图片节点…' : '正在保存画面并生成分镜表节点…');
      await props.submit({ outputMode, videoDuration: state.video.duration,
        frames: state.results.map((r) => ({ ...publicFrame(r), resourceId: r.resourceId, width: r.width, height: r.height })) });
    }
    const models = (props.models || []).filter((m) => m.category === 'text' && (m.inputModalities || []).includes('image'));
    const placeholder = element('option', '', '选择视觉模型'); placeholder.value = ''; el('model').appendChild(placeholder);
    models.forEach((model) => { const option = element('option', '', model.name + ' · ' + model.provider); option.value = model.id; el('model').appendChild(option); });
    const parameters = props.parameters || {};
    el('model').value = models.some((m) => m.id === parameters.model) ? parameters.model : '';
    el('prompt').value = parameters.prompt || DEFAULT_PROMPT; el('prompt').maxLength = 8000;
    el('model').addEventListener('change', controls);
    root.querySelectorAll('[data-mode]').forEach((tab) => tab.addEventListener('click', () => {
      if (state.busy) return; state.mode = tab.dataset.mode;
      root.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === tab));
      root.querySelectorAll('[data-group]').forEach((group) => {
        const name = group.dataset.group; group.hidden = name === 'range' ? state.mode === 'manual' : name === 'step' ? state.mode !== 'interval' : name !== state.mode;
      });
    }));
    root.querySelectorAll('[data-mode]').forEach((tab) => tab.addEventListener('click', controls));
    listen('apply', applySampling);
    listen('extract', async () => { await prepareFrames(); status('抽帧完成，可人工填写并确认，或继续 AI 拉片。'); showResults(); });
    listen('analyze', async () => { await analyze(); showResults(); }, '正在准备 AI 拉片…');
    listen('merge', () => commitShots(mergeShots(state.shots)));
    listen('none', () => commitShots(state.shots.map((s) => ({ ...s, selected: false }))));
    listen('undo', () => {
      if (!state.history.length) return;
      state.redo.push({ shots: state.shots, sampling: state.sampling });
      const snapshot = state.history.pop(); commitShots(snapshot.shots, false, snapshot.sampling);
    });
    listen('redo', () => {
      if (!state.redo.length) return;
      state.history.push({ shots: state.shots, sampling: state.sampling });
      const snapshot = state.redo.pop(); commitShots(snapshot.shots, false, snapshot.sampling);
    });
    listen('locate', () => inspect(parseTimecode(el('cursor').value)));
    listen('prev', () => inspect(state.cursor ? state.cursor.actualTime : parseTimecode(el('cursor').value), -1));
    listen('next', () => inspect(state.cursor ? state.cursor.actualTime : parseTimecode(el('cursor').value), 1));
    listen('custom', () => {
      const shot = activeShot();
      if (!state.cursor) throw new Error('请先定位画面');
      commitShots(state.shots.map((s) => s.id === shot.id ? { ...s, role: 'custom', customTime: state.cursor.actualTime } : s));
    });
    listen('split', () => {
      if (!state.cursor) throw new Error('请先定位拆分画面');
      commitShots(splitShot(state.shots, activeShot().id, state.cursor.actualTime, newId()));
    });
    root.querySelectorAll('[data-boundary]').forEach((control) => control.addEventListener('click', () => void action(async () => {
      const [edge, direction] = control.dataset.boundary.split(':');
      const shot = activeShot();
      const frame = await inspect(shot[edge], Number(direction), true);
      const next = moveBoundary(state.shots, state.shots.indexOf(shot), edge, frame.boundaryTime ?? frame.actualTime);
      commitShots(next); status('边界已按实际帧移动；相邻镜头同步调整。');
    })));
    listen('images', () => submit('images'), '正在生成图片节点…'); listen('shotlist', () => submit('shotlist'), '正在生成分镜表节点…');
    listen('json', () => exportReport('json')); listen('csv', () => exportReport('csv'));
    listen('contact', async () => {
      assertComplete();
      const id = state.batch.value.contactSheetResourceId; if (!id) throw new Error('没有联系表资源');
      const saved = await effect({ type: 'resource.export', resourceId: id, suggestedName: 'frame-review-contact.jpg' });
      status('已保存到项目：' + saved.fileName);
    });
    const strip = el('filmstrip');
    el('view').addEventListener('click', () => {
      if (state.busy) return;
      state.deckFlat = !state.deckFlat;
      strip.classList.toggle('filmstrip--flat', state.deckFlat);
      el('view').textContent = state.deckFlat ? '平铺' : '立体';
      el('view').setAttribute('aria-pressed', String(!state.deckFlat));
    });
    const scrollStrip = (delta) => strip.scrollBy({ left: delta,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el('left').addEventListener('click', () => scrollStrip(-Math.max(250, strip.clientWidth * 0.7)));
    el('right').addEventListener('click', () => scrollStrip(Math.max(250, strip.clientWidth * 0.7)));
    strip.addEventListener('wheel', (event) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || strip.scrollWidth <= strip.clientWidth) return;
      const atEdge = event.deltaY < 0 ? strip.scrollLeft <= 0 : strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1;
      if (!atEdge) { event.preventDefault(); strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1); }
    }, { passive: false });
    strip.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); scrollStrip(event.key === 'ArrowLeft' ? -166 : 166); } });
    const themeListener = (event) => {
      const theme = typeof event.detail === 'string' ? event.detail : event.detail && event.detail.theme;
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    };
    themeListener({ detail: props.theme }); window.addEventListener('ai-canvas-theme-change', themeListener);
    renderResults();
    void action(async () => {
      if (!videoResource) throw new Error('当前节点没有可读取的视频资源');
      const value = await effect({ type: 'video.extractFrames', resourceId: videoResource.resourceId, mode: 'preview', count: 12 });
      state.video = value.video;
      state.previews = (value.frames || []).filter((f) => f.previewDataUrl && !f.error);
      el('end').value = String(state.video.duration);
      el('step').value = String(state.video.duration / 8);
      renderFilmstrip(); await applySampling();
      if (state.previews[0]) sourceVideo.poster = state.previews[0].previewDataUrl;
      await loadSourceVideo();
    });
    return function cleanup() {
      disposed = true; window.removeEventListener('ai-canvas-theme-change', themeListener);
      sourceVideo.pause(); sourceVideo.removeAttribute('src'); sourceVideo.load();
      if (sourceVideoUrl) { URL.revokeObjectURL(sourceVideoUrl); sourceVideoUrl = ''; }
      root.replaceChildren();
    };
  };
})();
