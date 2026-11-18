import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, openServiceDatabase } from './index';
import { fixture } from '../../../apps/api/testsupport/fixture';
const drop = 'DROP TRIGGER unified_privacy_erasure; DROP TABLE unified_privacy_receipts; DROP TABLE unified_privacy_consents; UPDATE rebuild_schema SET version=14';
describe('schema 14 → separate unified consent history', () => {
  it('preserves every prior row, DDL, lineage and actual Python bot read; creates no inferred consent', () => {
    const root = mkdtempSync(join(tmpdir(), 'qgroup-consent-migration-')), path = join(root, 'synthetic.db');
    try {
      const old = openDatabase(path); fixture(old); old.exec(drop);
      old.exec("INSERT INTO privacy_consents VALUES('alice','2026-11-10','original-time')");
      const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as { name: string }[]).map(row => row.name);
      const rows = tables.map(table => old.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all());
      const ddl = old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as { name: string; sql: string | null }[];
      const bot = () => execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', path], { encoding: 'utf8' }), previous = bot(); old.close();
      expect(() => openServiceDatabase(path)).toThrow('offline migration');
      const next = openDatabase(path); expect(next.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 15 });
      expect(tables.map(table => next.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all())).toEqual(rows);
      for (const row of ddl) expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(bot()).toBe(previous);
      expect(next.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual([]);
      expect(next.prepare('SELECT * FROM unified_privacy_receipts').all()).toEqual([]);
      expect(next.pragma('foreign_key_check')).toEqual([]); next.close();
      const reopened = openServiceDatabase(path); expect(reopened.prepare('SELECT * FROM privacy_consents').all()).toHaveLength(1); reopened.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rolls the complete migration back on a collision, preserving evidence and the old runtime marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'qgroup-consent-collision-')), path = join(root, 'synthetic.db');
    try {
      const old = openDatabase(path); old.exec(drop); old.exec("CREATE TABLE unified_privacy_receipts(evidence TEXT); INSERT INTO unified_privacy_receipts VALUES('retain')");
      const ddl = old.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); old.close();
      expect(() => openDatabase(path)).toThrow('already exists');
      const raw = new Database(path); expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(ddl);
      expect(raw.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 14 }); expect(raw.prepare('SELECT * FROM unified_privacy_receipts').all()).toEqual([{ evidence: 'retain' }]); raw.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses a version 14 database missing its lineage without adding consent tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'qgroup-consent-lineage-')), path = join(root, 'broken.db');
    try {
      const db = openDatabase(path); db.exec(drop); db.exec('DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage');
      const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); db.close();
      expect(() => openDatabase(path)).toThrow('Missing storage lineage');
      const raw = new Database(path); expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before); raw.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
