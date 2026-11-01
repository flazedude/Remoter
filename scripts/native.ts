import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('native/bin', { recursive: true });
for (const name of ['host', 'relay', 'update-server']) {
  const result = spawnSync('go', ['build', '-trimpath', '-o', `bin/remoter-${name}${process.platform === 'win32' ? '.exe' : ''}`, `./cmd/remoter-${name}`], {
    cwd: 'native', stdio: 'inherit',
    env: { ...process.env, ...(process.platform === 'darwin' ? {
      CGO_ENABLED: '1', MACOSX_DEPLOYMENT_TARGET: '15.0',
      // Apply to runtime/cgo too, so its Mach-O minimum does not inherit the
      // build machine's OS version. Keep caller optimization/linker flags.
      CGO_CFLAGS: `${process.env.CGO_CFLAGS ?? '-O2 -g'} -mmacosx-version-min=15.0`,
      CGO_LDFLAGS: `${process.env.CGO_LDFLAGS ?? '-O2 -g'} -mmacosx-version-min=15.0`,
    } : {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
