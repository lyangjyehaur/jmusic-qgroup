import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import type { Plugin } from 'vite';
export function pwaBuild(): Plugin {
    return {
        name: 'unified-pwa',
        generateBundle: { order: 'post', async handler(_options, bundle) {
                const index = bundle['index.html'];
                if (!index || index.type !== 'asset' || typeof index.source !== 'string')
                    throw Error('Missing native HTML shell');
                const files = Object.values(bundle).filter(file => file.fileName.startsWith('assets/')).sort((a, b) => a.fileName.localeCompare(b.fileName));
                const hash = createHash('sha256');
                hash.update(index.source);
                hash.update(readFileSync(new URL('../../package-lock.json', import.meta.url)));
                for (const file of files) {
                    hash.update(file.fileName);
                    hash.update(file.type === 'chunk' ? file.code : file.source);
                }
                for (const source of ['src/pwa/worker.ts', 'src/pwa/retire-music-worker.ts'])
                    hash.update(readFileSync(new URL(source, import.meta.url)));
                hash.update(readFileSync(new URL('public/icon.svg', import.meta.url)));
                hash.update(readFileSync(new URL('pwa-build.ts', import.meta.url)));
                const id = hash.digest('hex'), icon = readFileSync(new URL('public/icon.svg', import.meta.url));
                const manifest = { id: '/music/index.html', name: '群聚', short_name: '群聚', start_url: '/activities', scope: '/', display: 'standalone', background_color: '#f7f5ef', theme_color: '#286f67', lang: 'zh-Hant', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, ...[192, 512].map(size => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' }))] };
                for (const size of [192, 512])
                    this.emitFile({ type: 'asset', fileName: `icon-${size}.png`, source: await sharp(icon).resize(size, size).png().toBuffer() });
                this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest) });
                // An installed legacy app has no explicit id; its old start URL is its identity.
                this.emitFile({ type: 'asset', fileName: 'music/manifest.json', source: JSON.stringify({ ...manifest, id: '/music/index.html' }) });
                for (const [entry, fileName] of [['worker', 'sw.js'], ['retire-music-worker', 'music/sw.js']]) {
                    const result = await build({ entryPoints: [fileURLToPath(new URL(`src/pwa/${entry}.ts`, import.meta.url))], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true, define: { __PWA_BUILD_ID__: JSON.stringify(id), __PWA_ASSETS__: JSON.stringify([...files.map(f => '/' + f.fileName), '/icon.svg', '/icon-192.png', '/icon-512.png']) } });
                    this.emitFile({ type: 'asset', fileName: fileName!, source: result.outputFiles[0]!.contents });
                }
                index.source = index.source.replace('</head>', `<meta name="qgroup-build" content="${id}" /></head>`);
            } },
    };
}
