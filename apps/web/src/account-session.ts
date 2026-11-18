import { clearDurableDrafts } from './draft-store';
const channelName = 'qgroup:rebuild:session';
function clearMusicSessionDrafts(scope: string) {
  try { for (const key of Object.keys(sessionStorage)) if ((key.startsWith('qgroup:rebuild:music:') || key.startsWith('qgroup:rebuild:room-lab:')) && (key.endsWith(':' + scope) || key.includes(':' + scope + ':'))) sessionStorage.removeItem(key); }
  catch { /* Server epochs reject any surviving stale draft. */ }
}
export async function clearMusicDrafts(scope: string) {
  clearMusicSessionDrafts(scope);
  await clearDurableDrafts(scope);
}
export async function announceMusicErasure(scope: string) {
  try { await clearMusicDrafts(scope); }
  finally {
    try { const channel = new BroadcastChannel(channelName); channel.postMessage({ type: 'music-erased', scope }); channel.close(); }
    catch { /* Session refresh also detects the changed epoch. */ }
  }
}
function clearDeviceSessionDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('qgroup:rebuild:music:') || key.startsWith('qgroup:rebuild:room-lab:') || key.startsWith('qgroup:rebuild:payment-codes:') || key.startsWith('qgroup:rebuild:notifications-read:') || key.startsWith('qgroup:rebuild:account-profile:') || key.startsWith('qgroup:rebuild:activity-draft:') || (key.startsWith('qgroup:rebuild:admin-') && !key.startsWith('qgroup:rebuild:admin-music-erasure:v1:')) || key === 'qgroup:rebuild:device-link') sessionStorage.removeItem(key);
  } catch { /* A revoked session remains revoked even when browser storage is unavailable. */ }
}
export async function clearDeviceDrafts() {
  clearDeviceSessionDrafts();
  await clearDurableDrafts();
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
    if (event.data?.type === 'music-erased' && typeof event.data.scope === 'string') { clearMusicSessionDrafts(event.data.scope); refresh(); return; }
    if (event.data !== 'refresh' && event.data !== 'logout') return;
    if (event.data === 'logout') clearDeviceSessionDrafts();
    refresh();
  };
  return () => channel.close();
}
