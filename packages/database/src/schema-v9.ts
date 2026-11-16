// Frozen DDL omits the legacy migration's singleton data. Do not replace
// imported policies/history or reset pacing and claim-related runtime state.
export const schemaV9 = `
INSERT OR IGNORE INTO bot_settings(id,revision,config_json,updated_at)
  VALUES(1,0,'{}',strftime('%Y-%m-%dT%H:%M:%S+00:00','now'));
INSERT OR IGNORE INTO bot_settings_history(revision,config_json,created_at,actor_ref,action)
  VALUES(0,'{}',strftime('%Y-%m-%dT%H:%M:%S+00:00','now'),'','baseline');
INSERT OR IGNORE INTO bot_runtime(id) VALUES(1);
UPDATE rebuild_schema SET version=9;
`;
