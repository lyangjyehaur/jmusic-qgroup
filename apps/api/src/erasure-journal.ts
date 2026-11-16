import { constants, closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { z } from 'zod';
import type { DB } from '@qgroup/database';

const Id = z.string().min(1).max(128);
const LegacyIntent = z.object({ user_id: Id, request_id: Id, created_at: z.string().min(1).max(80) }).strict();
const NewIntent = z.object({ version: z.literal(1), kind: z.enum(['music', 'account', 'both']), userId: Id, profileId: Id.nullable(), requestId: z.string().uuid(), createdAt: z.iso.datetime(), secretHash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(entry => entry.kind === 'account' || entry.profileId !== null);
export type ErasureIntent = z.infer<typeof NewIntent>;
export type StoredIntent = ErasureIntent | z.infer<typeof LegacyIntent>;
export interface ErasureJournal { read(): StoredIntent[]; append(entry: ErasureIntent): void }
/** The ledger must be retained separately from rolling database backups. */
export function erasureJournal(db: DB): ErasureJournal {
  if (db.name === ':memory:') {
    const entries: StoredIntent[] = [];
    return { read: () => structuredClone(entries), append: entry => { entries.push(structuredClone(entry)); } };
  }
  const suffix = extname(db.name);
  const path = (suffix ? db.name.slice(0, -suffix.length) : db.name) + '.erasures.jsonl';
  return {
    read() {
      if (!existsSync(path)) return [];
      // A partial/corrupt line is a startup error, never silently ignored.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fchmodSync(fd, 0o600);
        const source = readFileSync(fd, 'utf8');
        if (source && !source.endsWith('\n')) throw new Error('Incomplete erasure journal line');
        return source.split('\n').filter(line => line.trim()).map(line => z.union([NewIntent, LegacyIntent]).parse(JSON.parse(line)));
      } finally { closeSync(fd); }
    },
    append(entry) {
      NewIntent.parse(entry);
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
        const bytes = Buffer.from(JSON.stringify(entry) + '\n');
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('Erasure journal write interrupted');
          offset += written;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      const directory = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    },
  };
}
