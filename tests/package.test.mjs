import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('manifest uses the bounded Plugin API v1 contract', () => {
  const tool = manifest.contributes.nodeTools[0];
  assert.equal(manifest.apiVersion, 1);
  assert.deepEqual(tool.nodeTypes, ['ai-video', 'source-video']);
  assert.equal(tool.output.mode, 'create-node-set');
  assert.equal(tool.output.maxNodes, 25);
  assert.deepEqual(tool.output.nodeTypes, ['ai-image', 'ai-shotlist']);
  assert.equal(tool.resourceAccess.self, true);
});

test('ui integrity matches the committed bundle', () => {
  const bytes = readFileSync(new URL(`../${manifest.ui.entry}`, import.meta.url));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(manifest.ui.integrity, `sha256-${digest}`);
});
