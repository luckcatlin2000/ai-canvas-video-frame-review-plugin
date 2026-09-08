import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(source, { window: { __AI_CANVAS_PLUGIN_HOST__: { exports } } });
const { LOCALES, MESSAGES, translate, normalizeLocale, bindLocale } = exports.FrameReviewLocale;

test('四种语言、旧宿主回落与占位符完整', () => {
  assert.deepEqual([...LOCALES], ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  for (const value of [undefined, null, 'fr-FR', '<script>']) assert.equal(normalizeLocale(value), 'zh-CN');
  for (const [key, values] of Object.entries(MESSAGES)) {
    assert.equal(values.length, 3);
    const slots = text => [...new Set(text.match(/\{\d+\}/g) || [])].sort();
    for (const value of values) {
      assert.ok(value.length > 0);
      assert.deepEqual(slots(value), slots(key), key);
    }
  }
  assert.equal(translate('开始 AI 拉片', undefined), '开始 AI 拉片');
  assert.equal(translate('custom user content', 'ja-JP'), 'custom user content');
});

test('静态界面、辅助标签和占位提示均有英文译文', () => {
  const markup = source.slice(source.indexOf('root.innerHTML ='), source.indexOf('localization.capture(root)'));
  const texts = [...markup.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)<|(?:aria-label|title|alt|placeholder)="([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g)]
    .map(match => match[1] || match[2]);
  assert.ok(texts.length > 60);
  for (const text of texts) assert.doesNotMatch(translate(text, 'en-US'), /[\u4e00-\u9fff]/, text);
});

test('动态数量、线稿按钮及人工复核状态使用当前语言', () => {
  const messages = [
    '开始 AI 拉片（24 镜）', '24 镜已选 / 128 镜', '已选 8 镜 · 请选择视觉模型',
    '正在转线稿 3 / 8…', '生成线稿分镜表节点', '生成原图分镜表节点',
    '定位 00:00:01.000 · ✓ 镜头已选 · 查看中',
    'shot-1 · 00:00:01.000 · 1.000s · 模型自报置信度：未提供 · 人工覆盖 2 项（待确认）',
    '已生成 128 镜，仅勾选前 24 镜；其余可手动选择后分批处理。镜头编辑支持撤销。',
  ];
  for (const text of messages) assert.doesNotMatch(translate(text, 'en-US'), /[\u4e00-\u9fff]/, text);
  assert.equal(translate('开始 AI 拉片（24 镜）', 'en-US'), 'Analyze 24 shots');
  assert.equal(translate('正在转线稿 3 / 8…', 'ko-KR'), '선화로 변환 중 3 / 8…');
});

class Node {
  constructor(name, text = '') {
    this.nodeName = name; this.nodeType = name === '#text' ? 3 : 1;
    this.nodeValue = text; this.childNodes = []; this.attributes = new Map();
  }
  get firstChild() { return this.childNodes[0]; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.childNodes = [new Node('#text', value)]; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  contains(target) { return this === target || this.childNodes.some(node => node.contains(target)); }
}

test('原位切换保留子节点、输入值、焦点对象、滚动位置和媒体状态；释放后不再更新', () => {
  const root = new Node('MAIN'), button = new Node('BUTTON'), time = new Node('SMALL');
  const input = new Node('TEXTAREA'), video = new Node('VIDEO');
  let locale = 'zh-CN';
  const binder = bindLocale(root, () => locale);
  root.childNodes = [button, input, video];
  binder.text(button, '镜头 01'); time.textContent = '00:00:01.000'; button.childNodes.push(time);
  binder.attr(button, 'aria-label', '选择镜头 1');
  input.value = '原图是我的自定义内容'; input.selectionStart = 4; input.scrollTop = 18;
  video.currentTime = 7.2; video.paused = false;
  for (locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    binder.refresh();
    assert.equal(button.firstChild.nodeValue, translate('镜头 01', locale));
    assert.equal(button.childNodes[1], time);
    assert.equal(input.value, '原图是我的自定义内容');
    assert.equal(input.selectionStart, 4); assert.equal(input.scrollTop, 18);
    assert.equal(video.currentTime, 7.2); assert.equal(video.paused, false);
  }
  binder.dispose(); locale = 'en-US'; binder.refresh();
  assert.equal(button.firstChild.nodeValue, '镜头 01');
});

test('默认分析语言、语言通知和清理接入宿主契约', () => {
  assert.match(source, /normalizeLocale\(props.locale\)/);
  assert.match(source, /addEventListener\('ai-canvas-locale-change', localeListener\)/);
  assert.match(source, /removeEventListener\('ai-canvas-locale-change', localeListener\)/);
  assert.match(source, /if \(defaultPrompt\) el\('prompt'\).value = t\(DEFAULT_PROMPT\)/);
  assert.match(source, /Keep JSON field names and frame keys unchanged/);
});

test('执行输出按语言生成标题和默认值，用户内容与结构化键不被翻译', () => {
  let plugin;
  vm.runInNewContext(readFileSync(new URL('../main.js', import.meta.url), 'utf8'), { definePlugin: value => { plugin = value; } });
  const frame = { key: 'shot-1', shotId: 'shot-1', inPoint: 0, outPoint: 1, requestedTime: 0, actualTime: 0,
    width: 100, height: 100, resourceId: 'opaque', content: '保留用户原文', reviewStatus: 'reviewed' };
  for (const locale of LOCALES) {
    const result = plugin.tools['video-frame-review']({ locale, parameters: { videoDuration: 1, imageRepresentation: 'lineart', frames: [frame] } });
    assert.equal(result.data.nodes[0].data.frameAnalysis.content, '保留用户原文');
    assert.equal(result.data.nodes[0].resourceId, 'opaque');
    assert.equal(result.data.nodes[1].data.shotlistRows[0].frameKey, 'shot-1');
    if (locale === 'en-US') {
      assert.equal(result.data.nodes[1].data.label, 'Frame Review · Line art · 1 shots');
      assert.doesNotMatch(result.message, /[\u4e00-\u9fff]/);
      assert.throws(() => plugin.tools['video-frame-review']({ locale, parameters: {} }), /Invalid source video duration/);
    }
  }
});
