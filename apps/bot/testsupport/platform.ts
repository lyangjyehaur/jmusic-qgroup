import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';

/** Local, synthetic RFC6455 fixture. Only accepts loopback, unfragmented JSON frames. */
export async function localPlatform(
  handler: (request: IncomingMessage, response: ServerResponse) => void = (_, response) => response.end('{}'),
) {
  const peers: { send: (frame: unknown) => void; close: (code: number) => void; frames: Record<string, unknown>[] }[] =
    [];
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64') +
        '\r\n\r\n',
    );
    const frames: Record<string, unknown>[] = [];
    const write = (opcode: number, data: Buffer) => {
      const header =
        data.length < 126
          ? Buffer.from([0x80 | opcode, data.length])
          : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
      socket.write(Buffer.concat([header, data]));
    };
    peers.push({
      send: (frame) => write(1, Buffer.from(JSON.stringify(frame))),
      close: (code) => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(code);
        write(8, b);
      },
      frames,
    });
    let buffer: Buffer = head;
    const consume = () => {
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15,
          masked = !!(buffer[1]! & 128);
        let size = buffer[1]! & 127,
          offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (size === 127 || !masked || size > 65535) {
          socket.destroy();
          return;
        }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4),
          data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        buffer = buffer.subarray(offset + 4 + size);
        for (let index = 0; index < size; index++) data[index] = data[index]! ^ mask[index % 4]!;
        if (opcode === 8) {
          write(8, data);
          socket.end();
          return;
        }
        if (opcode === 1) frames.push(JSON.parse(data.toString()));
      }
    };
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      consume();
    });
    consume();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}/gateway`,
    peers,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
export async function until(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw Error('Synthetic platform timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
