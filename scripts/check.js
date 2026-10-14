import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function checkDirectory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { checkDirectory(`${dir}/${entry.name}`); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${entry.name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const dir of ['src', 'test', 'scripts']) checkDirectory(dir);
console.log('Syntax checks passed.');
