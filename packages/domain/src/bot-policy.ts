import { BOT_KINDS, BotPolicy, type BotGroup } from '@qgroup/contracts';
import { validateBotTemplate } from './bot-templates';
import { botMoment } from './bot-clock';
export type BotPolicyDefaults = Partial<BotPolicy>;
/** Both producers and workers receive deployment defaults explicitly. No ambient environment reads. */
export function defaultBotPolicy(defaults: BotPolicyDefaults = {}): BotPolicy {
  return {
    enabled: false,
    replies_enabled: true,
    dry_run: null,
    broadcast_kinds: Object.keys(BOT_KINDS) as (keyof typeof BOT_KINDS)[],
    schedule_enabled: true,
    deadline_hours: 24,
    estimated_over_delay_minutes: 0,
    quiet_enabled: false,
    quiet_start: '23:00',
    quiet_end: '08:00',
    timezone: 'Asia/Taipei',
    min_interval_seconds: 0,
    templates: {},
    groups: null,
    ...defaults,
  };
}
export function botPolicyDefaults(environment: Readonly<Record<string, string | undefined>>): BotPolicyDefaults {
  const raw = (environment.KANBAN_BOT_BROADCAST_KINDS ?? '').trim();
  const selected = new Set(raw.split(',').map((value) => value.trim()));
  return {
    enabled: environment.KANBAN_BOT_ENABLED === '1',
    schedule_enabled: (environment.KANBAN_BOT_SCHEDULE ?? '1') === '1',
    broadcast_kinds: (Object.keys(BOT_KINDS) as (keyof typeof BOT_KINDS)[]).filter(
      (kind) => !raw || selected.has(kind),
    ),
  };
}
export function validateBotPolicy(value: unknown): BotPolicy {
  const config = BotPolicy.parse(value);
  for (const template of Object.values(config.templates)) validateBotTemplate(template);
  return config;
}
export function resolvedBotGroups(config: Pick<BotPolicy, 'groups'>, fallback = ''): BotGroup[] {
  return (
    config.groups ??
    (/^[A-Za-z0-9_-]{1,128}$/.test(fallback) ? [{ id: fallback, name: '', replies: true, broadcast: true }] : [])
  );
}
export function botReplyAllowed(config: Pick<BotPolicy, 'groups'>, group: string, fallback = '') {
  return resolvedBotGroups(config, fallback).some((g) => g.id === group && g.replies);
}
export function botBroadcastTarget(config: Pick<BotPolicy, 'groups'>, fallback = '') {
  return resolvedBotGroups(config, fallback).find((g) => g.broadcast)?.id ?? '';
}
export function botDryRun(config: Pick<BotPolicy, 'dry_run'>, deployment: boolean) {
  return config.dry_run ?? deployment;
}
/** Preserve Python local-wall replacement, including the current fold and next-day reset. */
export function botQuietUntil(
  config: Pick<BotPolicy, 'quiet_enabled' | 'quiet_start' | 'quiet_end' | 'timezone'>,
  moment: Date,
): Date | null {
  if (!config.quiet_enabled) return null;
  const zone = config.timezone === 'Factory' ? 'UTC' : config.timezone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(moment);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  const clock = part('hour') + ':' + part('minute'),
    start = config.quiet_start,
    end = config.quiet_end;
  if (!(start < end ? start <= clock && clock < end : clock >= start || clock < end)) return null;
  const day = part('year') + '-' + part('month') + '-' + part('day');
  let stop = botMoment(day + 'T' + end + ':00', zone);
  // Python compares local wall times before converting to UTC, including fold=1.
  if (end <= clock) {
    const next = new Date(day + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    stop = botMoment(next.toISOString().slice(0, 10) + 'T' + end + ':00', zone);
  }
  if (end > clock) {
    const wall = day + 'T' + clock + ':' + part('second') + '.' + String(moment.getUTCMilliseconds()).padStart(3, '0');
    const foldDelta = moment.getTime() - botMoment(wall, zone);
    if (foldDelta > 0) {
      const candidate = new Date(stop + foldDelta),
        candidateParts = new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(candidate);
      if (
        candidateParts.find((p) => p.type === 'hour')?.value +
          ':' +
          candidateParts.find((p) => p.type === 'minute')?.value ===
        end
      )
        stop = candidate.getTime();
    }
  }
  return new Date(stop);
}
