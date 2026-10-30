import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('native/bin', { recursive: true });
for (const name of ['host', 'relay']) {
  const result = spawnSync('go', ['build', '-trimpath', '-o', `bin/remoter-${name}${process.platform === 'win32' ? '.exe' : ''}`, `./cmd/remoter-${name}`], { cwd: 'native', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
