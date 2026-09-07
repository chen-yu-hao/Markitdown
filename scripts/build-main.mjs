import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist/main', { recursive: true });
await build({ entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/main/index.cjs', external: ['electron', 'sharp'] });
await build({ entryPoints: ['src/main/preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/main/preload.cjs', external: ['electron'] });
await copyFile('node_modules/katex/dist/katex.min.css', 'dist/main/katex.min.css');
await cp('node_modules/katex/dist/fonts', 'dist/main/fonts', { recursive: true });
