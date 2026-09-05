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
  const logic = { parseTimecode, sampleTime, validateShots, splitShot, mergeShots, moveBoundary, parseAnalysisJson, mergeAnalysis, publicFrame, reportCsv };
  window.__AI_CANVAS_PLUGIN_HOST__.exports.FrameReviewLogic = logic;

  window.__AI_CANVAS_PLUGIN_HOST__.exports.VideoFrameReview = function mount(root, props) {
    let disposed = false, serial = 0;
    const prefix = 'shot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '-';
    const newId = () => prefix + (++serial);
    const state = { video: null, previews: [], shots: [], activeId: '', cursor: null, results: [], batch: null, sampling: 'interval',
      busy: false, mode: 'interval', history: [], redo: [] };
    const videoResource = (props.resources && props.resources.self || []).find((r) => String(r.mediaType || '').startsWith('video/'));
    const sourceName = String(props.node && props.node.data && props.node.data.label || videoResource && videoResource.displayName || '来源视频').slice(0, 240);
    root.innerHTML = [
      '<style>',
      "        :root { color-scheme: dark; --bg:#101018; --panel:#181824; --card:#1e1e2b; --line:#303044; --text:#ececf2; --muted:#9a9aac; --soft:#727287; --accent:#7c6df2; --accent2:#a79dff; --danger:#ff7f8e; --success:#63d3a6; --shadow:0 16px 40px rgba(0,0,0,.2); }\n        :root[data-theme=\"light\"] { color-scheme: light; --bg:#f7f5fb; --panel:#fffafd; --card:#f2eff8; --line:#ddd7e7; --text:#34303d; --muted:#746e7f; --soft:#948da0; --accent:#7165d8; --accent2:#675bbf; --danger:#c84d60; --success:#258c69; --shadow:0 16px 36px rgba(92,74,116,.12); }",
      '*{box-sizing:border-box} html,body,#root{width:100%;height:100%;min-width:0;margin:0} body{overflow:auto;background:var(--bg);color:var(--text);font:13px "Segoe UI","Microsoft YaHei",sans-serif}',
      'button,input,select,textarea{font:inherit;color:inherit} button{cursor:pointer} button:disabled{opacity:.45;cursor:not-allowed} .app [hidden]{display:none}',
      '.app{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column} .workspace{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:8px;scrollbar-gutter:stable}',
      '.setup,.workbench{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px} .panel{min-width:0;border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:8px;margin-bottom:8px}',
      'h3{margin:0 0 6px;font-size:14px} .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center} .spaced{margin-top:6px} .hint{color:var(--muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere} .panel p.hint{margin:6px 0 0} .error{color:var(--danger)}',
      'button{min-height:28px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;line-height:18px;background:var(--card)} button:hover:not(:disabled){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--card))} button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.active,.primary{border-color:var(--accent);color:var(--accent2);background:color-mix(in srgb,var(--accent) 18%,var(--card))} .tabs{display:flex;gap:4px;margin-bottom:6px} .tabs button{flex:1;min-width:0}',
      '.fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px} label{display:flex;flex-direction:column;gap:3px;color:var(--muted);font-size:12px;min-width:0} input,select,textarea{width:100%;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;line-height:18px} input,select{height:28px} input:focus,select:focus,textarea:focus{outline:1px solid var(--accent)} textarea{resize:vertical;line-height:1.5} input[type=checkbox]{width:14px;height:14px;margin:0;flex-shrink:0} .wide{grid-column:1/-1}',
      '.filmstrip{display:flex;gap:8px;min-width:0;width:100%;overflow-x:auto;overscroll-behavior-x:contain;padding:2px 0 6px;scrollbar-gutter:stable} .frame{flex:0 0 156px;overflow:hidden;padding:0;display:flex;flex-direction:column;gap:3px} .frame img{width:100%;height:88px;object-fit:contain;background:var(--bg);pointer-events:none} .frame span{padding:0 4px 3px;font-size:11px}',
      '.shot-list{max-height:330px;overflow:auto;min-width:0} .shot{display:flex;gap:6px;align-items:center;margin:3px 0;padding:4px;border:1px solid var(--line);border-radius:6px} .shot button{flex:1;min-width:0;text-align:left;overflow-wrap:anywhere} .shot select{width:80px} .shot small{display:block;color:var(--muted);margin-top:2px}',
      '.inspector{width:100%;height:190px;object-fit:contain;background:var(--bg);border-radius:8px} .cursor-input{max-width:180px} .results{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:8px} .result{border:1px solid var(--line);border-radius:8px;overflow:hidden;min-width:0;background:var(--panel)} .result img{width:100%;height:170px;object-fit:contain;background:var(--bg)} .result-body{padding:8px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px} .empty{border:1px dashed var(--line);padding:16px;color:var(--muted);text-align:center}',
      'footer{flex-shrink:0;padding:6px 8px;border-top:1px solid var(--line);background:var(--panel);max-height:38%;overflow:auto} .status{margin-top:4px;overflow-wrap:anywhere} @media(max-width:760px){.setup,.workbench{grid-template-columns:minmax(0,1fr)} .workspace{padding:6px} .frame{flex-basis:140px}}',
      '</style><main class="app"><div class="workspace"><div class="setup">',
      '<section class="panel"><h3>1. 选择采样方式</h3><div class="tabs"><button data-mode="interval" class="active">固定间隔</button><button data-mode="manual">指定帧</button><button data-mode="auto">自动镜头</button></div>',
      '<div data-group="range" class="fields"><label>入点（秒）<input data-start type="number" min="0" step="0.001" value="0"></label><label>出点（秒）<input data-end type="number" step="0.001"></label><label data-group="step">间隔（秒）<input data-step type="number" min="0.001" step="0.1" value="1"></label></div>',
      '<label data-group="manual" hidden>时间码或秒数（逗号、分号或换行分隔）<textarea data-manual rows="3" placeholder="0, 00:00:02.500, 5"></textarea></label>',
      '<div data-group="auto" class="fields spaced" hidden><label>切镜阈值<input data-threshold type="number" min="0.05" max="0.95" step="0.01" value="0.28"></label><label>最短镜头（秒）<input data-minshot type="number" min="0.04" max="10" step="0.1" value="0.3"></label><span class="hint">阈值越小越敏感。每次最多扫描 300 秒，结果需人工复核。</span></div>',
      '<div class="row spaced"><button data-apply>应用采样</button><span class="hint" data-selection></span></div></section>',
      '<section class="panel"><h3>2. 分析设置</h3><label>视觉模型<select data-model></select></label><label class="spaced">分析要求<textarea data-prompt rows="3"></textarea></label>',
      '<div class="row spaced"><button data-extract>仅抽帧 / 人工填写</button><button data-analyze class="primary">开始 AI 拉片</button></div><p class="hint">每镜头选择一张代表帧。AI 基于静态联系表分析；运镜和声音仅作线索，不等同于完整视频分析。</p></section></div>',
      '<section class="panel"><div class="row"><h3>视频胶片</h3><button data-left aria-label="向左浏览缩略图">←</button><button data-right aria-label="向右浏览缩略图">→</button><span class="hint">可滚轮、触控板或方向键横向浏览；点击画面定位。</span></div><div data-filmstrip class="filmstrip" tabindex="0" aria-label="视频胶片横向浏览"></div></section>',
      '<div class="workbench"><section class="panel"><h3>3. 镜头校正</h3><div class="row"><button data-merge>合并勾选镜头</button><button data-none>取消勾选</button><button data-undo>撤销</button><button data-redo>重做</button></div><div data-shots class="shot-list spaced"></div><p class="hint">勾选用于本批输出（最多 24 镜）。拆分保留左镜 ID，合并保留首镜 ID。更改镜头后需重新抽帧。</p></section>',
      '<section class="panel"><h3>逐帧检查</h3><img data-inspector class="inspector" alt="当前帧预览" hidden><div class="row spaced"><button data-prev>← 前一帧</button><input data-cursor class="cursor-input" aria-label="定位时间码" value="0"><button data-locate>定位</button><button data-next>后一帧 →</button></div>',
      '<div class="row spaced"><button data-custom>当前帧作代表</button><button data-split>在当前帧拆分</button></div><div class="row spaced"><span class="hint">当前镜头边界</span><button data-boundary="inPoint:-1">入点 −1 帧</button><button data-boundary="inPoint:1">入点 +1 帧</button><button data-boundary="outPoint:-1">出点 −1 帧</button><button data-boundary="outPoint:1">出点 +1 帧</button></div><p data-inspect-status class="hint">点击镜头后检查首、中、尾帧；前后帧使用实际解码时间戳。</p></section></div>',
      '<section><h3>4. 拉片结果与人工复核</h3><div class="results" data-results></div></section></div>',
      '<footer><div class="row"><button data-images>生成图片节点</button><button data-shotlist class="primary">生成分镜表节点</button><button data-contact>导出联系表</button><button data-json>导出 JSON</button><button data-csv>导出 CSV</button></div><div class="hint status" data-status role="status" aria-live="polite">正在读取视频…</div></footer></main>',
    ].join('');
    const el = (name) => root.querySelector('[data-' + name + ']');
    const listen = (name, fn) => el(name).addEventListener('click', () => void action(fn));
    const status = (message, error) => { el('status').textContent = message; el('status').classList.toggle('error', Boolean(error)); };
    function controls() {
      root.querySelectorAll('button,input,select,textarea').forEach((control) => { control.disabled = state.busy; });
      el('undo').disabled = state.busy || !state.history.length;
      el('redo').disabled = state.busy || !state.redo.length;
      ['images', 'shotlist', 'contact', 'json', 'csv'].forEach((name) => { el(name).disabled = state.busy || !state.results.length; });
    }
    async function action(fn) {
      if (state.busy || disposed) return;
      state.busy = true; controls();
      try { await fn(); } catch (error) { if (!disposed) status(error instanceof Error ? error.message : String(error), true); }
      finally { if (!disposed) { state.busy = false; controls(); } }
    }
    async function effect(request) {
      const response = await props.runEffect(request);
      if (disposed) throw new Error('界面已关闭');
      if (!response.ok) throw new Error(response.error || '宿主操作失败');
      return response.value;
    }
    function invalidate() { state.results = []; state.batch = null; renderResults(); }
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
      el('inspector').hidden = false; el('inspector').src = frame.previewDataUrl;
      el('cursor').value = String(frame.actualTime);
      el('inspect-status').textContent = '实际时间 ' + formatTimecode(frame.actualTime) + ' · 帧时长 ' + frame.frameDuration.toFixed(6) + ' 秒';
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
        const select = button(String(i + 1).padStart(2, '0') + ' · ' + shot.id, async () => {
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
    }
    function renderFilmstrip() {
      el('filmstrip').replaceChildren();
      state.previews.forEach((frame) => {
        const node = button('', () => inspect(frame.actualTime));
        node.className = 'frame'; node.title = '定位 ' + formatTimecode(frame.actualTime);
        const image = element('img'); image.alt = '视频预览 ' + formatTimecode(frame.actualTime); image.src = frame.previewDataUrl;
        node.append(image, element('span', '', formatTimecode(frame.actualTime))); el('filmstrip').appendChild(node);
      });
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
      if (!state.results.length) { el('results').appendChild(element('div', 'empty', '选择镜头，抽帧后可 AI 分析或人工填写')); return; }
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
        body.appendChild(actions); card.append(image, body); el('results').appendChild(card);
      });
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
      await props.submit({ outputMode, videoDuration: state.video.duration,
        frames: state.results.map((r) => ({ ...publicFrame(r), resourceId: r.resourceId, width: r.width, height: r.height })) });
    }
    const models = (props.models || []).filter((m) => m.category === 'text' && (m.inputModalities || []).includes('image'));
    const placeholder = element('option', '', '选择视觉模型'); placeholder.value = ''; el('model').appendChild(placeholder);
    models.forEach((model) => { const option = element('option', '', model.name + ' · ' + model.provider); option.value = model.id; el('model').appendChild(option); });
    const parameters = props.parameters || {};
    el('model').value = models.some((m) => m.id === parameters.model) ? parameters.model : '';
    el('prompt').value = parameters.prompt || DEFAULT_PROMPT; el('prompt').maxLength = 8000;
    root.querySelectorAll('[data-mode]').forEach((tab) => tab.addEventListener('click', () => {
      if (state.busy) return; state.mode = tab.dataset.mode;
      root.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === tab));
      root.querySelectorAll('[data-group]').forEach((group) => {
        const name = group.dataset.group; group.hidden = name === 'range' ? state.mode === 'manual' : name === 'step' ? state.mode !== 'interval' : name !== state.mode;
      });
    }));
    listen('apply', applySampling);
    listen('extract', async () => { await prepareFrames(); status('抽帧完成，可人工填写并确认，或继续 AI 拉片。'); });
    listen('analyze', analyze);
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
    listen('images', () => submit('images')); listen('shotlist', () => submit('shotlist'));
    listen('json', () => exportReport('json')); listen('csv', () => exportReport('csv'));
    listen('contact', async () => {
      assertComplete();
      const id = state.batch.value.contactSheetResourceId; if (!id) throw new Error('没有联系表资源');
      const saved = await effect({ type: 'resource.export', resourceId: id, suggestedName: 'frame-review-contact.jpg' });
      status('已保存到项目：' + saved.fileName);
    });
    const strip = el('filmstrip');
    const scrollStrip = (delta) => strip.scrollBy({ left: delta, behavior: 'smooth' });
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
    });
    return function cleanup() { disposed = true; window.removeEventListener('ai-canvas-theme-change', themeListener); root.replaceChildren(); };
  };
})();
