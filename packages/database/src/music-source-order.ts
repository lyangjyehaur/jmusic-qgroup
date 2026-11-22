/** A verified rebased source owns dictionary order. New native records append
 * in rowid order; the physical business rows and original bindings stay intact. */
export function musicSourceOrderSQL(kind: 'profile' | 'entry', alias: 'p' | 'e'): string {
  const document = kind === 'profile' ? 'profile_source' : 'entry_source';
  const field = kind === 'profile' ? 'profileId' : 'entryId';
  return `CASE WHEN EXISTS(SELECT 1 FROM music_documents WHERE kind='source_rebase')
    THEN COALESCE((SELECT position FROM music_documents WHERE kind='${document}' AND json_extract(payload_json,'$.${field}')=${alias}.id),9223372036854775807)
    ELSE ${alias}.rowid END,${alias}.rowid`;
}
