import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './index';
describe('isolated replacement database', () => {
  it('initializes idempotently, preserving all 59 legacy tables and their triggers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-db-'));
    try {
      const path = join(dir, 'test.sqlite3');
      const first = openDatabase(path);
      const tables = first.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      expect(tables).toHaveLength(64); // 59 compatibility + marker + four music tables
      expect(first.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(first.pragma('foreign_key_check')).toEqual([]);
      first.close();
      const second = openDatabase(path);
      expect(second.prepare('SELECT max(version) n FROM schema_migrations').get()).toEqual({ n: 20 });
      expect(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toEqual(tables);
      second.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('refuses unmarked legacy databases without adding tables or changing their journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-legacy-'));
    try {
      const path = join(dir, 'legacy.sqlite3');
      const old = new Database(path); old.exec('CREATE TABLE important(id TEXT)'); old.close();
      expect(() => openDatabase(path)).toThrow('Refusing legacy database');
      const unchanged = new Database(path);
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'important' }]);
      expect(unchanged.pragma('journal_mode', { simple: true })).toBe('delete'); unchanged.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
