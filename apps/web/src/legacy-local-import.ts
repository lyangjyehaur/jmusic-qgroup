import { describeLegacy, hasLegacyCredentials, legacyRaw, legacyScope } from './legacy-local-record';

export const legacyImportMaxBytes = 128 * 1024 * 1024;
const invalid = () => Error('保全檔格式損壞或不支援；請保留原檔。');

/** Decode the existing download format without dropping undefined, sparse
 * array positions, property order or negative zero. Never trust file mappings. */
export function decodeLegacyDraft(raw: string, scope: string): { key: string; data: Record<string, unknown>; at?: unknown } {
  legacyScope(scope);
  if (raw.length > legacyImportMaxBytes) throw Error('保全檔超過 128 MiB，請保留原檔並分別處理草稿。');
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw invalid(); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'format,source,version'
    || !('format' in envelope) || envelope.format !== 'kanban-local-v1-preserved'
    || !('version' in envelope) || envelope.version !== 1 || !('source' in envelope)) throw invalid();
  let nodes = 0;
  function decode(tree: unknown, depth: number): unknown {
    if (++nodes > 250000 || depth > 128 || !Array.isArray(tree)) throw invalid();
    const [tag, value] = tree;
    if (tag === 'null' && tree.length === 1) return null;
    if (tag === 'undefined' && tree.length === 1) return undefined;
    if (tree.length !== 2) throw invalid();
    if (tag === 'string' && typeof value === 'string' || tag === 'boolean' && typeof value === 'boolean') return value;
    if (tag === 'number' && typeof value === 'string') {
      const number = value === '-0' ? -0 : Number(value);
      if (!Number.isFinite(number) || (value !== '-0' && String(number) !== value)) throw invalid();
      return number;
    }
    if (tag === 'array' && Array.isArray(value)) {
      const array: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (Array.isArray(item) && item.length === 1 && item[0] === 'hole') { if (++nodes > 250000) throw invalid(); }
        else array[i] = decode(item, depth + 1);
      }
      return array;
    }
    if (tag === 'object' && Array.isArray(value)) {
      const object: Record<string, unknown> = {};
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(object, entry[0])) throw invalid();
        Object.defineProperty(object, entry[0], { value: decode(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return object;
    }
    throw invalid();
  }
  const source = decode(envelope.source, 0);
  if (!source || typeof source !== 'object' || Array.isArray(source) || !('key' in source)
    || typeof source.key !== 'string' || !source.key.startsWith('draft:' + scope + ':'))
    throw Error('保全檔不屬於目前帳號的舊草稿；請切換原帳號後再匯入。');
  if (hasLegacyCredentials(source)) throw Error('保全檔含授權資料，不能匯入；請保留原檔。');
  const description = describeLegacy(source, scope);
  if (description.kind !== 'draft') throw Error('這份保全檔尚未完成草稿映射，不能匯入；請保留原檔。');
  // Old exports contain no independent signature. Canonical bytes validate the
  // codec, not provenance; server receipts and permissions remain mandatory.
  if (legacyRaw(source) !== raw) throw invalid();
  return source as { key: string; data: Record<string, unknown>; at?: unknown };
}
