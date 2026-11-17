import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { object, reference, validPlatformId } from './protocol';
import { safeError, type BotObserver } from './observability';
import { outboxStamp } from './outbox-store';
export const GROUP_PUSH_BLOCK = '群主未授权主动发言，后台已暂停主动推送';
const persistentRejections = new Set([40034105, 40034101, 40054003, 1100104, 40054016]);
export function botGroupStatePath(directory: string, group = '') {
  if (group && !validPlatformId(group)) throw Error('Invalid group state reference');
  return join(directory, 'bot-group-state' + (group ? '-' + reference(group) : '') + '.json');
}
export function readBotAuthorizationBlock(directory: string, group: string, deploymentGroup: string) {
  if (!group) return null;
  let path = botGroupStatePath(directory, group);
  if (!existsSync(path) && group === deploymentGroup) path = botGroupStatePath(directory);
  if (!existsSync(path)) return null;
  if (lstatSync(directory).isSymbolicLink()) throw Error('Invalid group state directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw Error('Invalid group state file');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!object(value)) throw Error('Invalid group state document');
    return value.push_authorized === false ? GROUP_PUSH_BLOCK : null;
  } finally {
    closeSync(fd);
  }
}
export function recordBotAuthorizationRejection(
  directory: string,
  group: string,
  code: number | null,
  now: Date,
  observer: BotObserver,
) {
  if (code === null || !persistentRejections.has(code)) return;
  let stage: string | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      throw Error('Invalid group state directory');
    const path = botGroupStatePath(directory, group);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error('Invalid group state file');
    }
    stage = join(directory, '.bot-group-' + randomUUID() + '.tmp');
    const fd = openSync(stage, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ push_authorized: false, code, recorded_at: outboxStamp(now) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stage, path);
    stage = undefined;
  } catch (error) {
    observer.event('group_state_unavailable', safeError(error));
  } finally {
    if (stage)
      try {
        unlinkSync(stage);
      } catch {
        /* Keep the original refusal. */
      }
  }
}
