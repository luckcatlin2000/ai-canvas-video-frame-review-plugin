import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateIntegrity } from './update-integrity.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['main.js', 'ui.js']) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const digest = updateIntegrity();
console.log(`已更新 UI integrity: sha256-${digest}`);
const verification = spawnSync(process.execPath, ['scripts/verify-release.mjs'], { cwd: projectRoot, stdio: 'inherit' });
if (verification.status !== 0) process.exit(verification.status || 1);
