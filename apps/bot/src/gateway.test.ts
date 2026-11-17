import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayFatalError, QQGateway, type GatewayDispatch, type GatewayOptions, type GatewaySocket } from './gateway';
import { createBotObserver, type LogFields } from './observability';
import { localPlatform, until } from '../testsupport/platform';

class FakeSocket extends EventTarget {
  readyState = 1;
  frames: Record<string, unknown>[] = [];
  listeners = 0;
  send(value: string) {
    this.frames.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  message(frame: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) }),
    );
  }
  disconnect(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.listeners++;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.listeners--;
    super.removeEventListener(...args);
  }
}
const active: { stop: AbortController; work: Promise<void> }[] = [];
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture(options: Partial<GatewayOptions> = {}) {
  const sockets: FakeSocket[] = [],
    rows: LogFields[] = [],
    events: GatewayDispatch[] = [];
  const stop = new AbortController(),
    api = { gateway: async () => 'wss://synthetic.invalid/ws', auth: async () => 'QQBot private-token' };
  const gateway = new QQGateway({
    api,
    intents: 100663296,
    onDispatch: async (event) => {
      events.push(event);
    },
    observer: createBotObserver((row) => rows.push(row)),
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as GatewaySocket;
    },
    ...options,
  });
  const work = gateway.run(stop.signal);
  void work.catch(() => {});
  active.push({ stop, work });
  return { sockets, rows, events, stop, work, gateway };
}
async function hello(socket: FakeSocket) {
  socket.message({ op: 10, d: { heartbeat_interval: 1000 } });
  await settle();
}
async function ready(socket: FakeSocket, s = 1) {
  socket.message({ op: 0, t: 'READY', s, d: { session_id: 'private-session', user: { id: 'private-bot-id' } } });
  await settle();
}
afterEach(async () => {
  for (const run of active.splice(0)) {
    run.stop.abort();
    await run.work.catch(() => {});
  }
  vi.useRealTimers();
});

describe('QQ gateway lifecycle and bounded dispatch', () => {
  it('identifies, ACKs heartbeats, resumes the last completed sequence and never logs platform secrets', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle();
    const socket = f.sockets[0]!;
    await hello(socket);
    expect(socket.frames[0]).toMatchObject({
      op: 2,
      d: { token: 'QQBot private-token', intents: 100663296, shard: [0, 1] },
    });
    await ready(socket);
    socket.message({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      s: 2,
      id: 'private-event',
      d: { id: 'private-message', content: 'private-content' },
    });
    await settle();
    expect(f.gateway.state()).toMatchObject({ connected: true, sequence: 2 });
    socket.message({ op: 11 });
    expect(f.gateway.state().last_ack).toBeNull();
    socket.message({ op: 1 });
    expect(socket.frames.at(-1)).toEqual({ op: 1, d: 2 });
    socket.message({ op: 11 });
    expect(f.gateway.state().last_ack).not.toBeNull();
    socket.disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    const resumed = f.sockets[1]!;
    await hello(resumed);
    expect(resumed.frames[0]).toEqual({
      op: 6,
      d: { token: 'QQBot private-token', session_id: 'private-session', seq: 2 },
    });
    resumed.message({ op: 0, t: 'RESUMED', s: 3, d: {} });
    await settle();
    expect(f.gateway.state()).toMatchObject({ connected: true, sequence: 3, reconnects: 1 });
    const serialized = JSON.stringify(f.rows);
    for (const text of [
      'private-token',
      'private-session',
      'private-bot-id',
      'private-event',
      'private-message',
      'private-content',
    ])
      expect(serialized).not.toContain(text);
    f.stop.abort();
    await f.work;
    expect(f.sockets.every((s) => s.listeners === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('serializes business dispatch without blocking heartbeat and replays incomplete work after disconnect', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const seen: number[] = [];
    const f = fixture({
      onDispatch: async (event, signal) => {
        seen.push(event.s);
        if (event.s === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          expect(signal.aborted).toBe(true);
        }
      },
    });
    await settle();
    const socket = f.sockets[0]!;
    await hello(socket);
    await ready(socket);
    socket.message({ op: 0, t: 'MESSAGE', s: 2, d: {} });
    socket.message({ op: 0, t: 'MESSAGE', s: 3, d: {} });
    await settle();
    expect(seen).toEqual([1, 2]);
    expect(f.gateway.state().sequence).toBe(1);
    socket.message({ op: 1 });
    expect(socket.frames.at(-1)).toEqual({ op: 1, d: 3 });
    socket.message({ op: 11 });
    expect(f.gateway.state().last_ack).not.toBeNull();
    socket.disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await hello(f.sockets[1]!);
    expect(f.sockets[1]!.frames[0]).toMatchObject({ op: 6, d: { seq: 1 } });
    release();
    await settle();
    expect(f.gateway.state().sequence).toBe(1);
    expect(seen).toEqual([1, 2]);
  });
  it('bounds never-completing/failed handlers and queue overflow without acknowledging unhandled sequences', async () => {
    vi.useFakeTimers();
    for (const mode of ['timeout', 'throw', 'overflow']) {
      const f = fixture({
        maxQueuedDispatches: 2,
        dispatchTimeoutMs: 500,
        onDispatch: async (event) => {
          if (event.s === 2) {
            if (mode === 'throw') throw Error('private-message');
            await new Promise(() => {});
          }
        },
      });
      await settle();
      const socket = f.sockets[0]!;
      await hello(socket);
      await ready(socket);
      socket.message({ op: 0, t: 'MESSAGE', s: 2, d: {} });
      await settle();
      if (mode === 'overflow') {
        socket.message({ op: 0, t: 'MESSAGE', s: 3, d: {} });
        socket.message({ op: 0, t: 'MESSAGE', s: 4, d: {} });
      } else if (mode === 'timeout') await vi.advanceTimersByTimeAsync(501);
      await settle();
      expect(socket.readyState).toBe(3);
      expect(f.gateway.state().sequence).toBe(1);
      expect(
        f.rows.some((row) => row.event === (mode === 'overflow' ? 'dispatch_queue_full' : 'dispatch_failed')),
      ).toBe(true);
      f.stop.abort();
      await f.work;
    }
  });
  it('detects missing ACKs from the very first heartbeat and keeps a healthy connection alive', async () => {
    vi.useFakeTimers();
    const missing = fixture();
    await settle();
    await hello(missing.sockets[0]!);
    await ready(missing.sockets[0]!);
    await vi.advanceTimersByTimeAsync(121000);
    expect(missing.sockets[0]!.readyState).toBe(3);
    expect(missing.rows.some((row) => row.event === 'heartbeat_ack_timeout')).toBe(true);
    missing.stop.abort();
    await missing.work;
    const healthy = fixture();
    await settle();
    await hello(healthy.sockets[0]!);
    await ready(healthy.sockets[0]!);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(40000);
      healthy.sockets[0]!.message({ op: 11 });
    }
    expect(healthy.sockets[0]!.readyState).toBe(1);
    expect(healthy.gateway.state().connected).toBe(true);
  });
  it('clears invalid sessions, obeys server reconnect requests and bounds three failed Resume attempts', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle();
    await hello(f.sockets[0]!);
    await ready(f.sockets[0]!);
    f.sockets[0]!.message({ op: 9, d: false });
    await settle();
    expect(f.gateway.state().sequence).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await hello(f.sockets[1]!);
    expect(f.sockets[1]!.frames[0]?.op).toBe(2);
    await ready(f.sockets[1]!);
    f.sockets[1]!.message({ op: 7 });
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    for (let attempt = 0; attempt < 3; attempt++) {
      const socket = f.sockets.at(-1)!;
      await hello(socket);
      expect(socket.frames[0]?.op).toBe(6);
      socket.disconnect();
      await settle();
      await vi.advanceTimersByTimeAsync(4000 * 2 ** attempt);
      await settle();
    }
    await hello(f.sockets.at(-1)!);
    expect(f.sockets.at(-1)!.frames[0]?.op).toBe(2);
  });
  it('stops on non-retryable platform errors and identifies afresh on invalid sequence/internal errors', async () => {
    vi.useFakeTimers();
    const fatal = fixture();
    await settle();
    fatal.sockets[0]!.disconnect(4915);
    await expect(fatal.work).rejects.toBeInstanceOf(GatewayFatalError);
    expect(fatal.sockets).toHaveLength(1);
    for (const code of [4007, 4900, 4913]) {
      const f = fixture();
      await settle();
      await hello(f.sockets[0]!);
      await ready(f.sockets[0]!);
      f.sockets[0]!.disconnect(code);
      await settle();
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      await hello(f.sockets[1]!);
      expect(f.sockets[1]!.frames[0]?.op).toBe(2);
      f.stop.abort();
      await f.work;
    }
  });
  it('enforces HELLO/READY deadlines, validates frame envelopes and cleans up stop during unresolved resolution/authentication', async () => {
    vi.useFakeTimers();
    for (const mode of [
      'no-hello',
      'no-ready',
      'bad-interval',
      'binary',
      'too-big',
      'repeat-hello',
      'invalid-dispatch',
      'invalid-ready',
    ]) {
      const f = fixture({ connectTimeoutMs: 500 });
      await settle();
      const socket = f.sockets[0]!;
      if (mode === 'bad-interval') socket.message({ op: 10, d: { heartbeat_interval: 0 } });
      else if (mode === 'binary') socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1]) }));
      else if (mode === 'too-big') socket.message('x'.repeat(1024 * 1024 + 1));
      else if (mode === 'invalid-dispatch') socket.message({ op: 0, t: 'MESSAGE', s: 1 });
      else if (mode === 'repeat-hello') {
        await hello(socket);
        await hello(socket);
      } else if (mode === 'invalid-ready') {
        await hello(socket);
        socket.message({ op: 0, t: 'READY', s: 1, d: {} });
        await settle();
      } else {
        if (mode === 'no-ready') await hello(socket);
        await vi.advanceTimersByTimeAsync(501);
      }
      expect(socket.readyState).toBe(3);
      f.stop.abort();
      await f.work;
      expect(socket.listeners).toBe(0);
    }
    const unresolved = fixture({ api: { gateway: () => new Promise(() => {}), auth: async () => '' } });
    await settle();
    unresolved.stop.abort();
    await unresolved.work;
    expect(unresolved.sockets).toHaveLength(0);
    const auth = fixture({
      api: { gateway: async () => 'wss://synthetic.invalid', auth: () => new Promise(() => {}) },
    });
    await settle();
    await hello(auth.sockets[0]!);
    auth.stop.abort();
    await auth.work;
    expect(auth.sockets[0]!.listeners).toBe(0);
    const stopped = new AbortController();
    stopped.abort();
    await new QQGateway({
      api: {
        gateway: async () => {
          throw Error('should not resolve');
        },
        auth: async () => '',
      },
      intents: 0,
      onDispatch: async () => {},
    }).run(stopped.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('limits reconnect backoff, prevents duplicate run, refuses external plaintext sockets and ignores replayed sequences', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle();
    await expect(f.gateway.run(f.stop.signal)).rejects.toThrow('already running');
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      f.sockets.at(-1)!.disconnect();
      await settle();
      const count = f.sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(f.sockets).toHaveLength(count + 1);
    }
    await hello(f.sockets.at(-1)!);
    await ready(f.sockets.at(-1)!);
    f.sockets.at(-1)!.message({ op: 0, t: 'MESSAGE', s: 1, d: {} });
    await settle();
    expect(f.events).toHaveLength(1);
    f.stop.abort();
    await f.work;
    const unsafe = fixture({
      api: { gateway: async () => 'ws://external.invalid', auth: async () => '' },
      allowLoopback: true,
    });
    await settle();
    expect(unsafe.sockets).toHaveLength(0);
  });
  it('connects native Node WebSocket to a real loopback gateway and resumes after a server disconnect', async () => {
    const platform = await localPlatform(),
      events: GatewayDispatch[] = [],
      stop = new AbortController();
    const gateway = new QQGateway({
      api: { gateway: async () => platform.ws, auth: async () => 'QQBot synthetic-token' },
      intents: 0,
      allowLoopback: true,
      onDispatch: async (event) => {
        events.push(event);
      },
    });
    const work = gateway.run(stop.signal);
    void work.catch(() => {});
    active.push({ stop, work });
    try {
      await until(() => platform.peers.length === 1);
      platform.peers[0]!.send({ op: 10, d: { heartbeat_interval: 1000 } });
      await until(() => platform.peers[0]!.frames.length === 1);
      expect(platform.peers[0]!.frames[0]?.op).toBe(2);
      platform.peers[0]!.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session' } });
      await until(() => gateway.state().connected);
      platform.peers[0]!.send({ op: 1 });
      await until(() => platform.peers[0]!.frames.some((frame) => frame.op === 1));
      platform.peers[0]!.send({ op: 11 });
      await until(() => gateway.state().last_ack !== null);
      platform.peers[0]!.close(4009);
      await until(() => platform.peers.length === 2, 5000);
      platform.peers[1]!.send({ op: 10, d: { heartbeat_interval: 1000 } });
      await until(() => platform.peers[1]!.frames.length === 1);
      expect(platform.peers[1]!.frames[0]).toEqual({
        op: 6,
        d: { token: 'QQBot synthetic-token', session_id: 'synthetic-session', seq: 1 },
      });
      platform.peers[1]!.send({ op: 0, t: 'RESUMED', s: 2, d: {} });
      await until(() => gateway.state().sequence === 2);
      expect(events.map((event) => event.t)).toEqual(['READY', 'RESUMED']);
    } finally {
      stop.abort();
      await work;
      await platform.close();
    }
  }, 10000);
});
