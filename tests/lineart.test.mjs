import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const exports = {};
runInNewContext(source, {
  window: { __AI_CANVAS_PLUGIN_HOST__: { exports } },
  Blob, atob, Uint8Array, Uint8ClampedArray, Float32Array, Int32Array, Uint32Array, RangeError, TypeError,
});
const { requestLineArt, hasLineArtBatch, visibleOutput, buildSubmission, convertLineArtBatch, lineArtSvg, checkedLineArtSvg } = exports.FrameReviewLogic;

const batchFrames = (count) => Array.from({ length: count }, (_, index) => ({ key: `frame-${index}`, actualTime: index / 3 }));

test('线稿批次接受最多 24 张画面，空批次、超限和重复 key 在转换前拒绝', async () => {
  let calls = 0;
  let progressCalls = 0;
  const convert = async (frame) => { calls += 1; return frame.key; };
  const progress = () => { progressCalls += 1; };
  for (const frames of [null, [], batchFrames(25), [{ key: 'same' }, { key: 'same' }]]) {
    await assert.rejects(convertLineArtBatch(frames, convert, () => true, progress), /1–24/);
  }
  assert.equal(calls, 0);
  assert.equal(progressCalls, 0);
  const fullBatch = await convertLineArtBatch(batchFrames(24), convert, () => true, progress);
  assert.equal(fullBatch.size, 24);
  assert.equal(calls, 24);
  assert.equal(progressCalls, 24);
});

test('线稿批次依次转换并保留输入顺序，不改写原始帧或提前发布中间结果', async () => {
  const frames = [{ key: 'third', actualTime: 8 }, { key: 'first', actualTime: 0 }, { key: 'second', actualTime: 3.25 }];
  const original = structuredClone(frames);
  frames.forEach(Object.freeze);
  Object.freeze(frames);
  const events = [];
  const progress = [];
  let active = 0;
  let maxActive = 0;
  let published = false;
  const pending = convertLineArtBatch(frames, async (frame) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${frame.key}`);
    await Promise.resolve();
    assert.equal(published, false);
    events.push(`end:${frame.key}`);
    active -= 1;
    return { dataUrl: `converted:${frame.key}`, actualTime: frame.actualTime };
  }, () => true, (done, total) => progress.push([done, total]));
  const result = await pending.then((value) => { published = true; return value; });
  assert.equal(maxActive, 1, 'large image conversions should not accumulate concurrently');
  assert.deepEqual(events, ['start:third', 'end:third', 'start:first', 'end:first', 'start:second', 'end:second']);
  assert.deepEqual(Array.from(result.keys()), ['third', 'first', 'second']);
  assert.deepEqual(result.get('second'), { dataUrl: 'converted:second', actualTime: 3.25 });
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(frames, original);
});

test('中途转换失败时拒绝整个批次，不返回半批结果并停止后续转换', async () => {
  const frames = batchFrames(4);
  const original = structuredClone(frames);
  const calls = [];
  const progress = [];
  const failure = new Error('像素读取失败');
  let returned;
  let fulfilled = false;
  const pending = convertLineArtBatch(frames, async (frame) => {
    calls.push(frame.key);
    if (frame.key === 'frame-1') throw failure;
    return { dataUrl: `converted:${frame.key}` };
  }, () => true, (done, total) => progress.push([done, total]));
  await assert.rejects(pending.then((value) => { fulfilled = true; returned = value; }), (error) => error === failure);
  assert.equal(fulfilled, false);
  assert.equal(returned, undefined);
  assert.deepEqual(calls, ['frame-0', 'frame-1']);
  assert.deepEqual(progress, [[1, 4], [2, 4]]);
  assert.deepEqual(frames, original);
});

test('界面已关闭时不启动转换，关闭期间完成的迟到结果不会交付', async () => {
  let calls = 0;
  const progress = [];
  await assert.rejects(convertLineArtBatch(batchFrames(2), async () => { calls += 1; }, () => false,
    (done, total) => progress.push([done, total])), /已失效/);
  assert.equal(calls, 0);
  assert.deepEqual(progress, []);

  let current = true;
  let finish;
  let delivered = false;
  const delayed = new Promise((resolve) => { finish = resolve; });
  const pending = convertLineArtBatch(batchFrames(2), async () => {
    calls += 1;
    return delayed;
  }, () => current, (done, total) => progress.push([done, total]));
  assert.equal(calls, 1);
  current = false;
  finish({ dataUrl: 'late-result' });
  await assert.rejects(pending.then(() => { delivered = true; }), /已失效/);
  assert.equal(delivered, false);
  assert.equal(calls, 1, 'closing must prevent conversion of the next frame');
  assert.deepEqual(progress, [[1, 2]]);
});

const pngOne = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6oQAAAAASUVORK5CYII=';
const pngTwo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('线稿 SVG 只嵌入 PNG，标题按 XML 转义并保留画面顺序和真实时间码', () => {
  const images = [{ dataUrl: pngTwo, actualTime: 4.25 }, { dataUrl: pngOne, actualTime: 0.5 }];
  const original = structuredClone(images);
  const svg = lineArtSvg(images, '<script>&"\'测试</script>');
  assert.match(svg, /<title>&lt;script&gt;&amp;&quot;&apos;测试&lt;\/script&gt;<\/title>/);
  assert.doesNotMatch(svg, /<script>/);
  assert.equal((svg.match(/<image /g) || []).length, 2);
  assert.ok(svg.indexOf(`href="${pngTwo}"`) < svg.indexOf(`href="${pngOne}"`));
  assert.ok(svg.includes('01 · 00:00:04.250'));
  assert.ok(svg.includes('02 · 00:00:00.500'));
  assert.ok(svg.indexOf('01 · 00:00:04.250') < svg.indexOf('02 · 00:00:00.500'));
  assert.match(svg, /<rect width="100%" height="100%" fill="white"\/>/);
  assert.deepEqual(images, original);
});

test('线稿 SVG 标题移除 XML 非法控制字符，保留正常中文和合法换行', () => {
  const title = '线\u0000稿\u0008\u000B\u000C\u000E\u001F\uFFFE\uFFFF\n第二行\t&';
  const svg = lineArtSvg([{ dataUrl: pngOne, actualTime: 0 }], title);
  assert.ok(svg.includes('<title>线稿\n第二行\t&amp;</title>'));
  assert.doesNotMatch(svg, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);
});

test('线稿 SVG 拒绝外部链接、其他媒体、注入属性及无效时间码', () => {
  for (const dataUrl of [
    'https://example.invalid/image.png',
    'file:///image.png',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/jpeg;base64,AAAA',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,',
    'data:image/png;base64,AAAA" onload="alert(1)',
    'data:image/png;base64,AAAA\nBBBB',
    'data:image/png;base64,AAAA%22',
  ]) assert.throws(() => lineArtSvg([{ dataUrl, actualTime: 0 }], '线稿'), /无效/);
  for (const actualTime of [-1, NaN, Infinity, '1.5']) {
    assert.throws(() => lineArtSvg([{ dataUrl: pngOne, actualTime }], '线稿'), /无效/);
  }
});

test('线稿联系表限制 1–24 张，256000 字符以内才允许导出', () => {
  for (const images of [null, [], Array.from({ length: 25 }, () => ({ dataUrl: pngOne, actualTime: 0 }))]) {
    assert.throws(() => lineArtSvg(images, '线稿'), /1–24/);
  }
  const fullBatch = lineArtSvg(Array.from({ length: 24 }, (_, index) => ({ dataUrl: pngOne, actualTime: index })), '线稿');
  assert.equal((fullBatch.match(/<image /g) || []).length, 24);
  assert.equal(checkedLineArtSvg(fullBatch), fullBatch);
  const maximum = 'x'.repeat(256000);
  assert.equal(checkedLineArtSvg(maximum), maximum);
  assert.throws(() => checkedLineArtSvg(`${maximum}x`), /超过导出上限/);
  const largeSvg = lineArtSvg([{ dataUrl: `data:image/png;base64,${'A'.repeat(256000)}`, actualTime: 0 }], '大图');
  assert.throws(() => checkedLineArtSvg(largeSvg), /超过导出上限/);
});

const resultFrame = (key = 's1', time = 0) => ({ key, shotId: key, resourceId: 'derived-' + key,
  width: 1920, height: 1080, inPoint: time, outPoint: time + 1, requestedTime: time, actualTime: time + 0.02,
  sampleRole: 'start', reviewStatus: 'reviewed', analysisError: '', content: '人工复核内容',
  overrideFields: ['content'], aiOriginal: { content: 'AI 原文' }, previewDataUrl: 'original-preview' });
const hostArt = (frame) => ({ resourceId: frame.resourceId, representation: 'lineart', width: 1024, height: 576, previewDataUrl: pngOne });
const cachedArt = (frame) => ({ ...hostArt(frame), dataUrl: pngOne, actualTime: frame.actualTime });

test('线稿只请求固定宿主操作，并保留原资源标识、实际尺寸与时间码', async () => {
  const frame = resultFrame();
  const before = structuredClone(frame), requests = [];
  const art = await requestLineArt(frame, async (request) => { requests.push(JSON.parse(JSON.stringify(request))); return hostArt(frame); }, () => true);
  assert.deepEqual(requests, [{ type: 'image.lineArt', resourceId: frame.resourceId }]);
  assert.equal(art.resourceId, frame.resourceId); assert.equal(art.representation, 'lineart');
  assert.equal(art.width, 1024); assert.equal(art.height, 576); assert.equal(art.actualTime, frame.actualTime);
  assert.equal(art.dataUrl, pngOne); assert.deepEqual(frame, before);
});

test('未知宿主操作提示更新；额度等真实错误保留，不请求备用转换或返回原图', async () => {
  const frame = resultFrame();
  let calls = 0;
  await assert.rejects(requestLineArt(frame, async () => { calls++; throw new Error('插件请求了不支持的宿主操作'); }, () => true), /更新主应用/);
  const failure = new Error('派生资源超过内存额度');
  await assert.rejects(requestLineArt(frame, async () => { calls++; throw failure; }, () => true), error => error === failure);
  assert.equal(calls, 2);
});

test('线稿回包拒绝不同来源、错误表示、无效尺寸和非 PNG 预览', async () => {
  const frame = resultFrame(), original = hostArt(frame);
  for (const patch of [{ resourceId: 'other' }, { representation: 'original' }, { representation: undefined },
    { width: 0 }, { height: 1025 }, { width: 12.5 }, { height: Infinity },
    { previewDataUrl: 'data:image/jpeg;base64,AAAA' }, { previewDataUrl: 'https://example.invalid/image.png' },
    { previewDataUrl: 'data:image/png;base64,' + 'A'.repeat(256000) }]) {
    await assert.rejects(requestLineArt(frame, async () => ({ ...original, ...patch }), () => true), /线稿资源无效/);
  }
  await assert.rejects(requestLineArt(frame, async () => null, () => true), /线稿资源无效/);
});

test('失效批次不请求，异步返回之后再次检查，拒绝迟到线稿', async () => {
  let current = false, calls = 0;
  const frame = resultFrame();
  await assert.rejects(requestLineArt(frame, async () => { calls++; return hostArt(frame); }, () => current), /已失效/);
  assert.equal(calls, 0);
  current = true;
  await assert.rejects(requestLineArt(frame, async () => { calls++; current = false; return hostArt(frame); }, () => current), /已失效/);
  assert.equal(calls, 1);
});

test('24 帧原图与线稿提交跟随当前显示，始终只提交资源标识而非 PNG', () => {
  const frames = Array.from({ length: 24 }, (_, index) => resultFrame('s' + index, index));
  const original = structuredClone(frames);
  const cache = new Map(frames.map(frame => [frame.key, cachedArt(frame)]));
  for (const outputMode of ['images', 'shotlist']) {
    const art = buildSubmission(outputMode, 24, frames, true, cache);
    const color = buildSubmission(outputMode, 24, frames, false, cache);
    assert.equal(art.imageRepresentation, 'lineart'); assert.equal(color.imageRepresentation, 'original');
    assert.equal(art.outputMode, outputMode); assert.equal(art.frames.length, 24);
    assert.equal(art.frames[0].width, 1024); assert.equal(art.frames[0].height, 576);
    assert.equal(color.frames[0].width, 1920); assert.equal(color.frames[0].height, 1080);
    for (const parameters of [art, color]) {
      assert.doesNotMatch(JSON.stringify(parameters), /data:image|previewDataUrl|original-preview|canvas/);
      assert.equal(parameters.frames[10].resourceId, frames[10].resourceId);
      assert.equal(parameters.frames[10].actualTime, frames[10].actualTime);
      assert.equal(parameters.frames[10].content, '人工复核内容');
      assert.equal(parameters.frames[10].aiOriginal.content, 'AI 原文');
      assert.equal(parameters.frames[10].reviewStatus, 'reviewed');
    }
  }
  assert.deepEqual(frames, original);
});

test('缺失、旧批次、伪装原图的缓存均拒绝线稿提交，原图查看仍可提交原图', () => {
  const frames = [resultFrame('s1'), resultFrame('s2', 1)];
  const valid = new Map(frames.map(frame => [frame.key, cachedArt(frame)]));
  assert.equal(hasLineArtBatch(frames, valid), true);
  for (const cache of [new Map(), new Map([['s1', cachedArt(frames[0])]]),
    new Map([['s1', { ...cachedArt(frames[0]), resourceId: 'old-batch' }], ['s2', cachedArt(frames[1])]]),
    new Map([['s1', { ...cachedArt(frames[0]), representation: 'original' }], ['s2', cachedArt(frames[1])]])]) {
    assert.equal(hasLineArtBatch(frames, cache), false);
    assert.throws(() => buildSubmission('images', 2, frames, true, cache), /批次不完整/);
    assert.equal(buildSubmission('images', 2, frames, false, cache).imageRepresentation, 'original');
  }
  assert.equal(hasLineArtBatch([], valid), false);
  for (const patch of [{ reviewStatus: 'edited' }, { analysisError: '尚未复核' }]) {
    assert.throws(() => buildSubmission('shotlist', 2, [{ ...frames[0], ...patch }], true, valid), /复核/);
  }
});

test('按钮名称随显示模式往返同步，CSV 标明当前画面模式并过滤预览数据', () => {
  const original = visibleOutput(false), art = visibleOutput(true);
  assert.equal(original.images, '生成原图节点'); assert.equal(original.shotlist, '生成原图分镜表节点'); assert.equal(original.contact, '导出原图联系表');
  assert.equal(art.images, '生成线稿节点'); assert.equal(art.shotlist, '生成线稿分镜表节点'); assert.equal(art.contact, '导出线稿联系表');
  assert.deepEqual(visibleOutput(false), original);
  for (const imageRepresentation of ['original', 'lineart']) {
    const csv = exports.FrameReviewLogic.reportCsv({ source: { nodeId: 'video', name: '视频' }, imageRepresentation,
      frames: [exports.FrameReviewLogic.publicFrame(resultFrame())] });
    assert.match(csv, /imageRepresentation/); assert.ok(csv.includes('"' + imageRepresentation + '"'));
    assert.doesNotMatch(csv, /original-preview|derived-s1/);
  }
});
