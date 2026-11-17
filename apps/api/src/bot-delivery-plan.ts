import type { DB } from '@qgroup/database';
import type { BotPolicy } from '@qgroup/contracts';
import { botLocalTime } from '@qgroup/domain';
import { buildActivityBotMessage,renderActivityBot,type ActivityBotDefaults } from './activity-bot';
import { eventRow,type EventRow } from './activity-arrangements';
import { composeTimePollBotMessage } from './time-poll-bot';
import { pollAvailable,pollOptions,type PollRow } from './time-poll-context';
import { reminderKinds,outboxPayload,type DeliveryIntent } from './bot-delivery-rules';
type Context=Parameters<typeof renderActivityBot>[2];
type APIObject=Record<string,unknown>;
const object=(value:unknown):value is APIObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function deliveryContext(context: Context, event: EventRow | undefined): Context {
  const frozen = context._countdown_event;
  const same =
    event &&
    (object(frozen)
      ? frozen.starts_at === event.starts_at && frozen.timezone === event.timezone
      : context.starts_at === botLocalTime(event.starts_at, event.timezone));
  return {
    ...context,
    _countdown_event: same
      ? { starts_at: event.starts_at, timezone: event.timezone, lifecycle: event.lifecycle }
      : null,
  };
}
export function prepareOutboxPayload(
  db: DB,
  row: DeliveryIntent,
  policy: BotPolicy,
  now: Date,
  defaults: ActivityBotDefaults,
): APIObject | null {
  const payload = outboxPayload(row);
  if (row.poll_id) {
    const poll = db.prepare('SELECT * FROM time_polls WHERE id=?').get(row.poll_id) as PollRow;
    const candidates = pollOptions(db, poll.id).filter((option) => pollAvailable(option, poll, now));
    if (!candidates.length) return null;
    return composeTimePollBotMessage(poll, candidates, policy, defaults).payload;
  }
  const event = row.event_id ? eventRow(db, row.event_id) : undefined;
  if (reminderKinds.has(row.kind)) {
    if (!event) return null;
    const message = buildActivityBotMessage(
      db,
      event,
      row.kind as 'deadline_reminder' | 'estimated_over_reminder',
      policy,
      now,
      defaults,
    );
    if (!message) return null;
    return {
      text: message.text,
      msg_type: 0,
      markdown_text: message.markdown,
      ...(defaults.keyboard
        ? {
            keyboard: {
              content: {
                rows: message.buttons.map(([label, data, jump], index) => ({
                  buttons: [
                    {
                      id: String(index + 1),
                      render_data: { label, visited_label: label, style: 1 },
                      action: jump
                        ? { type: 0, permission: { type: 2 }, data: jump }
                        : { type: 1, permission: { type: 2 }, data: data ? data + ' ' + row.event_id : '' },
                    },
                  ],
                })),
              },
            },
          }
        : {}),
    };
  }
  if (object(payload._template_context)) {
    const context = deliveryContext(payload._template_context as Context, event);
    payload.text = renderActivityBot(
      policy,
      row.kind as Parameters<typeof renderActivityBot>[1],
      context,
      now,
    );
    try {
      payload.markdown_text = renderActivityBot(
        policy,
        row.kind as Parameters<typeof renderActivityBot>[1],
        context,
        now,
        true,
      );
    } catch {
      payload.markdown_text = null;
    }
  }
  return payload;
}
