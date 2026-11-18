import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
/** Match the existing loopback reverse proxy; ignore forwarded headers from other peers. */
export function clientAddress(request:Pick<FastifyRequest,'raw'|'headers'|'ip'>){
 const peer=request.raw.socket.remoteAddress??request.ip,ipv4=peer.startsWith('::ffff:')?peer.slice(7):peer;
 const loopback=peer==='::1'||isIP(ipv4)===4&&ipv4.startsWith('127.');
 const supplied=request.headers['x-real-ip'];
 return loopback&&typeof supplied==='string'&&isIP(supplied)>0?supplied:peer;
}
