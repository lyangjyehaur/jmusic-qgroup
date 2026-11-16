const channelName = 'qgroup:rebuild:session';
export function clearMusicDrafts(scope: string) {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('qgroup:rebuild:music:') && (key.endsWith(':' + scope) || key.includes(':' + scope + ':'))) sessionStorage.removeItem(key); }
  catch { /* Server epochs reject any surviving stale draft. */ }
}
export function announceMusicErasure(scope: string) {
  clearMusicDrafts(scope);
  try { const channel = new BroadcastChannel(channelName); channel.postMessage({ type: 'music-erased', scope }); channel.close(); }
  catch { /* Session refresh also detects the changed epoch. */ }
}
export function clearDeviceDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('qgroup:rebuild:music:') || key.startsWith('qgroup:rebuild:account-profile:') || key.startsWith('qgroup:rebuild:activity-draft:') || key.startsWith('qgroup:rebuild:admin-') || key === 'qgroup:rebuild:device-link') sessionStorage.removeItem(key);
  } catch { /* A revoked session remains revoked even when browser storage is unavailable. */ }
}
export function announceAccountChange(logout = false) {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(logout ? 'logout' : 'refresh'); channel.close();
  } catch { /* Optional tab signaling must not interrupt an already committed action. */ }
}
export function observeAccountChange(refresh: () => void) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  let channel: BroadcastChannel;
  try { channel = new BroadcastChannel(channelName); } catch { return () => {}; }
  channel.onmessage = event => {
    if (event.data?.type === 'music-erased' && typeof event.data.scope === 'string') { clearMusicDrafts(event.data.scope); refresh(); return; }
    if (event.data !== 'refresh' && event.data !== 'logout') return;
    if (event.data === 'logout') clearDeviceDrafts();
    refresh();
  };
  return () => channel.close();
}
