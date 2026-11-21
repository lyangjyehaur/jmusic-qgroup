import type { FastifyInstance } from 'fastify';
import { HttpResponses } from '@qgroup/contracts/http';

class HttpResponseContractError extends Error {
  constructor() { super('HTTP success response does not match its fixed contract'); }
}

/** Check the wire representation without transforming data, stream bytes,
 * headers, request receipts or the already completed business transaction. */
export function registerHttpResponseValidation(app: FastifyInstance) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300 || request.method === 'HEAD') return payload;
    const key = request.method + ' ' + request.routeOptions.url;
    if (!Object.hasOwn(HttpResponses, key)) return payload;
    const contract = HttpResponses[key as keyof typeof HttpResponses];
    const media = String(reply.getHeader('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    try {
      if (contract.kind === 'json') {
        if (media !== 'application/json' || typeof payload !== 'string') throw new HttpResponseContractError();
        contract.schema.parse(JSON.parse(payload));
      } else {
        if (!contract.mediaTypes.includes(media)) throw new HttpResponseContractError();
        if (contract.kind === 'download') {
          if (!/^attachment(?:;|$)/i.test(String(reply.getHeader('content-disposition') ?? '')) || typeof payload !== 'string') throw new HttpResponseContractError();
          JSON.parse(payload);
        } else if (!(payload instanceof Uint8Array) || payload.byteLength === 0) throw new HttpResponseContractError();
      }
    } catch {
      // A response defect is a server error, never an invalid user input.
      // Do not log payloads or Zod issues that could contain private data.
      throw new HttpResponseContractError();
    }
    return payload;
  });
}
