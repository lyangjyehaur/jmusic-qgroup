import { constants, closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { z } from 'zod';
import type { DB } from '@qgroup/database';

const Id = z.string().min(1).max(128);
const LegacyIntent = z.object({ user_id: Id, request_id: Id, created_at: z.string().min(1).max(80) }).strict();
const NewIntent = z.object({ version: z.literal(1), kind: z.enum(['music', 'account', 'both']), userId: Id, profileId: Id.nullable(), requestId: z.string().uuid(), createdAt: z.iso.datetime(), secretHash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(entry => entry.kind === 'account' || entry.profileId !== null);
const AdminIntent = z.object({
  version:z.literal(2),kind:z.literal('admin_music'),command:z.enum(['delete_profile','reset_music']),
  actorRef:Id,profiles:z.array(z.object({id:Id,userId:Id.nullable()}).strict()),entries:z.array(Id),
  requestId:z.string().uuid(),createdAt:z.iso.datetime(),secretHash:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((entry,ctx)=>{
  if(new Set(entry.profiles.map(p=>p.id)).size!==entry.profiles.length||new Set(entry.entries).size!==entry.entries.length ||
    entry.command==='delete_profile'&&(entry.profiles.length!==1||entry.entries.length!==0))
    ctx.addIssue({code:'custom',message:'Invalid administrative erasure scope'});
});
const CurrentIntent = z.union([NewIntent,AdminIntent]);
export type ErasureIntent = z.infer<typeof CurrentIntent>;
export type StoredIntent = ErasureIntent | z.infer<typeof LegacyIntent>;
const StoredIntentValue = z.union([CurrentIntent, LegacyIntent]);
export interface ErasureJournal { read(): StoredIntent[]; append(entry: ErasureIntent): void; assertReadable?(): void }
export function erasureJournalPath(database:string){const suffix=extname(database);return (suffix?database.slice(0,-suffix.length):database)+'.erasures.jsonl';}
export function decodeErasureJournal(source: string): StoredIntent[] {
  if (source && !source.endsWith('\n')) throw new Error('Incomplete erasure journal line');
  return source.split('\n').filter(line => line.trim()).map(line => StoredIntentValue.parse(JSON.parse(line)));
}
export const erasureRequestId = (entry: StoredIntent) => 'request_id' in entry ? entry.request_id : entry.requestId;
/** Missing, changed or pending deletion intents must never authorize an export. */
export function readVerifiedErasureJournal(db: DB, journal: ErasureJournal) {
  const entries = journal.read().map(entry => StoredIntentValue.parse(entry));
  const intents = new Map<string, string>();
  for (const entry of entries) {
    const id = erasureRequestId(entry), encoded = JSON.stringify(entry);
    if (intents.has(id) && intents.get(id) !== encoded) throw new Error('Conflicting erasure journal entries');
    intents.set(id, encoded);
  }
  const applied = new Set((db.prepare('SELECT request_id FROM erasure_applied').all() as { request_id: string }[]).map(row => row.request_id));
  if (applied.size !== intents.size || [...applied].some(id => !intents.has(id))) throw new Error('Erasure journal and applied markers differ');
  for (const entry of entries) if ('version' in entry) {
    const receipt = db.prepare('SELECT signature,secret_hash FROM privacy_receipts WHERE request_id=?').get(entry.requestId) as { signature: string; secret_hash: string } | undefined;
    if (receipt?.signature !== entry.signature || receipt.secret_hash !== entry.secretHash) throw new Error('Erasure journal and receipt differ');
  }
  return entries;
}
/** The ledger must be retained separately from rolling database backups. */
export function erasureJournal(db: DB): ErasureJournal {
  if (db.name === ':memory:') {
    const entries: StoredIntent[] = [];
    return { read: () => structuredClone(entries), append: entry => { entries.push(structuredClone(entry)); } };
  }
  const path = erasureJournalPath(db.name);
  return {
    read() {
      if (!existsSync(path)) return [];
      // A partial/corrupt line is a startup error, never silently ignored.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fchmodSync(fd, 0o600);
        const source = readFileSync(fd, 'utf8');
        return decodeErasureJournal(source);
      } finally { closeSync(fd); }
    },
    append(entry) {
      CurrentIntent.parse(entry);
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
