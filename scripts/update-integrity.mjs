import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');

export function updateIntegrity() {
  const manifestPath = resolve(projectRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const uiPath = resolve(projectRoot, manifest.ui.entry);
  const digest = createHash('sha256').update(readFileSync(uiPath)).digest('hex');
  manifest.ui.integrity = `sha256-${digest}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return digest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const digest = updateIntegrity();
  console.log(`ui.js integrity: sha256-${digest}`);
}
