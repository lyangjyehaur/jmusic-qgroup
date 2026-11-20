import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const empty = { claimed: 0, sent: 0, simulated: 0, skipped: 0, failed: 0, deferred: 0 };

// This verifies sequential library consumers against actual website work. It
// does not assert that an unupdated Python runtime participates in the new OS
// ownership lock or that a production worker switch has been authorized.
export async function exerciseRetainedWorkerHandoff({ post, read, rows, python, native, collectLinks, admin }) {
  const cases = [], completed = [], reminders = [], pins = [];
  let naturalWaitMilliseconds = 0;
  const policy = async changes => {
    const before = await read('/admin/bot');
    const saved = await post('/admin/bot', { command: 'save', revision: before.revision, config: { ...before.config, ...changes }, confirm: true }, admin);
    const after = await read('/admin/bot'); assert.equal(after.revision, saved.revision);
    assert.equal(after.revision, before.revision + Number(saved.changed));
    for (const row of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', row.id)[0], row);
  };
  const publish = async name => {
    const draft = await post('/activities/drafts', { values: { title: '合成交接 ' + name, category: '其他', location: '合成地點',
      startsAt: '2099-12-12T18:00:00+08:00', deadline: '2099-12-11T18:00:00+08:00', capacity: 2, description: '', durationHours: 1,
      withdrawalDeadline: null, visibility: 'public', timezone: 'Asia/Taipei', minimumParticipants: 0, feePolicy: '', botEnabled: true, joinOwner: false } });
    await post('/activities/' + draft.id + '/draft/publish', { revision: draft.revision, confirm: true, acceptConditions: true });
    const future = rows('SELECT * FROM bot_outbox WHERE event_id=? AND due_at IS NOT NULL', draft.id); assert.equal(future.length, 2); reminders.push(...future);
    return draft.id;
  };
  const work = (event, kind = 'activity_published') => {
    const found = rows('SELECT * FROM bot_outbox WHERE event_id=? AND kind=?', event, kind); assert.equal(found.length, 1); return found[0];
  };
  const poll = (consumer, event, first = {}, mode = 'rich', fault = 'success') => {
    const result = consumer === 'python' ? python(mode, event, fault) : native(mode, fault);
    assert.deepEqual(result.first, { ...empty, ...first }); assert.deepEqual(result.second, empty);
    if (consumer === 'python') {
      assert.equal(result.dispatch.aliases, 54); assert.equal(result.dispatch.passiveMockReplies, mode === 'dry-run' ? 0 : 55);
      assert(result.dispatch.readyAndResumed && result.dispatch.deniedGroupsNeverReplied && result.dispatch.privateIdentityRestriction);
      assert.equal(result.dispatch.actualTransportCalls, 0);
    } else {
      assert.equal(result.runtime, 'compiled-typescript'); assert.equal(result.networkTransport, 'denied'); assert.equal(result.actualQQ, false);
      assert.deepEqual(result.runtimePins.map(p => p.path), ['api/database.mjs', 'bot/transport.mjs', 'bot/outbox.mjs']);
      if (pins.length) assert.deepEqual(result.runtimePins, pins); else pins.push(...result.runtimePins);
    }
    collectLinks(result); return result;
  };
  const wait = async value => {
    const due = Date.parse(value), target = /\.\d+/.test(value) ? Math.floor(due / 1000) * 1000 + 1000 : due;
    const remaining = target - Date.now(); assert(Number.isFinite(remaining) && remaining <= 17000);
    const delay = Math.max(0, remaining + 250); naturalWaitMilliseconds += delay;
    await new Promise(resolve => setTimeout(resolve, delay));
  };
  const delivered = (row, attempts = 0) => {
    assert.equal(row.status, 'sent'); assert.equal(row.attempts, attempts); assert.equal(row.retry_at, null);
    assert(row.sent_at); assert.equal(row.simulated_at, null); assert.equal(row.last_error, ''); completed.push(row);
  };
  await policy({ dry_run: false, min_interval_seconds: 0, quiet_enabled: false });
  for (const [from, to] of [['python', 'typescript'], ['typescript', 'python']]) {
    const event = await publish(from + ' retry'), before = work(event);
    const failed = poll(from, event, { claimed: 1 }, 'rich', 'transient'); assert.equal(failed.calls.length, 1);
    const pending = work(event); assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 1);
    assert.equal(pending.payload_json, before.payload_json); assert.equal(pending.id, before.id);
    await wait(pending.retry_at);
    const resumed = poll(to, event, { claimed: 1, sent: 1 }); assert.equal(resumed.calls.length, 1);
    const after = work(event); delivered(after, 1); assert.notEqual(after.claim_token, pending.claim_token);
    assert.equal(after.id, before.id); assert.equal(after.payload_json, before.payload_json); assert.equal(after.created_at, before.created_at);
    assert.equal(poll(from, event).calls.length, 0); assert.deepEqual(work(event), after);
    cases.push({ kind: 'transient', from, to, eventId: event, first: failed.first, resumed: resumed.first,
      originalRowRecovered: true, attempts: 1, newClaimTokenVerified: true, naturalClock: true, confirmedWorkNotReplayed: true });
  }
  for (const [from, to] of [['python', 'typescript'], ['typescript', 'python']]) {
    const event = await publish(from + ' unknown'), first = poll(from, event, { claimed: 1, skipped: 1 }, 'rich', 'unconfirmed');
    assert.equal(first.calls.length, 1);
    const unknown = work(event); assert.equal(unknown.status, 'skipped'); assert.equal(unknown.attempts, 0); assert.match(unknown.last_error, /未确认/);
    assert.equal(unknown.retry_at, null); assert.equal(unknown.sent_at, null);
    const path = '/activities/' + event + '/bot-deliveries/' + unknown.id, review = await read(path);
    assert.match(review.blocker, /未確認/); assert.equal(review.reviewToken, null);
    const rejected = await post(path + '/retry', { reviewToken: 'a'.repeat(64), confirm: true }, {}, randomUUID(), 409);
    assert.equal(rejected.code, 'BOT_DELIVERY_BLOCKED');
    assert.equal(poll(to, event).calls.length, 0); assert.deepEqual(work(event), unknown); completed.push(unknown);
    cases.push({ kind: 'unconfirmed', from, to, eventId: event, first: first.first, attempts: 0, automaticAndManualReplayBlocked: true, originalUnknownRowPreserved: true });
  }
  for (const [from, to] of [['typescript', 'python'], ['python', 'typescript']]) {
    await policy({ dry_run: true });
    const event = await publish(from + ' simulation'), first = poll(from, event, { claimed: 1, simulated: 1 }, 'dry-run'); assert.equal(first.calls.length, 0);
    const simulated = work(event); assert.equal(simulated.status, 'skipped'); assert.equal(simulated.last_error, 'dry-run');
    assert(simulated.simulated_at); assert.equal(simulated.sent_at, null); assert.equal(simulated.attempts, 0); completed.push(simulated);
    await policy({ dry_run: false });
    assert.equal(poll(to, event).calls.length, 0); assert.deepEqual(work(event), simulated);
    cases.push({ kind: 'simulation', from, to, eventId: event, first: first.first, attempts: 0, simulationNeverConvertedToLive: true, originalSimulationRowPreserved: true });
  }
  const event = await publish('pacing'), first = poll('python', event, { claimed: 1, sent: 1 }); assert.equal(first.calls.length, 1); delivered(work(event));
  const reserved = rows('SELECT last_attempt_at FROM bot_runtime WHERE id=1')[0].last_attempt_at;
  await policy({ min_interval_seconds: 15 });
  const state = await read('/activities/' + event + '/lifecycle');
  await post('/activities/' + event + '/lifecycle', { revision: state.revision, action: 'pause', reason: '', confirm: true });
  const postponed = poll('typescript', event, { claimed: 1, deferred: 1 }); assert.equal(postponed.calls.length, 0);
  const pending = work(event, 'registration_paused'); assert.equal(pending.attempts, 0);
  assert.equal(Date.parse(pending.retry_at), Date.parse(reserved) + 15000);
  assert.equal(rows('SELECT last_attempt_at FROM bot_runtime WHERE id=1')[0].last_attempt_at, reserved);
  await wait(pending.retry_at);
  const resumed = poll('typescript', event, { claimed: 1, sent: 1 }); assert.equal(resumed.calls.length, 1); delivered(work(event, 'registration_paused'));
  assert.equal(poll('python', event).calls.length, 0);
  cases.push({ kind: 'pacing', from: 'python', to: 'typescript', eventId: event, first: postponed.first, resumed: resumed.first,
    intervalSeconds: 15, attempts: 0, originalReservationRespected: true, confirmedWorkNotReplayed: true, naturalClock: true });
  await policy({ min_interval_seconds: 0 });
  for (const row of [...completed, ...reminders]) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', row.id)[0], row);
  return { cases, nativeRuntimePins: pins, naturalWaitMilliseconds, futureRemindersUnchanged: true,
    completedAndUncertainRowsPreserved: true, sequentialConsumers: true, officialRuntimeSwitchVerified: false,
    actualQQ: false, fullB01ToB15Accepted: false, releaseEligible: false };
}
