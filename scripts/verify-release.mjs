import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(resolve(projectRoot, path), 'utf8');
const manifest = JSON.parse(readText('manifest.json'));
const mainSource = readText(manifest.entry);
const uiSource = readText(manifest.ui.entry);

assert.equal(manifest.apiVersion, 1);
assert.equal(manifest.runtime, 'javascript');
assert.equal(manifest.entry, 'main.js');
assert.equal(manifest.contributes.nodeTools.length, 1);
assert.equal(manifest.contributes.nodeTools[0].output.mode, 'create-node-set');
assert.deepEqual(manifest.contributes.nodeTools[0].nodeTypes, ['ai-video', 'source-video']);
assert.deepEqual(manifest.contributes.nodeTools[0].output.nodeTypes, ['ai-image', 'ai-shotlist']);
assert.equal(manifest.contributes.nodeTools[0].output.maxNodes, 25);
assert.ok(manifest.permissions.includes('files.connected.read'));
assert.ok(manifest.permissions.includes('files.output.create'));
assert.ok(manifest.permissions.includes('ui.custom'));
assert.match(mainSource, /definePlugin\s*\(/);
assert.match(uiSource, /exports\.VideoFrameReview\s*=/);

const digest = createHash('sha256').update(readFileSync(resolve(projectRoot, manifest.ui.entry))).digest('hex');
assert.equal(manifest.ui.integrity, `sha256-${digest}`);
assert.ok(statSync(resolve(projectRoot, manifest.entry)).size <= 512 * 1024, 'main.js 超过宿主 512 KiB 上限');
assert.ok(statSync(resolve(projectRoot, manifest.ui.entry)).size <= 1024 * 1024, 'ui.js 超过 1 MiB 项目上限');

const packageJson = JSON.parse(readText('package.json'));
assert.equal(packageJson.version, manifest.version, 'package.json 与 manifest.json 版本不一致');
assert.equal(packageJson.dependencies, undefined, '首版不得引入运行时依赖');
assert.equal(packageJson.devDependencies, undefined, '首版不得引入开发依赖');

for (const [name, source] of [['main.js', mainSource], ['ui.js', uiSource]]) {
  assert.doesNotMatch(source, /[A-Za-z]:[\\/]/, `${name} 包含 Windows 绝对路径`);
  assert.doesNotMatch(source, /https?:\/\//i, `${name} 不应直接联网`);
}

console.log('发布结构、权限、版本与 UI integrity 校验通过');
