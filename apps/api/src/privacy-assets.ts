import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '@qgroup/database';
/** Run only after the erasure transaction commits, under the image-writer lock. */
export function prunePrivateImages(db: DB) {
  if (db.name === ':memory:') return;
  const root = join(dirname(db.name), 'images');
  if (!existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error('Refusing symbolic image root');
  db.transaction(() => {
    for (const prefix of readdirSync(root, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const folder = join(root, prefix.name); let removed = false;
      for (const file of readdirSync(folder, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-f0-9]{64}\.png$/.test(file.name) || !file.name.startsWith(prefix.name)) continue;
        const digest = file.name.slice(0, -4);
        if (db.prepare('SELECT 1 FROM image_assets WHERE digest=?').get(digest)) continue;
        unlinkSync(join(folder, file.name)); removed = true;
      }
      if (removed) { const fd = openSync(folder, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    }
  }).immediate();
}
