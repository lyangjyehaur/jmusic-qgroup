import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import reviewed from './schemas/http-access-review.json';
import type { HttpOperationSource } from './build-http-contracts';

export type HttpBoundaryMode = 'public' | 'bootstrap' | 'optional-scoped-member' | 'optional-scoped-device' | 'scoped-device' | 'scoped-member'
  | 'device-write' | 'member-write' | 'administrator-read' | 'administrator-write' | 'administrator-login' | 'erasure-proof';
export interface HttpAccessSource {
  mode: HttpBoundaryMode;
  conditions: readonly string[];
  additionalHeaders: readonly string[];
  reviewedSourceFiles: readonly string[];
  boundaryReviewed: true;
  domainAuthorizationComplete: false;
}
const modes = new Set<HttpBoundaryMode>(['public', 'bootstrap', 'optional-scoped-member', 'optional-scoped-device', 'scoped-device', 'scoped-member', 'device-write', 'member-write', 'administrator-read', 'administrator-write', 'administrator-login', 'erasure-proof']);

/** These are reviewed boundary descriptions, not inferred call-graph policies.
 * Source drift requires review; ownership, role and state acceptance stays separate. */
export function readHttpAccessBindings(root: string, rows: readonly HttpOperationSource[]): Map<string, HttpAccessSource> {
  const byId = new Map(rows.map(row => [row.id, row]));
  const bindings = new Map<string, HttpAccessSource>();
  if (byId.size !== rows.length) throw Error('Duplicate HTTP operation for access review');
  for (const [file, expected] of Object.entries(reviewed.sourcePins)) {
    if (createHash('sha256').update(readFileSync(join(root, file))).digest('hex') !== expected) throw Error('HTTP access source changed; review required: ' + file);
  }
  for (const entry of reviewed.operations) {
    const row = byId.get(entry.id), mode = entry.mode as HttpBoundaryMode;
    if (!row || row.file !== entry.file || !modes.has(mode) || bindings.has(entry.id)) throw Error('Invalid HTTP access review binding');
    const files = [entry.file, ...entry.dependencies];
    if (files.some(file => !Object.hasOwn(reviewed.sourcePins, file))) throw Error('Missing HTTP access review source pin');
    bindings.set(entry.id, { mode, conditions: entry.conditions, additionalHeaders: entry.additionalHeaders, reviewedSourceFiles: files, boundaryReviewed: true, domainAuthorizationComplete: false });
  }
  if (reviewed.requireAllOperations && rows.some(row => !bindings.has(row.id))) throw Error('HTTP operation has no reviewed identity boundary');
  return bindings;
}

const cookie = (name: string, description: string) => ({ type: 'apiKey', in: 'cookie', name, description });
const header = (name: string, description: string) => ({ type: 'apiKey', in: 'header', name, description });
export const httpSecuritySchemes = {
  BrowserSession: cookie('kanban_session', 'Unexpired member or visitor device session.'),
  MemberSession: cookie('kanban_session', 'Active member session; a visitor session is insufficient.'),
  AccountAdministrator: cookie('kanban_session', 'Active member session with the current administrator role.'),
  AdminSession: cookie('kanban_admin', 'Unexpired rescue session bound to the current configured credential.'),
  AccountScope: header('x-account-scope', 'Must equal the current device scope; stale accounts are rejected.'),
  WriteOrigin: header('Origin', 'Must equal the configured site origin.'),
  DeviceCSRF: header('x-csrf-token', 'Current device CSRF token, bound to the session and account scope.'),
  AdminCSRF: header('x-admin-csrf', 'Current administrator CSRF token, bound to the authority method and revision or rescue credential.'),
  AdminScope: header('x-admin-scope', 'Must equal the current administrator authority scope for the operation receipt.'),
};
type Requirement = Record<string, never[]>;
const requirement = (...names: string[]): Requirement => Object.fromEntries(names.map(name => [name, []]));
const deviceRead = () => requirement('BrowserSession', 'AccountScope');
const deviceWrite = () => requirement('BrowserSession', 'AccountScope', 'WriteOrigin', 'DeviceCSRF');
export function httpAccessDescription(access: HttpAccessSource) {
  let security: Requirement[] | undefined;
  switch (access.mode) {
    case 'public': case 'bootstrap': security = [{}]; break;
    case 'optional-scoped-member': case 'optional-scoped-device': security = [{}, deviceRead()]; break;
    case 'scoped-device': security = [deviceRead()]; break;
    case 'scoped-member': security = [requirement('MemberSession', 'AccountScope')]; break;
    case 'device-write': case 'administrator-login': security = [deviceWrite()]; break;
    case 'member-write': security = [requirement('MemberSession', 'AccountScope', 'WriteOrigin', 'DeviceCSRF')]; break;
    case 'administrator-read': case 'administrator-write': {
      const write = access.mode === 'administrator-write' ? ['WriteOrigin', 'DeviceCSRF', 'AdminCSRF'] : [];
      security = [requirement('AccountAdministrator', 'AccountScope', ...write), requirement('BrowserSession', 'AccountScope', 'AdminSession', ...write)];
      break;
    }
    // OpenAPI has no security scheme for a secret carried in a JSON body.
    // The existing ErasureProof request contract and extension describe it.
    case 'erasure-proof': break;
  }
  for (const name of access.additionalHeaders) {
    if (name !== 'x-admin-scope' || !security) throw Error('Unsupported access header');
    for (const alternative of security) alternative['AdminScope'] = [];
  }
  return {
    ...(security ? { security } : {}),
    'x-qgroup-access': access,
    ...(access.mode === 'erasure-proof' ? { 'x-qgroup-body-proof': { schema: 'ErasureProof', fields: ['requestId', 'secret'], browserSessionRequired: false } } : {}),
  };
}
