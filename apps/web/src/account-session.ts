const channelName = 'qgroup:rebuild:session';
export function clearDeviceDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('qgroup:rebuild:music:') || key.startsWith('qgroup:rebuild:account-profile:') || key === 'qgroup:rebuild:device-link') sessionStorage.removeItem(key);
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
    if (event.data !== 'refresh' && event.data !== 'logout') return;
    if (event.data === 'logout') clearDeviceDrafts();
    refresh();
  };
  return () => channel.close();
}
