import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync } from 'node:fs';

export type CaptureLock = { assertHeld(): void; release(): Promise<void> };
/** Linux flock interoperates with music_site.maintenance.service_lock. The
 * holder reads no source content and dies when its parent's pipe closes. */
export async function acquireMusicLock(path: string): Promise<CaptureLock> {
  if (process.platform !== 'linux') throw new Error('Snapshot maintenance locking requires Linux flock');
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW), original = fstatSync(fd, { bigint: true });
  if (!original.isFile()) { closeSync(fd); throw new Error('Invalid music maintenance lock'); }
  const environment = { ...process.env }; delete environment.NODE_OPTIONS;
  const holder = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', path, process.execPath, '-e', "process.stdout.write('locked\\n');process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'], env: environment });
  holder.stdin.on('error', () => {}); holder.stderr.resume();
  const exited = new Promise<void>(resolve => { holder.once('exit', () => resolve()); holder.once('error', () => resolve()); });
  let released = false;
  async function release() {
    if (released) return; released = true;
    holder.stdin.end();
    const timeout = setTimeout(() => { holder.kill('SIGKILL'); }, 1500);
    try { await exited; } finally { clearTimeout(timeout); closeSync(fd); }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Music maintenance lock timed out')), 3000);
      const fail = () => { clearTimeout(timeout); reject(new Error('Music service is active or its maintenance lock is unavailable')); };
      holder.once('error', fail); holder.once('exit', fail);
      holder.stdout.once('data', raw => { clearTimeout(timeout); if (String(raw) === 'locked\n') resolve(); else fail(); });
    });
    const assertHeld = () => {
      const current = lstatSync(path, { bigint: true });
      if (released || holder.exitCode !== null || holder.signalCode !== null || !current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) throw new Error('Music maintenance lock was lost or replaced');
    };
    assertHeld(); return { assertHeld, release };
  } catch (error) { await release(); throw error; }
}
