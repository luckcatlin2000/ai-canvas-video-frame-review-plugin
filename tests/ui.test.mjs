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
