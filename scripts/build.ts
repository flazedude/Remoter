import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
export async function buildMain() {
  await Promise.all([
    bundle({ entryPoints: ['apps/desktop/electron/main.ts'], outfile: 'apps/desktop/dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true }),
    bundle({ entryPoints: ['apps/desktop/electron/preload.ts'], outfile: 'apps/desktop/dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true })
  ]);
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/build.ts')) {
  await buildMain();
  await viteBuild({ configFile: 'apps/desktop/vite.config.ts' });
}
