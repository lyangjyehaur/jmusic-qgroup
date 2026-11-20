import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const empty = { claimed: 0, sent: 0, simulated: 0, skipped: 0, failed: 0, deferred: 0 };
const stamp = ms => new Date(ms).toISOString().slice(0, 19) + '+00:00';

// All work originates from compiled-web HTTP operations. Never change stored
// due/retry/claim times to make a worker run, and never replace its clock.
export async function exerciseRetainedPythonRecovery({ post, read, rows, python, collectLinks, admin }) {
  const report = { reminders: [], failures: [] }, completed = [];
  let naturalWaitMilliseconds = 0;
  const waitUntil = async (value, maximum) => {
    // The retained Python claimant compares second-only UTC strings. A stored
    // fractional timestamp sorts after that entire second, including .000000.
    const due = Date.parse(value), target = /\.\d+/.test(value) ? Math.floor(due / 1000) * 1000 + 1000 : due;
    const remaining = target - Date.now();
    assert(Number.isFinite(remaining) && remaining <= maximum);
    const delay = Math.max(0, remaining + 250);
    naturalWaitMilliseconds += delay;
    await new Promise(resolve => setTimeout(resolve, delay));
  };
  const policy = async changes => {
    const before = await read('/admin/bot');
    const saved = await post('/admin/bot', { command: 'save', revision: before.revision, config: { ...before.config, ...changes }, confirm: true }, admin);
    const after = await read('/admin/bot');
    assert.equal(after.revision, before.revision + Number(saved.changed));
    assert.equal(after.revision, saved.revision);
    for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
    return after;
  };
  const publish = async (name, reminder = false) => {
    const now = Date.now();
    const draft = await post('/activities/drafts', { values: {
      title: '合成 ' + name, category: '其他', location: '合成地點',
      startsAt: '2099-12-12T18:00:00+08:00', deadline: reminder ? stamp(now + 3600000 + 40000) : '2099-12-11T18:00:00+08:00',
      capacity: 2, description: '', durationHours: 1, withdrawalDeadline: null, visibility: 'public', timezone: 'Asia/Taipei',
      minimumParticipants: 0, feePolicy: '', botEnabled: true, joinOwner: false,
    } });
    await post('/activities/' + draft.id + '/draft/publish', { revision: draft.revision, confirm: true, acceptConditions: true });
    return draft.id;
  };
  const work = (event, kind = 'activity_published') => {
    const found = rows('SELECT * FROM bot_outbox WHERE event_id=? AND kind=? ORDER BY id', event, kind);
    assert.equal(found.length, 1); return found[0];
  };
  const consume = (mode, event, first, fault = 'success') => {
    const result = python(mode, event, fault);
    assert.deepEqual(result.first, { ...empty, ...first }); assert.deepEqual(result.second, empty);
    assert.equal(result.dispatch.aliases, 54); assert(result.dispatch.readyAndResumed);
    assert(result.dispatch.deniedGroupsNeverReplied && result.dispatch.privateIdentityRestriction);
    // Quiet periods and quota waits affect broadcasts, not passive replies.
    assert.equal(result.dispatch.passiveMockReplies, mode === 'dry-run' ? 0 : 55);
    assert.equal(result.dispatch.actualTransportCalls, 0);
    collectLinks(result); return result;
  };
  const finish = (row, mode, attempts = 0) => {
    assert.equal(row.status, mode === 'dry-run' ? 'skipped' : 'sent'); assert.equal(row.attempts, attempts);
    assert.equal(row.retry_at, null); assert.equal(row.last_error, mode === 'dry-run' ? 'dry-run' : '');
    assert.equal(Boolean(row.sent_at), mode !== 'dry-run'); assert.equal(Boolean(row.simulated_at), mode === 'dry-run');
    completed.push(row);
  };
  for (const mode of ['plain', 'rich', 'dry-run']) {
    await policy({ dry_run: null, deadline_hours: 1, quiet_enabled: false, min_interval_seconds: 0 });
    const event = await publish('到期提醒 ' + mode, true), before = work(event, 'deadline_reminder'), future = work(event, 'estimated_over_reminder');
    assert.equal(before.status, 'pending'); assert(Date.parse(before.due_at) > Date.now());
    const publication = consume(mode, event, { claimed: 1, sent: mode === 'dry-run' ? 0 : 1, simulated: mode === 'dry-run' ? 1 : 0 });
    assert.equal(publication.calls.length, mode === 'dry-run' ? 0 : 1); finish(work(event), mode);
    assert.deepEqual(work(event, 'deadline_reminder'), before);
    await waitUntil(before.due_at, 45000);
    const reminder = consume(mode, event, { claimed: 1, sent: mode === 'dry-run' ? 0 : 1, simulated: mode === 'dry-run' ? 1 : 0 });
    assert.equal(reminder.calls.length, mode === 'dry-run' ? 0 : 1);
    const after = work(event, 'deadline_reminder'); finish(after, mode);
    assert.equal(after.due_at, before.due_at); assert.equal(after.payload_json, before.payload_json);
    assert.deepEqual(work(event, 'estimated_over_reminder'), future);
    report.reminders.push({ mode, eventId: event, dueAt: before.due_at, first: reminder.first, second: reminder.second,
      futureEstimatedOverUnchanged: true, naturalClock: true, mockCalls: reminder.calls.length });
  }
  await policy({ dry_run: false });
  // An active UTC quiet window ends at a real minute boundary, at least 15s
  // away so container HTTP overhead cannot accidentally miss the window.
  const moment = Date.now(), minute = Math.floor(moment / 60000) * 60000;
  const end = minute + (minute + 60000 - moment >= 15000 ? 60000 : 120000);
  const clock = ms => new Date(ms).toISOString().slice(11, 16);
  await policy({ timezone: 'UTC', quiet_enabled: true, quiet_start: clock(minute - 60000), quiet_end: clock(end) });
  const quietEvent = await publish('勿擾恢復');
  const quiet = consume('plain', quietEvent, { claimed: 1, deferred: 1 });
  assert.equal(quiet.calls.length, 0);
  const postponed = work(quietEvent); assert.equal(postponed.status, 'pending'); assert.equal(postponed.attempts, 0);
  assert.equal(Date.parse(postponed.retry_at), end);
  await waitUntil(postponed.retry_at, 120000);
  const quietResume = consume('plain', quietEvent, { claimed: 1, sent: 1 }); assert.equal(quietResume.calls.length, 1); finish(work(quietEvent), 'plain');
  report.quiet = { eventId: quietEvent, first: quiet.first, second: quiet.second, retryAt: postponed.retry_at,
    resumed: quietResume.first, attempts: 0, passiveRepliesDuringQuiet: 55, mockCallsBeforeResume: 0, naturalClock: true, freshWorker: true };

  await policy({ quiet_enabled: false, min_interval_seconds: 15 });
  const pacedEvent = await publish('持久發送間隔');
  // A previous scenario may have reserved a slot. Wait for that existing
  // reservation, then consume publication before creating the next card.
  const prior = rows('SELECT last_attempt_at FROM bot_runtime WHERE id=1')[0].last_attempt_at;
  await waitUntil(stamp(Date.parse(prior) + 16000), 17000);
  consume('plain', pacedEvent, { claimed: 1, sent: 1 }); finish(work(pacedEvent), 'plain');
  const lastAttempt = rows('SELECT last_attempt_at FROM bot_runtime WHERE id=1')[0].last_attempt_at;
  const lifecycle = await read('/activities/' + pacedEvent + '/lifecycle');
  await post('/activities/' + pacedEvent + '/lifecycle', { revision: lifecycle.revision, action: 'pause', reason: '', confirm: true });
  const paced = consume('plain', pacedEvent, { claimed: 1, deferred: 1 }); assert.equal(paced.calls.length, 0);
  const pacedRow = work(pacedEvent, 'registration_paused'); assert.equal(pacedRow.attempts, 0);
  assert.equal(Date.parse(pacedRow.retry_at), Date.parse(lastAttempt) + 15000);
  assert.equal(rows('SELECT last_attempt_at FROM bot_runtime WHERE id=1')[0].last_attempt_at, lastAttempt);
  await waitUntil(pacedRow.retry_at, 16000);
  const pacedResume = consume('plain', pacedEvent, { claimed: 1, sent: 1 }); assert.equal(pacedResume.calls.length, 1); finish(work(pacedEvent, 'registration_paused'), 'plain');
  report.pacing = { eventId: pacedEvent, first: paced.first, second: paced.second, resumed: pacedResume.first,
    intervalSeconds: 15, attempts: 0, durableReservation: true, naturalClock: true, freshWorker: true };
  await policy({ min_interval_seconds: 0 });

  for (const fault of ['transient', 'rate-limit', 'permanent', 'unconfirmed']) {
    const event = await publish('投遞 ' + fault), before = work(event);
    const first = consume('rich', event, { claimed: 1, ...(fault === 'rate-limit' ? { deferred: 1 } : fault === 'permanent' ? { failed: 1 } : fault === 'unconfirmed' ? { skipped: 1 } : {}) }, fault);
    assert.equal(first.calls.length, 1);
    const failed = work(event), path = '/activities/' + event + '/bot-deliveries/' + before.id;
    const review = await read(path);
    const receipt = { fault, eventId: event, first: first.first, second: first.second, originalStatus: failed.status,
      originalAttempts: failed.attempts, actualTransportCalls: 0, freshWorker: true };
    if (fault === 'transient' || fault === 'rate-limit') {
      assert.equal(failed.status, 'pending'); assert.equal(failed.attempts, fault === 'transient' ? 1 : 0);
      assert.equal(review.blocker, '這條通知仍在待送，請等待投遞結果'); assert.equal(review.reviewToken, null);
      assert.equal(failed.sent_at, null); assert.equal(failed.simulated_at, null);
      const delay = fault === 'transient' ? 15 : 60;
      assert(Date.parse(failed.retry_at) - Date.parse(failed.claimed_at) >= (delay - 1) * 1000);
      await waitUntil(failed.retry_at, (delay + 1) * 1000);
      const recovered = consume('rich', event, { claimed: 1, sent: 1 }); assert.equal(recovered.calls.length, 1);
      finish(work(event), 'rich', failed.attempts);
      Object.assign(receipt, { retryAt: failed.retry_at, retryDelaySeconds: delay, resumed: recovered.first, naturalClock: true, originalRowRecovered: true });
    } else if (fault === 'permanent') {
      assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 1); assert.equal(failed.retry_at, null);
      assert.equal(review.blocker, null); assert.equal(typeof review.reviewToken, 'string');
      const key = randomUUID(), command = { reviewToken: review.reviewToken, confirm: true };
      const queued = await post(path + '/retry', command, {}, key);
      const queuedBefore = rows('SELECT * FROM bot_outbox WHERE id=?', queued.queuedId)[0];
      assert.equal(queued.originalId, String(failed.id)); assert.notEqual(queued.queuedId, queued.originalId);
      assert.equal(queuedBefore.payload_json, failed.payload_json); assert.equal(queuedBefore.attempts, 0);
      const frozen = rows('SELECT * FROM bot_outbox ORDER BY id');
      assert.deepEqual(await post(path + '/retry', command, {}, key), queued);
      assert.deepEqual(rows('SELECT * FROM bot_outbox ORDER BY id'), frozen);
      assert.deepEqual((await read('/bot-delivery-results/' + key)).result, queued);
      const retried = consume('rich', event, { claimed: 1, sent: 1 }); assert.equal(retried.calls.length, 1);
      finish(rows('SELECT * FROM bot_outbox WHERE id=?', queued.queuedId)[0], 'rich');
      assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', failed.id)[0], failed); completed.push(failed);
      Object.assign(receipt, { resumed: retried.first, manualRetryOriginalReceiptReplayed: true, originalFailurePreserved: true, queuedId: queued.queuedId });
    } else {
      assert.equal(failed.status, 'skipped'); assert.equal(failed.attempts, 0); assert.equal(failed.retry_at, null);
      assert.match(failed.last_error, /未确认/); assert.match(review.blocker, /未確認/); assert.equal(review.reviewToken, null);
      const rejected = await post(path + '/retry', { reviewToken: 'a'.repeat(64), confirm: true }, {}, randomUUID(), 409);
      assert.equal(rejected.code, 'BOT_DELIVERY_BLOCKED');
      const unchanged = rows('SELECT * FROM bot_outbox ORDER BY id');
      consume('rich', event, {});
      assert.deepEqual(rows('SELECT * FROM bot_outbox ORDER BY id'), unchanged); completed.push(failed);
      Object.assign(receipt, { automaticAndManualReplayBlocked: true, unknownDeliveryPreserved: true });
    }
    report.failures.push(receipt);
  }
  for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
  return { ...report, naturalWaitMilliseconds, originalCompletedRowsPreserved: true, clocksAndStoredTimesUnmodified: true,
    actualQQ: false, fullB09B10Accepted: false, releaseEligible: false };
}
