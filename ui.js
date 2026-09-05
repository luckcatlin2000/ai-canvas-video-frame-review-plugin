(function () {
  const DEFAULT_PROMPT = '请按镜头语言分析每一帧：景别、运镜、画面内容、可见台词线索、声音线索、转场建议与备注。仅依据画面判断；无法确认的台词和声音必须写“无法从画面判断”。';
  const MAX_FRAMES = 24;

  function formatTimecode(seconds) {
    const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const secs = Math.floor((milliseconds % 60000) / 1000);
    const ms = milliseconds % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  function parseTimecode(raw) {
    const value = String(raw || '').trim();
    if (!value) return Number.NaN;
    const parts = value.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return Number.NaN;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2 && parts[1] < 60) return parts[0] * 60 + parts[1];
    if (parts.length === 3 && parts[1] < 60 && parts[2] < 60) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return Number.NaN;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function textValue(value, fallback, maxLength) {
    if (typeof value !== 'string') return fallback;
    const text = value.trim();
    return (text || fallback).slice(0, maxLength);
  }

  function parseAnalysisJson(text) {
    const source = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (!parsed || !Array.isArray(parsed.frames)) throw new Error('模型 JSON 缺少 frames 数组');
    return parsed.frames;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  window.__AI_CANVAS_PLUGIN_HOST__.exports.VideoFrameReview = function mount(root, props) {
    let disposed = false;
    const state = {
      video: null,
      previewFrames: [],
      selectedTimes: [],
      results: [],
      analysisBatch: null,
      busy: false,
      method: 'uniform',
    };

    root.innerHTML = `
      <style>
        :root { color-scheme: dark; --bg:#101018; --panel:#181824; --card:#1e1e2b; --line:#303044; --text:#ececf2; --muted:#9a9aac; --soft:#727287; --accent:#7c6df2; --accent2:#a79dff; --danger:#ff7f8e; --success:#63d3a6; --shadow:0 16px 40px rgba(0,0,0,.2); }
        :root[data-theme="light"] { color-scheme: light; --bg:#f7f5fb; --panel:#fffafd; --card:#f2eff8; --line:#ddd7e7; --text:#34303d; --muted:#746e7f; --soft:#948da0; --accent:#7165d8; --accent2:#675bbf; --danger:#c84d60; --success:#258c69; --shadow:0 16px 36px rgba(92,74,116,.12); }
        * { box-sizing:border-box; }
        html, body { margin:0; height:100%; overflow:hidden; background:var(--bg); color:var(--text); font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; }
        button, input, select, textarea { font:inherit; }
        button { color:inherit; }
        .app { display:grid; grid-template-rows:auto auto 1fr auto; height:100%; background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 6%,var(--bg)),var(--bg) 42%); }
        .setup { display:grid; grid-template-columns:1.05fr .95fr; gap:12px; padding:12px 14px 10px; border-bottom:1px solid var(--line); background:color-mix(in srgb,var(--panel) 92%,transparent); }
        .panel { min-width:0; border:1px solid var(--line); border-radius:12px; background:color-mix(in srgb,var(--panel) 96%,transparent); padding:11px; box-shadow:var(--shadow); }
        .panel-title { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:9px; font-size:12px; font-weight:700; }
        .badge { border:1px solid color-mix(in srgb,var(--accent) 42%,var(--line)); border-radius:999px; padding:2px 8px; color:var(--accent2); font-size:10px; font-weight:600; }
        .tabs { display:flex; gap:4px; margin-bottom:9px; padding:3px; border-radius:9px; background:var(--card); }
        .tab { flex:1; border:0; border-radius:7px; padding:6px 4px; background:transparent; color:var(--muted); cursor:pointer; font-size:11px; }
        .tab.active { background:var(--accent); color:white; box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 35%,transparent); }
        .fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; align-items:end; }
        .field { display:flex; min-width:0; flex-direction:column; gap:4px; color:var(--muted); font-size:10px; }
        .field.wide { grid-column:1/-1; }
        input, select, textarea { width:100%; min-width:0; border:1px solid var(--line); border-radius:8px; outline:none; background:var(--card); color:var(--text); padding:7px 8px; font-size:11px; }
        input:focus, select:focus, textarea:focus { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 15%,transparent); }
        textarea { resize:vertical; line-height:1.45; }
        .method-fields[hidden] { display:none; }
        .row { display:flex; align-items:center; gap:7px; }
        .row-spaced { margin-top:8px; }
        .prompt-field { margin-top:8px; }
        .button { border:1px solid var(--line); border-radius:9px; background:var(--card); padding:7px 10px; cursor:pointer; font-size:11px; font-weight:600; transition:.15s ease; }
        .button:hover:not(:disabled) { transform:translateY(-1px); border-color:color-mix(in srgb,var(--accent) 55%,var(--line)); }
        .button.primary { border-color:transparent; background:linear-gradient(135deg,var(--accent),#5a9ee8); color:white; }
        .button.success { border-color:transparent; background:linear-gradient(135deg,#2fa77c,#4e8ccf); color:white; }
        .button:disabled { cursor:not-allowed; opacity:.5; }
        .selection-summary { display:flex; min-height:28px; max-height:54px; gap:5px; margin-top:8px; overflow:auto; flex-wrap:wrap; align-content:flex-start; }
        .time-chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--line); border-radius:999px; background:var(--card); padding:3px 7px; color:var(--muted); font-size:9px; }
        .time-chip button { border:0; background:transparent; color:var(--soft); padding:0; cursor:pointer; }
        .model-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; align-items:end; }
        .prompt { min-height:67px; max-height:94px; }
        .hint { margin-top:6px; color:var(--soft); font-size:9px; line-height:1.45; }
        .filmstrip-section { padding:9px 14px; border-bottom:1px solid var(--line); }
        .section-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:7px; }
        .section-title { font-size:11px; font-weight:700; }
        .status { color:var(--muted); font-size:9px; }
        .status.error { color:var(--danger); }
        .filmstrip { display:flex; min-height:78px; gap:7px; overflow-x:auto; padding-bottom:3px; }
        .frame-button { position:relative; flex:0 0 126px; overflow:hidden; border:1px solid var(--line); border-radius:9px; background:var(--card); padding:0; cursor:pointer; }
        .frame-button img { display:block; width:100%; height:70px; object-fit:cover; background:#08080c; }
        .frame-button span { display:block; overflow:hidden; padding:4px 6px; color:var(--muted); font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
        .frame-button.selected { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent); }
        .frame-button.selected::after { content:'✓'; position:absolute; top:5px; right:5px; display:grid; width:18px; height:18px; place-items:center; border-radius:50%; background:var(--accent); color:#fff; font-size:10px; }
        .empty { display:grid; width:100%; min-height:72px; place-items:center; border:1px dashed var(--line); border-radius:10px; color:var(--soft); font-size:10px; }
        .results { min-height:0; overflow:auto; padding:11px 14px 16px; }
        .result-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
        .result-card { min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:11px; background:var(--panel); box-shadow:var(--shadow); }
        .result-card.invalid { border-color:color-mix(in srgb,var(--danger) 60%,var(--line)); }
        .result-image { position:relative; aspect-ratio:16/9; background:#08080c; }
        .result-image img { width:100%; height:100%; object-fit:cover; }
        .result-time { position:absolute; left:6px; bottom:6px; border-radius:6px; background:rgba(0,0,0,.72); padding:3px 6px; color:#fff; font-size:9px; }
        .result-body { display:grid; grid-template-columns:1fr 1fr; gap:7px; padding:9px; }
        .result-body .wide { grid-column:1/-1; }
        .result-body textarea { min-height:48px; }
        .card-error { grid-column:1/-1; color:var(--danger); font-size:9px; }
        .footer { display:none; align-items:center; justify-content:space-between; gap:10px; border-top:1px solid var(--line); background:color-mix(in srgb,var(--panel) 96%,transparent); padding:10px 14px; }
        .footer.visible { display:flex; }
        .footer-note { color:var(--muted); font-size:9px; }
        .spinner { display:inline-block; width:11px; height:11px; margin-right:5px; vertical-align:-2px; border:2px solid rgba(255,255,255,.35); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        @media (max-width:680px) { .setup { grid-template-columns:1fr; } .result-grid { grid-template-columns:1fr 1fr; } }
        @media (max-width:480px) { .result-grid { grid-template-columns:1fr; } .fields { grid-template-columns:1fr 1fr; } }
      </style>
      <main class="app">
        <section class="setup">
          <div class="panel">
            <div class="panel-title"><span>1. 选择画面</span><span class="badge" data-selection-count>0 / 24</span></div>
            <div class="tabs">
              <button class="tab active" data-method="uniform" type="button">均匀</button>
              <button class="tab" data-method="interval" type="button">区间</button>
              <button class="tab" data-method="manual" type="button">时间码</button>
            </div>
            <div class="method-fields" data-fields="uniform">
              <div class="fields"><label class="field wide">抽取数量<input data-uniform-count type="number" min="1" max="24" value="8"></label></div>
            </div>
            <div class="method-fields" data-fields="interval" hidden>
              <div class="fields">
                <label class="field">开始（秒）<input data-interval-start type="number" min="0" step="0.001" value="0"></label>
                <label class="field">结束（秒）<input data-interval-end type="number" min="0" step="0.001"></label>
                <label class="field">间隔（秒）<input data-interval-step type="number" min="0.04" step="0.01" value="2"></label>
              </div>
            </div>
            <div class="method-fields" data-fields="manual" hidden>
              <label class="field">每行一个时间码，也可用逗号分隔<textarea data-manual-times rows="2" placeholder="00:00:01.500&#10;00:00:04.000"></textarea></label>
            </div>
            <div class="row row-spaced"><button class="button" data-apply-selection type="button">应用选择</button><span class="hint">也可直接点击下方胶片帧增删。</span></div>
            <div class="selection-summary" data-selection-summary></div>
          </div>
          <div class="panel">
            <div class="panel-title"><span>2. 视觉分析</span><span class="badge">单次联系表</span></div>
            <div class="model-row">
              <label class="field">视觉文本模型<select data-model></select></label>
              <button class="button primary" data-analyze type="button">开始拉片</button>
            </div>
            <label class="field prompt-field">分析要求<textarea class="prompt" data-prompt>${DEFAULT_PROMPT}</textarea></label>
            <div class="hint">插件只会把选中帧组成一张带编号联系表交给模型；模型费用取决于你配置的厂商。</div>
          </div>
        </section>
        <section class="filmstrip-section">
          <div class="section-head"><span class="section-title">视频胶片</span><span class="status" data-status>正在读取视频…</span></div>
          <div class="filmstrip" data-filmstrip><div class="empty">正在批量抽取时间轴预览</div></div>
        </section>
        <section class="results">
          <div class="section-head"><span class="section-title">拉片结果</span><span class="status" data-result-status>分析后可逐项编辑</span></div>
          <div class="result-grid" data-results><div class="empty">选择画面并开始拉片，结果会显示在这里</div></div>
        </section>
        <footer class="footer" data-footer>
          <span class="footer-note">生成操作会一次写入，可用一次撤销恢复。</span>
          <div class="row"><button class="button" data-submit-images type="button">仅生成图片节点</button><button class="button success" data-submit-shotlist type="button">生成分镜表</button></div>
        </footer>
      </main>`;

    const elements = {
      count: root.querySelector('[data-selection-count]'),
      summary: root.querySelector('[data-selection-summary]'),
      filmstrip: root.querySelector('[data-filmstrip]'),
      status: root.querySelector('[data-status]'),
      resultStatus: root.querySelector('[data-result-status]'),
      results: root.querySelector('[data-results]'),
      footer: root.querySelector('[data-footer]'),
      model: root.querySelector('[data-model]'),
      prompt: root.querySelector('[data-prompt]'),
      analyze: root.querySelector('[data-analyze]'),
      uniformCount: root.querySelector('[data-uniform-count]'),
      intervalStart: root.querySelector('[data-interval-start]'),
      intervalEnd: root.querySelector('[data-interval-end]'),
      intervalStep: root.querySelector('[data-interval-step]'),
      manualTimes: root.querySelector('[data-manual-times]'),
    };

    const videoResource = (props.resources && props.resources.self || []).find((resource) => String(resource.mediaType || '').startsWith('video/'));
    const visionModels = (props.models || []).filter((model) => model.category === 'text' && Array.isArray(model.inputModalities) && model.inputModalities.includes('image'));
    elements.model.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = visionModels.length ? '请选择视觉模型' : '暂无支持图片输入的文本模型';
    elements.model.appendChild(placeholder);
    visionModels.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.name} · ${model.provider}`;
      elements.model.appendChild(option);
    });
    const parameterModel = typeof props.parameters.model === 'string' ? props.parameters.model : '';
    elements.model.value = visionModels.some((model) => model.id === parameterModel) ? parameterModel : (visionModels[0] && visionModels[0].id || '');
    if (typeof props.parameters.prompt === 'string' && props.parameters.prompt.trim()) elements.prompt.value = props.parameters.prompt;

    function setStatus(message, error) {
      elements.status.textContent = message;
      elements.status.classList.toggle('error', Boolean(error));
    }

    function setBusy(busy, label) {
      state.busy = busy;
      root.querySelectorAll('button, input, select, textarea').forEach((control) => {
        control.disabled = busy;
      });
      elements.analyze.innerHTML = busy ? `<span class="spinner"></span>${label || '处理中'}` : '开始拉片';
    }

    function normalizedTimes(times) {
      const duration = state.video ? state.video.duration : Number.POSITIVE_INFINITY;
      const maximum = Number.isFinite(duration) ? Math.max(0, duration - Math.min(0.001, duration / 1000)) : duration;
      const unique = new Map();
      times.forEach((rawTime) => {
        const time = Number(rawTime);
        if (!Number.isFinite(time) || time < 0 || time > maximum) return;
        const normalized = Math.round(time * 1000) / 1000;
        unique.set(normalized.toFixed(3), normalized);
      });
      return [...unique.values()].sort((a, b) => a - b).slice(0, MAX_FRAMES);
    }

    function renderSelection() {
      elements.count.textContent = `${state.selectedTimes.length} / ${MAX_FRAMES}`;
      elements.summary.replaceChildren();
      state.selectedTimes.forEach((time) => {
        const chip = createElement('span', 'time-chip');
        chip.appendChild(document.createTextNode(formatTimecode(time)));
        const remove = createElement('button', '', '×');
        remove.type = 'button';
        remove.title = '移除此帧';
        remove.addEventListener('click', () => {
          state.selectedTimes = state.selectedTimes.filter((value) => value !== time);
          renderSelection();
          renderFilmstrip();
        });
        chip.appendChild(remove);
        elements.summary.appendChild(chip);
      });
      if (!state.selectedTimes.length) elements.summary.appendChild(createElement('span', 'hint', '尚未选择画面'));
    }

    function isSelected(time) {
      return state.selectedTimes.some((selected) => Math.abs(selected - time) < 0.0005);
    }

    function renderFilmstrip() {
      elements.filmstrip.replaceChildren();
      if (!state.previewFrames.length) {
        elements.filmstrip.appendChild(createElement('div', 'empty', '没有可显示的时间轴预览'));
        return;
      }
      state.previewFrames.forEach((frame) => {
        const button = createElement('button', `frame-button${isSelected(frame.requestedTime) ? ' selected' : ''}`);
        button.type = 'button';
        button.title = `选择 ${formatTimecode(frame.requestedTime)}`;
        const image = document.createElement('img');
        image.alt = `视频帧 ${formatTimecode(frame.requestedTime)}`;
        image.src = frame.previewDataUrl;
        button.append(image, createElement('span', '', formatTimecode(frame.actualTime)));
        button.addEventListener('click', () => {
          if (isSelected(frame.requestedTime)) {
            state.selectedTimes = state.selectedTimes.filter((value) => Math.abs(value - frame.requestedTime) >= 0.0005);
          } else if (state.selectedTimes.length >= MAX_FRAMES) {
            setStatus(`最多选择 ${MAX_FRAMES} 帧`, true);
            return;
          } else {
            state.selectedTimes = normalizedTimes([...state.selectedTimes, frame.requestedTime]);
          }
          renderSelection();
          renderFilmstrip();
        });
        elements.filmstrip.appendChild(button);
      });
    }

    function applySelection() {
      if (!state.video) throw new Error('视频信息尚未就绪');
      let times = [];
      if (state.method === 'uniform') {
        const count = Math.round(finiteNumber(elements.uniformCount.value, 8));
        if (count < 1 || count > MAX_FRAMES) throw new Error(`均匀抽帧数量必须在 1-${MAX_FRAMES} 之间`);
        times = Array.from({ length: count }, (_, index) => state.video.duration * index / count);
      } else if (state.method === 'interval') {
        const start = finiteNumber(elements.intervalStart.value, Number.NaN);
        const end = finiteNumber(elements.intervalEnd.value, Number.NaN);
        const step = finiteNumber(elements.intervalStep.value, Number.NaN);
        if (![start, end, step].every(Number.isFinite) || start < 0 || end < start || end > state.video.duration || step < 0.04) {
          throw new Error('区间参数无效：请检查开始、结束与间隔');
        }
        for (let time = start; time <= end + 0.0001; time += step) {
          times.push(time);
          if (times.length > MAX_FRAMES) throw new Error(`区间内超过 ${MAX_FRAMES} 帧，请增大间隔`);
        }
      } else {
        const tokens = String(elements.manualTimes.value || '').split(/[\n,，;；]+/).map((token) => token.trim()).filter(Boolean);
        if (!tokens.length) throw new Error('请至少填写一个时间码');
        times = tokens.map((token) => {
          const time = parseTimecode(token);
          if (!Number.isFinite(time)) throw new Error(`无法识别时间码：${token}`);
          return time;
        });
      }
      const normalized = normalizedTimes(times);
      if (!normalized.length) throw new Error('没有位于视频范围内的时间点');
      if (normalized.length !== times.length) throw new Error('时间点存在重复或超出视频范围，请修正后重试');
      state.selectedTimes = normalized;
      renderSelection();
      renderFilmstrip();
      setStatus(`已选择 ${normalized.length} 帧`, false);
    }

    function buildPrompt(frames) {
      const frameList = frames.map((frame) => `${frame.key}=${formatTimecode(frame.actualTime)}`).join('，');
      return `${String(elements.prompt.value || DEFAULT_PROMPT).trim()}\n\n联系表中的标题已经标出 key 与实际时间：${frameList}。\n只输出一个 JSON 对象，禁止 Markdown 和额外解释，结构如下：\n{"frames":[{"key":"frame-01","shotSize":"景别","camera":"运镜","content":"画面内容","dialogue":"可见台词；无法确认则写无法从画面判断","audio":"声音；无法确认则写无法从画面判断","transition":"切/叠化/淡入淡出或其他建议","duration":2.0,"note":"备注","confidence":0.8}]}\nframes 必须逐项覆盖上述全部 key，顺序一致；duration 单位为秒，confidence 为 0 到 1。不要臆测画面中不可见的声音或台词。`;
    }

    function createEditor(label, key, value, multiline, result) {
      const wrapper = createElement('label', `field${multiline ? ' wide' : ''}`, label);
      const control = document.createElement(multiline ? 'textarea' : 'input');
      control.value = value;
      if (!multiline) control.type = key === 'duration' ? 'number' : 'text';
      if (key === 'duration') {
        control.min = '0.04';
        control.step = '0.01';
      }
      control.addEventListener('input', () => {
        result[key] = key === 'duration' ? Math.max(0, finiteNumber(control.value, 0)) : control.value.slice(0, key === 'content' ? 2000 : 1000);
      });
      wrapper.appendChild(control);
      return wrapper;
    }

    function renderResults() {
      elements.results.replaceChildren();
      state.results.forEach((result) => {
        const card = createElement('article', `result-card${result.analysisError ? ' invalid' : ''}`);
        const imageWrap = createElement('div', 'result-image');
        const image = document.createElement('img');
        image.src = result.previewDataUrl;
        image.alt = `${result.key} ${formatTimecode(result.actualTime)}`;
        imageWrap.append(image, createElement('span', 'result-time', `${result.key} · ${formatTimecode(result.actualTime)}`));
        const body = createElement('div', 'result-body');
        body.append(
          createEditor('景别', 'shotSize', result.shotSize, false, result),
          createEditor('运镜', 'camera', result.camera, false, result),
          createEditor('画面内容', 'content', result.content, true, result),
          createEditor('台词', 'dialogue', result.dialogue, true, result),
          createEditor('声音', 'audio', result.audio, true, result),
          createEditor('转场', 'transition', result.transition, false, result),
          createEditor('时长（秒）', 'duration', String(result.duration), false, result),
          createEditor('备注', 'note', result.note, true, result),
        );
        if (result.analysisError) body.appendChild(createElement('div', 'card-error', result.analysisError));
        card.append(imageWrap, body);
        elements.results.appendChild(card);
      });
      if (!state.results.length) elements.results.appendChild(createElement('div', 'empty', '暂无拉片结果'));
      elements.footer.classList.toggle('visible', state.results.length > 0);
      elements.resultStatus.textContent = state.results.length ? `${state.results.length} 帧，可直接修改后生成节点` : '分析后可逐项编辑';
    }

    async function analyze() {
      if (state.busy) return;
      try {
        if (!videoResource) throw new Error('当前节点没有可读取的视频资源');
        if (!elements.model.value) throw new Error('请先配置并选择支持图片输入的文本模型');
        if (!state.selectedTimes.length) throw new Error('请至少选择一个画面');
        setBusy(true, '抽帧中');
        setStatus('正在按选定时间批量抽帧…', false);
        const samples = state.selectedTimes.map((time, index) => ({ key: `frame-${String(index + 1).padStart(2, '0')}`, time }));
        const signature = samples.map((sample) => `${sample.key}:${sample.time.toFixed(3)}`).join('|');
        let value = state.analysisBatch && state.analysisBatch.signature === signature ? state.analysisBatch.value : null;
        if (!value) {
          const extraction = await props.runEffect({ type: 'video.extractFrames', resourceId: videoResource.resourceId, mode: 'analysis', samples });
          if (disposed) return;
          if (!extraction.ok) throw new Error(extraction.error || '批量抽帧失败');
          value = extraction.value || {};
          state.analysisBatch = { signature, value };
        }
        const extractedFrames = Array.isArray(value.frames) ? value.frames.filter((frame) => frame && frame.resourceId && !frame.error) : [];
        if (!extractedFrames.length) throw new Error('所选时间点均没有可解码画面');
        if (!value.contactSheetResourceId) throw new Error('宿主没有返回联系表资源');

        setBusy(true, '分析中');
        setStatus(`已抽取 ${extractedFrames.length} 帧，正在调用视觉模型…`, false);
        const modelResult = await props.runEffect({
          type: 'model.generate',
          modelId: elements.model.value,
          prompt: buildPrompt(extractedFrames),
          resourceIds: [value.contactSheetResourceId],
        });
        if (disposed) return;
        if (!modelResult.ok) throw new Error(modelResult.error || '视觉模型调用失败');
        const modelFrames = parseAnalysisJson(modelResult.value && modelResult.value.text);
        const byKey = new Map(modelFrames.filter((item) => item && typeof item === 'object').map((item) => [String(item.key || ''), item]));
        state.video = value.video || state.video;
        state.results = extractedFrames.map((frame, index) => {
          const analysis = byKey.get(frame.key);
          const next = extractedFrames[index + 1];
          const fallbackDuration = next && next.actualTime > frame.actualTime
            ? next.actualTime - frame.actualTime
            : Math.max(0.04, finiteNumber(state.video && state.video.duration, frame.actualTime + frame.frameDuration) - frame.actualTime || frame.frameDuration || 1);
          return {
            key: frame.key,
            resourceId: frame.resourceId,
            requestedTime: frame.requestedTime,
            actualTime: frame.actualTime,
            frameDuration: frame.frameDuration,
            width: frame.width,
            height: frame.height,
            previewDataUrl: frame.previewDataUrl,
            shotSize: textValue(analysis && analysis.shotSize, '未标注', 80),
            camera: textValue(analysis && analysis.camera, '未标注', 240),
            content: textValue(analysis && analysis.content, '未返回分析', 2000),
            dialogue: textValue(analysis && analysis.dialogue, '无法从画面判断', 1000),
            audio: textValue(analysis && analysis.audio, '无法从画面判断', 1000),
            transition: textValue(analysis && analysis.transition, '切', 80),
            duration: Math.max(0.04, finiteNumber(analysis && analysis.duration, fallbackDuration)),
            note: textValue(analysis && analysis.note, '', 1000),
            confidence: Math.max(0, Math.min(1, finiteNumber(analysis && analysis.confidence, 0))),
            analysisError: analysis ? '' : `模型未返回 ${frame.key}，请人工补充`,
          };
        });
        renderResults();
        setStatus(`拉片完成：${state.results.length} 帧`, false);
        await props.setParameters({ model: elements.model.value, prompt: elements.prompt.value });
        await props.toast('逐帧拉片分析完成', 'success');
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : '逐帧拉片失败', true);
      } finally {
        if (!disposed) setBusy(false);
      }
    }

    async function submit(outputMode) {
      if (state.busy || !state.results.length) return;
      try {
        setBusy(true, '写入中');
        await props.submit({
          outputMode,
          videoDuration: finiteNumber(state.video && state.video.duration, 0),
          frames: state.results.map((result) => ({
            key: result.key,
            resourceId: result.resourceId,
            requestedTime: result.requestedTime,
            actualTime: result.actualTime,
            frameDuration: result.frameDuration,
            width: result.width,
            height: result.height,
            shotSize: result.shotSize,
            camera: result.camera,
            content: result.content,
            dialogue: result.dialogue,
            audio: result.audio,
            transition: result.transition,
            duration: result.duration,
            note: result.note,
            confidence: result.confidence,
            analysisError: result.analysisError,
          })),
        });
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : '节点生成失败', true);
        if (!disposed) setBusy(false);
      }
    }

    root.querySelectorAll('[data-method]').forEach((button) => {
      button.addEventListener('click', () => {
        state.method = button.dataset.method;
        root.querySelectorAll('[data-method]').forEach((item) => item.classList.toggle('active', item === button));
        root.querySelectorAll('[data-fields]').forEach((group) => { group.hidden = group.dataset.fields !== state.method; });
      });
    });
    root.querySelector('[data-apply-selection]').addEventListener('click', () => {
      try { applySelection(); } catch (error) { setStatus(error instanceof Error ? error.message : '选帧参数无效', true); }
    });
    elements.analyze.addEventListener('click', () => void analyze());
    root.querySelector('[data-submit-images]').addEventListener('click', () => void submit('images'));
    root.querySelector('[data-submit-shotlist]').addEventListener('click', () => void submit('shotlist'));

    const themeListener = (event) => {
      if (event && event.detail && (event.detail.theme === 'dark' || event.detail.theme === 'light')) {
        document.documentElement.dataset.theme = event.detail.theme;
      }
    };
    window.addEventListener('ai-canvas-theme-change', themeListener);

    void (async () => {
      if (!videoResource) {
        setStatus('当前节点没有可读取的视频资源', true);
        return;
      }
      try {
        setBusy(true, '读取中');
        const result = await props.runEffect({ type: 'video.extractFrames', resourceId: videoResource.resourceId, mode: 'preview', count: 12 });
        if (disposed) return;
        if (!result.ok) throw new Error(result.error || '视频预览抽帧失败');
        const value = result.value || {};
        state.video = value.video;
        state.previewFrames = Array.isArray(value.frames) ? value.frames.filter((frame) => frame && frame.previewDataUrl && !frame.error) : [];
        elements.intervalEnd.value = String(Math.max(0, finiteNumber(state.video && state.video.duration, 0)).toFixed(3));
        applySelection();
        renderFilmstrip();
        setStatus(`${formatTimecode(state.video.duration)} · ${state.video.width}×${state.video.height} · ${state.video.videoCodec || '未知编码'}`, false);
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : '视频读取失败', true);
      } finally {
        if (!disposed) setBusy(false);
      }
    })();

    return function cleanup() {
      disposed = true;
      window.removeEventListener('ai-canvas-theme-change', themeListener);
      root.replaceChildren();
    };
  };
})();
