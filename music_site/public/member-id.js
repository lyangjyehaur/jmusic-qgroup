/* Stable member IDs authorize writes; optional self-reported QQ numbers are lookup aliases. */
(() => {
  const contacts = new Map();
  window.musicRememberContacts = function remember(value) {
    if (Array.isArray(value)) value.forEach(remember);
    else if (value && typeof value === 'object') {
      if (typeof value.qq === 'string' && typeof value.contactQQ === 'string') {
        contacts.set(value.qq, value.contactQQ);
      }
      Object.values(value).forEach(item => { if (item && typeof item === 'object') remember(item); });
    }
    return value;
  };
  window.musicMemberValue = id => contacts.get(String(id)) || String(id || '');
  window.musicMemberKind = id => /^\d{4,12}$/.test(window.musicMemberValue(id)) ? 'QQ 号' : '成分 ID';
  window.musicMemberLabel = id => `${window.musicMemberKind(id)} ${window.musicMemberValue(id)}${contacts.get(String(id)) && !/^\d{4,12}$/.test(String(id)) ? '（自填）' : ''}`;
})();
