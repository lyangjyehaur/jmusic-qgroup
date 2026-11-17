import { readFileSync, statSync, accessSync, constants, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
export interface BotConfig {
  appId: string;
  appSecret: string;
  database: string;
  group: string;
  sandbox: boolean;
  dryRun: boolean;
  markdownReplies: boolean;
  apiBase: string;
  legacyApiBase: string;
  allowedLinkHosts: string[];
  pollInterval: number;
  maxAttempts: number;
  batch: number;
  claimTimeout: number;
  setupPanels: boolean;
  intents: number;
  verboseEvents: boolean;
  logDirectory: string;
  logContent: boolean;
  logContentLimit: number;
  abbreviationPageBytes: number;
}
const expand = (path: string) =>
  path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
/** Parse a private KEY=VALUE file without executing shell; caller environment wins. */
export function botEnvironment(
  environment: NodeJS.ProcessEnv,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
) {
  const result = { ...environment },
    path = environment.KANBAN_BOT_ENV;
  if (path)
    try {
      for (const line of read(expand(path)).split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw || raw.startsWith('#') || !raw.includes('=')) continue;
        const i = raw.indexOf('='),
          key = raw.slice(0, i).trim();
        if ((key.startsWith('KANBAN_') || key.startsWith('QQBOT_')) && result[key] === undefined)
          result[key] = raw
            .slice(i + 1)
            .trim()
            .replace(/^"+|"+$/g, '')
            .replace(/^'+|'+$/g, '');
      }
    } catch {
      /* Same optional environment-file behavior as the existing worker. */
    }
  return result;
}
export function loadBotConfig(
  environment: NodeJS.ProcessEnv = process.env,
  read?: (path: string) => string,
): BotConfig {
  const env = botEnvironment(environment, read),
    text = (key: string, fallback = '') => (env[key] ?? fallback).trim();
  const number = (key: string, fallback: number, min: number, integer = true) => {
    const value = text(key);
    if (!value || (integer && !/^[+-]?\d+$/.test(value))) return fallback;
    const n = Number(value);
    return Number.isFinite(n) && (!integer || Number.isSafeInteger(n)) ? Math.max(min, n) : fallback;
  };
  const database = text('KANBAN_DB'),
    sandbox = env.QQBOT_SANDBOX === '1';
  return {
    appId: text('QQBOT_APP_ID'),
    appSecret: text('QQBOT_APP_SECRET'),
    database: database ? expand(database) : '',
    group: text('KANBAN_BOT_GROUP'),
    sandbox,
    dryRun: (env.KANBAN_BOT_DRY_RUN ?? '1') !== '0',
    markdownReplies: env.KANBAN_BOT_MARKDOWN === '1',
    apiBase:
      text('KANBAN_BOT_API_BASE').replace(/\/+$/, '') ||
      (sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com'),
    legacyApiBase: 'https://api.sgroup.qq.com',
    allowedLinkHosts: text('KANBAN_BOT_ALLOWED_HOSTS')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    pollInterval: number('KANBAN_BOT_POLL_INTERVAL', 5, 1, false),
    maxAttempts: number('KANBAN_BOT_MAX_ATTEMPTS', 5, 1),
    batch: number('KANBAN_BOT_BATCH', 10, 1),
    claimTimeout: number('KANBAN_BOT_CLAIM_TIMEOUT', 600, 30),
    setupPanels: env.KANBAN_BOT_SETUP_PANELS === '1',
    intents: number('KANBAN_BOT_INTENTS', (1 << 25) | (1 << 26), 0),
    verboseEvents: env.KANBAN_BOT_VERBOSE === '1',
    logDirectory: env.KANBAN_BOT_LOG_DIR
      ? expand(env.KANBAN_BOT_LOG_DIR)
      : resolve(database ? dirname(expand(database)) : '.', 'bot-logs'),
    logContent: env.KANBAN_BOT_LOG_CONTENT === '1',
    logContentLimit: Math.min(number('KANBAN_BOT_LOG_CONTENT_LIMIT', 500, 80), 2000),
    abbreviationPageBytes: number('KANBAN_BOT_ABBREVIATION_PAGE_BYTES', 2000, 4),
  };
}
export function validateBotConfig(config: BotConfig) {
  const errors: string[] = [];
  if (!config.appId || !config.appSecret) errors.push('QQBOT_APP_ID / QQBOT_APP_SECRET 未設定');
  let fd: number | undefined;
  try {
    if (!config.database || !statSync(config.database).isFile()) throw Error();
    fd = openSync(config.database, 'r');
    const header = Buffer.alloc(16);
    if (readSync(fd, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0')))
      errors.push('KANBAN_DB 不是 SQLite 檔案');
  } catch {
    errors.push('KANBAN_DB 必須指向可讀的 SQLite 檔案');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (config.database)
    try {
      accessSync(config.database, constants.W_OK);
    } catch {
      errors.push('KANBAN_DB 不可寫：bot 必須更新投遞狀態');
    }
  for (const base of [config.apiBase, config.legacyApiBase])
    try {
      const u = new URL(base);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error();
    } catch {
      errors.push('bot API 網址格式不正確');
      break;
    }
  return errors;
}
export function describeBotConfig(config: BotConfig) {
  return {
    database: config.database,
    groupConfigured: !!config.group,
    dryRun: config.dryRun,
    sandbox: config.sandbox,
    apiHost: safeHost(config.apiBase),
    pollInterval: config.pollInterval,
    batch: config.batch,
    setupPanels: config.setupPanels,
  };
}
function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
