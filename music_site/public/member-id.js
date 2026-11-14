/* Legacy numeric member keys are QQ numbers; new opaque keys are music IDs. */
window.musicMemberKind = (id) => /^\d{4,12}$/.test(String(id)) ? 'QQ 号' : '成分 ID';
window.musicMemberLabel = (id) => `${window.musicMemberKind(id)} ${String(id || '')}`;
