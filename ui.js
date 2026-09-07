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
    const videoResource = (props.resources && props.resources.self || []).find((r) => String(r.mediaType || '').startsWith('video/'));
    const sourceName = String(props.node && props.node.data && props.node.data.label || videoResource && videoResource.displayName || '来源视频').slice(0, 240);
    root.innerHTML = [
      '<style>',
      ':root{color-scheme:dark;--bg:#101014;--panel:#19191f;--card:#25252e;--line:#363640;--text:#ececf2;--muted:#a4a4b3;--soft:#8c8c9d;--accent:#7c6df2;--accent2:#b5aaff;--danger:#ff7f8e;--success:#63d3a6;--glass-edge:#888895;--shadow:0 12px 28px rgba(0,0,0,.24)}',
      ':root[data-theme="light"]{color-scheme:light;--bg:#f5f4f8;--panel:#fcfbfe;--card:#eae8f0;--line:#d8d5e1;--text:#34303d;--muted:#746e7f;--soft:#827c8e;--accent:#7165d8;--accent2:#675bbf;--danger:#c84d60;--success:#258c69;--glass-edge:#aaa5b6;--shadow:0 12px 28px rgba(71,62,95,.09)}',
      '*{box-sizing:border-box;scrollbar-width:none} *::-webkit-scrollbar{display:none;width:0;height:0} html,body,#root{width:100%;height:100%;min-width:0;margin:0} body{overflow:auto;background:var(--bg);color:var(--text);font:13px "Segoe UI","Microsoft YaHei",sans-serif}',
      'button,input,select,textarea{font:inherit;color:inherit} button{cursor:pointer} button:disabled{opacity:.42;cursor:not-allowed} .app [hidden]{display:none}',
      '.app{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;background:var(--bg)} .workspace{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:12px 14px}',
      '.setup,.workbench{display:grid;gap:20px} .setup{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);align-items:start;padding-bottom:10px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)} .workbench{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;margin:10px 0 14px} .panel{min-width:0;padding:8px}',
      '.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px} .section-title{display:flex;align-items:center;gap:8px;min-width:0} .step{display:inline-grid;place-items:center;width:24px;height:24px;flex-shrink:0;border:1px solid var(--line);border-radius:50%;background:var(--panel);color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.02em} h3{margin:0;font-size:14px;font-weight:600} .eyebrow{font-size:11px;color:var(--soft);letter-spacing:.04em} .pill{border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:11px;color:var(--muted);white-space:nowrap}',
      '.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center} .spaced{margin-top:6px} .hint{color:var(--muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere} .panel p.hint{margin:6px 0 0} .error{color:var(--danger)} .subtle{font-size:11px;color:var(--soft)}',
      'button{min-height:28px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12px;line-height:18px;background:var(--panel);transition:background .16s,border-color .16s} button:hover:not(:disabled){border-color:var(--glass-edge);background:var(--card)} button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}',
      '.active,.primary{border-color:color-mix(in srgb,var(--accent) 65%,var(--line));color:var(--accent2);background:color-mix(in srgb,var(--accent) 12%,var(--panel))} .primary{font-weight:600;box-shadow:inset 0 1px 0 color-mix(in srgb,var(--text) 8%,transparent)} .tabs{display:flex;gap:4px;margin-bottom:8px;padding:3px;border:1px solid var(--line);border-radius:999px;background:var(--panel);max-width:460px} .tabs button{flex:1;min-width:0;border-color:transparent;border-radius:999px;background:transparent} .tabs .active{border-color:color-mix(in srgb,var(--accent) 36%,var(--line));background:color-mix(in srgb,var(--accent) 12%,var(--panel))}',
      '.fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px} label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:12px;min-width:0} input,select,textarea{width:100%;min-width:0;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:4px 7px;font-size:12px} input,select{height:28px} textarea{resize:vertical;min-height:48px;line-height:1.5} input[type=checkbox]{width:14px;height:14px;flex-shrink:0;accent-color:var(--accent)} select option{background:var(--panel);color:var(--text)} input:focus-visible,select:focus-visible,textarea:focus-visible{outline:1px solid var(--accent);outline-offset:1px}',
      '.source-panel{border:1px solid color-mix(in srgb,var(--line) 75%,transparent);border-radius:12px;background:var(--panel)} .source-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(110px,.7fr);gap:10px;align-items:center} .source-video{display:block;width:100%;height:116px;object-fit:contain;background:var(--bg);border-radius:7px} .source-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)} .source-meta{min-width:0} .source-meta .hint{margin-top:5px} .source-meta .eyebrow{display:block;margin-bottom:9px}',
      '.film-panel{padding:12px 0 4px} .film-panel .section-head{margin:0 8px} .film-tools{display:flex;gap:3px;align-items:center;padding:3px;border:1px solid var(--line);border-radius:999px;background:var(--panel)} .film-tools button{border-color:transparent;background:transparent;border-radius:999px;min-width:30px} .film-tools [aria-pressed="true"]{color:var(--accent2);background:color-mix(in srgb,var(--accent) 10%,var(--panel))} .film-help{margin:0 8px;font-size:11px;color:var(--soft)}',
      '.filmstrip{display:flex;gap:0;min-width:0;width:100%;overflow-x:auto;overscroll-behavior-x:contain;padding:16px 16px 18px;isolation:isolate;justify-content:safe center;scroll-padding-inline:20px;background:radial-gradient(ellipse at 50% 95%,color-mix(in srgb,var(--text) 5%,transparent),transparent 66%)} .frame{position:relative;flex:0 0 142px;min-height:154px;margin-right:-48px;overflow:hidden;padding:5px;display:flex;flex-direction:column;gap:4px;border:1px solid var(--glass-edge);border-radius:10px;background:linear-gradient(125deg,color-mix(in srgb,var(--text) 15%,var(--panel)),color-mix(in srgb,var(--panel) 88%,transparent) 40%,color-mix(in srgb,var(--text) 9%,var(--panel)));backdrop-filter:blur(12px);box-shadow:3px 4px 0 -2px color-mix(in srgb,var(--glass-edge) 60%,transparent),8px 12px 18px color-mix(in srgb,var(--bg) 80%,transparent),inset 0 1px 0 color-mix(in srgb,var(--text) 25%,transparent);transform:perspective(740px) rotateY(-40deg) rotateZ(2deg) scale(.94);transform-origin:center;transition:transform .24s,box-shadow .24s,border-color .2s;z-index:1} .frame::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:linear-gradient(115deg,color-mix(in srgb,var(--text) 10%,transparent),transparent 35%,transparent 72%,color-mix(in srgb,var(--text) 6%,transparent))} .frame:last-child{margin-right:0} .frame img{width:100%;height:118px;object-fit:contain;background:var(--bg);border-radius:5px;pointer-events:none} .frame-time{padding:1px 2px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--text)}',
      '.frame--before{transform:perspective(740px) rotateY(40deg) rotateZ(-2deg) scale(.94)} .frame--focus,.frame:focus-visible{transform:perspective(740px) rotateY(0) translateY(-6px) scale(1.035);z-index:4;border-color:var(--accent2);background:linear-gradient(125deg,color-mix(in srgb,var(--text) 18%,var(--panel)),var(--panel));box-shadow:0 14px 28px color-mix(in srgb,var(--bg) 85%,transparent),inset 0 1px 0 color-mix(in srgb,var(--text) 30%,transparent)} .frame:not(.frame--focus):hover:not(:disabled){border-color:var(--text)} .frame:focus-visible{z-index:5} .frame--unselected img{opacity:.7} .frame-index,.frame-selection,.frame-current{position:absolute;z-index:1;background:color-mix(in srgb,var(--bg) 90%,transparent);border:1px solid color-mix(in srgb,var(--text) 18%,transparent);color:var(--text);font-size:10px;line-height:16px;padding:0 4px;border-radius:5px} .frame-index{top:8px;left:8px;font-variant-numeric:tabular-nums} .frame-selection{top:8px;right:8px} .frame--selected .frame-selection{color:var(--accent2)} .frame-current{bottom:32px;left:8px;color:var(--accent2)} .filmstrip--flat{gap:8px} .filmstrip--flat .frame{margin:0;transform:none;flex-basis:144px} .filmstrip--flat .frame--focus{border-color:var(--accent2)}',
      '.correction-panel{padding:8px 10px 8px 8px} .shot-list{max-height:138px;overflow:auto;min-width:0} .shot{display:flex;gap:6px;align-items:center;margin:0;padding:4px 6px;border:0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);border-radius:0;background:transparent} .shot.active{background:color-mix(in srgb,var(--text) 5%,transparent);box-shadow:inset 2px 0 0 var(--accent);border-radius:0 6px 6px 0} .shot button{flex:1;min-width:0;text-align:left;overflow-wrap:anywhere;border-color:transparent;background:transparent;padding:3px 4px} .shot select{width:76px;background:transparent;border-color:transparent} .shot select:hover{border-color:var(--line)} .shot small{display:block;color:var(--muted);margin-top:2px;font-size:10px;font-variant-numeric:tabular-nums}',
      '.inspection-panel{position:relative;border:1px solid color-mix(in srgb,var(--glass-edge) 56%,var(--line));border-radius:15px;padding:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--text) 6%,var(--panel)),var(--panel) 70%);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--text) 10%,transparent),var(--shadow)} .inspect-layout{display:grid;grid-template-columns:minmax(100px,.72fr) minmax(0,1.28fr);gap:10px} .inspect-image{position:relative;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--bg);overflow:hidden;min-height:154px} .inspector{width:100%;height:154px;object-fit:contain;background:var(--bg);display:block} .inspect-empty{height:154px;display:grid;place-content:center;text-align:center;gap:7px;color:var(--soft);font-size:11px;padding:10px} .inspect-empty span:first-child{font-size:25px;color:var(--glass-edge)} .cursor-input{max-width:110px;flex:1;min-width:46px} .inspect-controls .row{gap:4px} .inspect-controls button{padding-inline:6px} .boundary-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-top:5px}',
      '.analysis-panel{padding:12px 8px 10px;border-top:1px solid var(--line);border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)} .analysis-grid{display:grid;grid-template-columns:minmax(170px,.65fr) minmax(0,1.35fr) auto;gap:10px;align-items:end} .analysis-actions{display:flex;flex-direction:column;gap:5px;align-items:stretch} .analysis-actions .primary{min-width:164px} .analysis-hint{font-size:11px;color:var(--soft);line-height:1.5;margin:6px 0 0} .analysis-summary{color:var(--muted);font-size:11px}',
      '.results-heading{margin:12px 8px 8px} .results{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:8px} .result{border:1px solid var(--line);border-radius:12px;overflow:hidden;min-width:0;background:var(--panel);box-shadow:var(--shadow)} .result img{width:100%;height:155px;object-fit:contain;background:var(--bg)} .result-body{padding:8px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px} .wide{grid-column:1/-1} .empty{padding:14px 8px;color:var(--muted);text-align:center;font-size:12px}',
      '.result-preview{position:relative;min-height:155px} .result-loading{position:absolute;inset:0;display:grid;place-items:center;background:color-mix(in srgb,var(--bg) 65%,transparent)} .result-progress{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:8px;background:var(--card);padding:8px;margin-bottom:8px} .spinner{width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:frame-review-spin .8s linear infinite} @keyframes frame-review-spin{to{transform:rotate(360deg)}} @media(prefers-reduced-motion:reduce){.spinner{animation:none}}',
      '.status--busy{display:flex;align-items:center;gap:6px} .status--busy::before{content:"";width:12px;height:12px;flex-shrink:0;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:frame-review-spin .8s linear infinite} @media(prefers-reduced-motion:reduce){.status--busy::before{animation:none} .frame,button{transition:none}}',
      'footer{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;flex-shrink:0;padding:6px 8px;border-top:1px solid var(--line);background:var(--panel);max-height:38%;overflow:auto} .footer-actions{flex:0 1 auto;justify-content:flex-end;margin-left:auto} .status{flex:1 1 220px;min-width:0;margin:0;overflow-wrap:anywhere}',
      '@media(max-width:980px){.setup,.workbench{gap:12px} .source-layout{grid-template-columns:minmax(0,1fr)} .source-meta .eyebrow{display:none} .analysis-grid{grid-template-columns:minmax(150px,.65fr) minmax(0,1.35fr)} .analysis-actions{grid-column:1/-1;flex-direction:row;justify-content:flex-end} .inspect-layout{grid-template-columns:minmax(0,1fr)} .inspect-image,.inspector,.inspect-empty{height:132px;min-height:132px}}',
      '@media(max-width:760px){.setup,.workbench{grid-template-columns:minmax(0,1fr)} .workspace{padding:8px} .source-layout{grid-template-columns:minmax(0,1fr) minmax(110px,.7fr)} .frame{flex-basis:132px;margin-right:-23px} .inspect-layout{grid-template-columns:minmax(100px,.7fr) minmax(0,1.3fr)}}',
      '@media(max-width:480px){.source-layout,.analysis-grid,.inspect-layout{grid-template-columns:minmax(0,1fr)} .source-name{margin-top:0} .source-meta .hint{margin-top:3px} .analysis-actions{flex-wrap:wrap} .source-video{height:144px} .inspect-image,.inspector,.inspect-empty{height:144px;min-height:144px} .eyebrow{display:none} .film-help{max-width:100%} .tabs{border-radius:12px} .tabs button{border-radius:9px}}',
      '</style>',
      '<main class="app"><div class="workspace">',
      '<div class="setup">',
      '<section class="panel" data-stage="sampling"><div class="section-head"><div class="section-title"><span class="step">01</span><h3>采样设置</h3></div><span class="eyebrow">从视频建立镜头</span></div>',
      '<div class="tabs"><button data-mode="interval" class="active">固定间隔</button><button data-mode="manual">指定帧</button><button data-mode="auto">自动镜头</button></div>',
      '<div data-group="range" class="fields"><label>入点（秒）<input data-start type="number" min="0" step="0.001" value="0"></label><label>出点（秒）<input data-end type="number" step="0.001"></label><label data-group="step">间隔（秒）<input data-step type="number" min="0.001" step="0.1" value="1"></label></div>',
      '<label data-group="manual" hidden>时间码或秒数（逗号、分号或换行分隔）<textarea data-manual rows="2" placeholder="0, 00:00:02.500, 5"></textarea></label>',
      '<div data-group="auto" class="fields spaced" hidden><label>切镜阈值<input data-threshold type="number" min="0.05" max="0.95" step="0.01" value="0.28"></label><label>最短镜头（秒）<input data-minshot type="number" min="0.04" max="10" step="0.1" value="0.3"></label><span class="hint">阈值越小越敏感，每次最多扫描 300 秒。</span></div>',
      '<div class="row spaced"><button data-apply>应用采样</button><span class="hint" data-selection></span></div></section>',
      '<section class="panel source-panel"><div class="section-head"><div class="section-title"><h3>原视频</h3></div><span class="pill">播放 · 定位</span></div><div class="source-layout"><video data-source-video class="source-video" controls playsinline preload="metadata" aria-label="原视频播放器"></video><div class="source-meta"><span class="eyebrow">当前素材</span><p data-source-name class="hint source-name"></p><p data-source-status class="hint" role="status">正在加载原视频…</p></div></div></section>',
      '</div>',
      '<section class="panel film-panel"><div class="section-head"><div class="section-title"><h3>视频胶片</h3><span class="eyebrow">展开每一刻</span></div><div class="film-tools"><button data-view aria-pressed="true" title="切换立体或平铺胶片">立体</button><button data-left aria-label="向左浏览缩略图">←</button><button data-right aria-label="向右浏览缩略图">→</button></div></div><div data-filmstrip class="filmstrip" tabindex="0" aria-label="视频胶片横向浏览"></div><p class="film-help">点击画面定位，勾选状态同步下方镜头。滚轮、触控板或方向键横向浏览。</p></section>',
      '<div class="workbench" data-stage="correction"><section class="panel correction-panel"><div class="section-head"><div class="section-title"><span class="step">02</span><h3>镜头校正</h3></div><span class="eyebrow">勾选 · 合并 · 拆分</span></div><div class="row"><button data-merge>合并勾选镜头</button><button data-none>取消勾选</button><button data-undo>撤销</button><button data-redo>重做</button></div><div data-shots class="shot-list spaced"></div><p class="hint">每批最多 24 镜；修改边界或代表帧后重新抽帧。</p></section>',
      '<section class="panel inspection-panel"><div class="section-head"><div class="section-title"><h3>逐帧检查</h3></div><span class="pill">精确到帧</span></div><div class="inspect-layout"><div class="inspect-image"><img data-inspector class="inspector" alt="当前帧预览" hidden><div data-inspector-empty class="inspect-empty"><span aria-hidden="true">▧</span><span>选择胶片或镜头<br>查看当前画面</span></div></div><div class="inspect-controls"><div class="row"><button data-prev>← 前帧</button><input data-cursor class="cursor-input" aria-label="定位时间码" value="0"><button data-locate>定位</button><button data-next>后帧 →</button></div><div class="row spaced"><button data-custom>当前帧作代表</button><button data-split>在当前帧拆分</button></div><div class="hint spaced">当前镜头边界</div><div class="boundary-tools"><button data-boundary="inPoint:-1">入点 −1 帧</button><button data-boundary="inPoint:1">入点 +1 帧</button><button data-boundary="outPoint:-1">出点 −1 帧</button><button data-boundary="outPoint:1">出点 +1 帧</button></div><p data-inspect-status class="hint">按实际解码时间戳检查首、中、尾帧。</p></div></div></section></div>',
      '<section class="panel analysis-panel" data-stage="analysis"><div class="section-head"><div class="section-title"><span class="step">03</span><h3>拉片分析</h3></div><span data-analysis-summary class="analysis-summary" role="status" aria-live="polite"></span></div><div class="analysis-grid"><label>视觉模型<select data-model></select></label><label>分析要求<textarea data-prompt rows="2"></textarea></label><div class="analysis-actions"><button data-extract>仅抽帧 / 人工填写</button><button data-analyze class="primary">开始 AI 拉片</button></div></div><p class="analysis-hint">每镜头分析一张代表帧。运镜与声音仅作画面线索，不等同于完整视频分析。</p></section>',
      '<section data-result-section data-stage="results" aria-busy="false"><div class="section-head results-heading"><div class="section-title"><span class="step">04</span><h3>拉片结果与人工复核</h3></div><span class="eyebrow">确认后生成节点或导出</span></div><div class="result-progress" data-loading hidden role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span data-loading-label></span></div><div class="results" data-results></div></section>',
      '</div><footer><div class="hint status" data-status role="status" aria-live="polite">正在读取视频…</div><div class="row footer-actions"><button data-images>生成图片节点</button><button data-shotlist class="primary">生成分镜表节点</button><button data-contact>导出联系表</button><button data-json>导出 JSON</button><button data-csv>导出 CSV</button></div></footer></main>',
    ].join('');
    const el = (name) => root.querySelector('[data-' + name + ']');
    const sourceVideo = el('source-video');
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
      if (state.busy && !error) { state.loadingMessage = message; el('loading-label').textContent = message; }
    };
    function controls() {
      root.querySelectorAll('button,input,select,textarea').forEach((control) => { control.disabled = state.busy; });
      el('undo').disabled = state.busy || !state.history.length;
      el('redo').disabled = state.busy || !state.redo.length;
      const selectedCount = state.shots.filter((shot) => shot.selected).length;
      el('extract').disabled = state.busy || !selectedCount;
      el('analyze').disabled = state.busy || !selectedCount || !el('model').value;
      el('analyze').textContent = '开始 AI 拉片' + (selectedCount ? '（' + selectedCount + ' 镜）' : '');
      el('analysis-summary').textContent = !state.video ? '正在准备视频…'
        : state.busy ? '正在处理，请稍候…' : !selectedCount ? '请先勾选要分析的镜头'
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
      el('cursor').value = String(frame.actualTime);
      el('inspect-status').textContent = '实际时间 ' + formatTimecode(frame.actualTime) + ' · 帧时长 ' + frame.frameDuration.toFixed(6) + ' 秒';
      syncFilmstrip();
      return frame;
    }
    function renderShots() {
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
    listen('apply', applySampling);
    listen('extract', async () => { await prepareFrames(); status('抽帧完成，可人工填写并确认，或继续 AI 拉片。'); });
    listen('analyze', analyze, '正在准备 AI 拉片…');
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
