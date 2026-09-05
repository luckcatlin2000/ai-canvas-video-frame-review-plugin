import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(source, { window: { __AI_CANVAS_PLUGIN_HOST__: { exports } } });
const api = exports.FrameReviewLogic;
const shot = (id, start, end, selected = true) => ({ id, inPoint: start, outPoint: end, selected, role: 'middle' });
const json = (value) => JSON.parse(JSON.stringify(value));

test('时间码拒绝空值、负数和无效分秒，保留真实精度', () => {
  assert.equal(api.parseTimecode('01:02.125'), 62.125);
  assert.equal(api.parseTimecode('0.0333666667'), 0.0333666667);
  ['', '-1', '00:60', 'abc', '1:2:3:4', '1::2'].forEach((value) => assert.ok(Number.isNaN(api.parseTimecode(value))));
});
test('首中尾时间位于开区间，指定帧不得越界', () => {
  const value = shot('s1', 1, 2);
  assert.equal(api.sampleTime({ ...value, role: 'start' }), 1);
  assert.equal(api.sampleTime(value), 1.5);
  assert.ok(api.sampleTime({ ...value, role: 'end' }) < 2);
  assert.throws(() => api.validateShots([{ ...value, role: 'custom', customTime: 2 }], 3), /代表帧/);
});
test('拆分保留左侧 ID，合并保留首镜 ID 且不跨越未选镜头', () => {
  const original = [shot('s1', 0, 4), shot('s2', 4, 6)];
  const split = api.splitShot(original, 's1', 2, 'new');
  assert.equal(split[0].id, 's1'); assert.equal(split[1].id, 'new'); assert.equal(split[1].selected, false);
  assert.equal(original[0].outPoint, 4);
  assert.throws(() => api.mergeShots(split), /连续/);
  split.forEach((s) => { s.selected = true; });
  const merged = api.mergeShots(split);
  assert.equal(merged.length, 1); assert.equal(merged[0].id, 's1'); assert.equal(merged[0].outPoint, 6);
});
test('边界调整同步邻接点，零长度和超过 24 镜不接受', () => {
  const shots = [shot('s1', 0, 1), shot('s2', 1, 2)];
  const moved = api.moveBoundary(shots, 1, 'inPoint', 1.0333667);
  assert.equal(moved[0].outPoint, moved[1].inPoint);
  assert.doesNotThrow(() => api.validateShots(moved, 2));
  assert.throws(() => api.validateShots(api.moveBoundary(shots, 1, 'inPoint', 2), 2), /区间/);
  assert.throws(() => api.validateShots(Array.from({ length: 25 }, (_, i) => shot('s' + i, i, i + 1)), 30), /24/);
});
test('AI 重试保留人工字段，缺失置信度为 null，保存新原文', () => {
  const result = { content: '人工内容', camera: '旧运镜', overrideFields: ['content'], reviewStatus: 'reviewed' };
  const merged = api.mergeAnalysis(result, { content: '新 AI 内容', camera: '固定' });
  assert.equal(merged.content, '人工内容'); assert.equal(merged.camera, '固定');
  assert.equal(merged.aiOriginal.content, '新 AI 内容'); assert.equal(merged.confidence, null);
  assert.equal(merged.reviewStatus, 'edited');
  assert.throws(() => api.parseAnalysisJson('{"frames":[{"key":"a"},{"key":"a"}]}'), /重复/);
});
test('报告不含资源和图片数据，CSV 转义引号、换行及公式注入', () => {
  const frame = api.publicFrame({ shotId: 's1', content: '=HYPERLINK("x")\n正文', previewDataUrl: 'secret', resourceId: 'opaque', filePath: 'secret' });
  assert.deepEqual(json(frame), { shotId: 's1', content: '=HYPERLINK("x")\n正文' });
  const csv = api.reportCsv({ source: { nodeId: 'video', name: '+危险名' }, frames: [frame] });
  assert.ok(csv.includes("'+危险名")); assert.ok(csv.includes("'=HYPERLINK(")); assert.ok(csv.includes('""x""'));
  assert.equal(csv.includes('opaque'), false);
});

test('布局显式限制横向宽度并提供滚轮、键盘和按钮浏览', () => {
  assert.match(source, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(source, /\.workspace\{[^}]*min-height:0[^}]*overflow:auto/);
  assert.match(source, /\.filmstrip\{[^}]*min-width:0[^}]*overflow-x:auto/);
  assert.match(source, /strip.addEventListener\('wheel'/);
  assert.match(source, /strip.addEventListener\('keydown'/);
  assert.match(source, /data-left/); assert.match(source, /data-right/);
});

test('紧凑间距和小尺寸控件不压缩画面或移除隐藏规则', () => {
  assert.match(source, /\.workspace\{[^}]*padding:8px/);
  assert.match(source, /\.panel\{[^}]*padding:8px;margin-bottom:8px/);
  assert.match(source, /button\{min-height:28px;[^}]*padding:4px 8px;font-size:12px;line-height:18px/);
  assert.match(source, /input,select\{height:28px\}/);
  assert.match(source, /input\[type=checkbox\]\{width:14px;height:14px/);
  assert.match(source, /\.frame img\{width:100%;height:88px;object-fit:contain/);
  assert.match(source, /\.app \[hidden\]\{display:none\}/);
});

test('胶片按实际时间映射镜头勾选，边界属于下一镜头，区间外不误选', () => {
  const shots = [shot('s1', 0, 1.5), shot('s2', 1.5, 3, false), shot('s3', 4, 5)];
  assert.deepEqual(json(api.filmstripState(shots, 0.833, null)), { shotId: 's1', selected: true, current: false });
  assert.equal(api.filmstripState(shots, 1.499999).shotId, 's1');
  assert.deepEqual(json(api.filmstripState(shots, 1.5, 1.5)), { shotId: 's2', selected: false, current: true });
  assert.deepEqual(json(api.filmstripState(shots, 3.5, 0)), { shotId: '', selected: false, current: false });
  assert.equal(api.filmstripState(shots, 5).shotId, '');
  assert.equal(api.filmstripState(shots, 0, null).current, false);
});

test('勾选和拆分后胶片状态同步，定位不修改选中集合', () => {
  const original = [shot('s1', 0, 4)];
  const split = api.splitShot(original, 's1', 2, 's2');
  assert.equal(api.filmstripState(split, 2.5, 2.5).selected, false);
  const selected = split.map((s) => ({ ...s, selected: true }));
  assert.equal(api.filmstripState(selected, 2.5, 2.5).selected, true);
  assert.equal(api.filmstripState(split, 2.5).selected, false);
  assert.deepEqual(json(original), [shot('s1', 0, 4)]);
  assert.match(source, /function renderShots\(\)[\s\S]*?syncFilmstrip\(\);/);
  assert.match(source, /async function inspect\([\s\S]*?syncFilmstrip\(\);/);
});

test('胶片勾选和当前查看使用独立标记，输出按钮靠右且允许换行', () => {
  assert.match(source, /frame--selected/);
  assert.match(source, /frame--unselected/);
  assert.match(source, /data-frame-current/);
  assert.match(source, /aria-current/);
  assert.match(source, /\.footer-actions\{justify-content:flex-end\}/);
  assert.match(source, /class="row footer-actions"/);
  assert.match(source, /\.row\{display:flex;flex-wrap:wrap/);
});

test('结果区有阶段提示和每帧加载动画，尊重减少动态效果设置', () => {
  assert.match(source, /data-result-section aria-busy="false"/);
  assert.match(source, /data-loading hidden role="status" aria-live="polite"/);
  assert.match(source, /data-loading-label/);
  assert.match(source, /data-card-loading/);
  assert.match(source, /\.status--busy::before\{[^}]*animation:frame-review-spin/);
  assert.match(source, /animation:frame-review-spin \.8s linear infinite/);
  assert.match(source, /@media\(prefers-reduced-motion:reduce\)\{\.spinner\{animation:none\}\}/);
  assert.match(source, /正在保存画面并生成图片节点/);
  assert.match(source, /正在保存画面并生成分镜表节点/);
});

test('忙碌期间新渲染的表单也禁用，异常与成功都在 finally 清除加载状态', () => {
  const render = source.slice(source.indexOf('    function renderResults()'), source.indexOf('    async function prepareFrames()'));
  assert.match(render, /controls\(\);\s*\}/);
  assert.match(source, /el\('loading'\)\.hidden = !state\.busy/);
  assert.match(source, /overlay\.hidden = !state\.busy/);
  assert.match(source, /finally \{ if \(!disposed\) \{ state\.busy = false; state\.loadingMessage = ''; controls\(\); \} \}/);
});
