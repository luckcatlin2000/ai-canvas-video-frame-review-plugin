import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
let plugin;
vm.runInNewContext(source, {
  definePlugin(definition) {
    plugin = definition;
  },
});

function frame(key, time) {
  return {
    key,
    resourceId: `derived-${key}`,
    requestedTime: time,
    actualTime: time + 0.02,
    frameDuration: 0.04,
    width: 1280,
    height: 720,
    shotSize: '中景',
    camera: '固定',
    content: `画面 ${key}`,
    dialogue: '无法从画面判断',
    audio: '无法从画面判断',
    transition: '切',
    duration: 2,
    note: '',
    confidence: 0.9,
  };
}

test('仅图片模式创建带结构化分析的图片节点', () => {
  const result = plugin.tools['video-frame-review']({
    parameters: { outputMode: 'images', videoDuration: 8, frames: [frame('frame-01', 0), frame('frame-02', 2)] },
  });
  assert.equal(result.data.nodes.length, 2);
  assert.equal(result.data.edges.length, 0);
  assert.equal(result.data.nodes[0].nodeType, 'ai-image');
  assert.equal(result.data.nodes[0].resourceId, 'derived-frame-01');
  assert.equal(result.data.nodes[0].data.frameAnalysis.actualTime, 0.02);
  assert.equal('resourceId' in result.data.nodes[0].data.frameAnalysis, false);
});

test('分镜模式创建图片、分镜表和真实画面映射所需的 frameKey', () => {
  const result = plugin.tools['video-frame-review']({
    parameters: { outputMode: 'shotlist', videoDuration: 8, frames: [frame('frame-01', 0), frame('frame-02', 2)] },
  });
  assert.equal(result.data.nodes.length, 3);
  assert.equal(result.data.edges.length, 2);
  const shotlist = result.data.nodes.find((node) => node.nodeType === 'ai-shotlist');
  assert.equal(shotlist.data.shotlistRows.map((row) => row.frameKey).join(','), 'frame-01,frame-02');
  assert.equal(result.data.edges[0].sourceKey, 'frame-01');
  assert.equal(result.data.edges[0].targetKey, 'shotlist');
});

test('拒绝重复 key、缺失派生资源和超过 24 帧', () => {
  const run = (frames) => plugin.tools['video-frame-review']({ parameters: { frames } });
  assert.throws(() => run([frame('frame-01', 0), frame('frame-01', 1)]), /key/);
  assert.throws(() => run([{ ...frame('frame-01', 0), resourceId: '' }]), /派生资源/);
  assert.throws(() => run(Array.from({ length: 25 }, (_, index) => frame(`frame-${index + 1}`, index))), /1-24/);
});
