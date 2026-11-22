import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { exerciseRetainedPythonRecovery } from './retained-python-recovery.mjs';
import { exerciseRetainedWorkerHandoff } from './retained-worker-handoff.mjs';

// Both adapters execute these same HTTP and original-worker assertions.
export async function exerciseRetainedPython({ origin, rescue, rows, python, native, onlyHandoff = false, fetch = globalThis.fetch }) {
  const results = [], linkChecks = new Set(), completed = [];
  let rateLimitDeferrals = 0, rateLimitWaitSeconds = 0;
  const collectLinks = value => { for (const url of JSON.stringify(value).match(/http:\/\/127\.0\.0\.1:\d+[^\s"\\<>]*/g) ?? []) linkChecks.add(url.replace(/[)\]，。；]+$/, '')); };
  const webRuntime = await (await fetch(origin + '/api/v2/version')).json(); assert.equal(webRuntime.service, 'web'); assert.equal(webRuntime.runtime, 'typescript');
  let cookie = 'kanban_session=synthetic-retained-alice';
  const viewer = await (await fetch(origin + '/api/v2/session', { headers: { Cookie: cookie } })).json();
  assert.equal(viewer.authenticated, true); assert.equal(viewer.nickname, 'alice');
  const headers = { Cookie: cookie, Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Content-Type': 'application/json' };
  const post = async (path, value, extra = {}, key = randomUUID(), status = 200) => {
    const body = JSON.stringify(value), requestHeaders = { ...headers, Cookie: cookie, 'Idempotency-Key': key, ...extra };
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(origin + '/api/v2' + path, { method: 'POST', headers: requestHeaders, body, signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        assert.equal(JSON.parse(text).code, 'INVALID_REQUEST'); assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60);
        rateLimitDeferrals++; rateLimitWaitSeconds += seconds;
        await new Promise(resolve => setTimeout(resolve, seconds * 1000)); continue;
      }
      assert.equal(response.status, status, path + ': ' + text); return JSON.parse(text);
    }
    assert.fail('Retained Python scenario exhausted bounded rate-limit recovery');
  };
  const login = await fetch(origin + '/api/v2/admin/login', { method: 'POST', headers, body: JSON.stringify({ key: rescue, confirm: true }) });
  assert.equal(login.status, 200); await login.arrayBuffer(); cookie += '; ' + login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const read = async path => { const response = await fetch(origin + '/api/v2' + path, { headers: { Cookie: cookie, 'X-Account-Scope': viewer.scope }, signal: AbortSignal.timeout(5000) }); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const access = await read('/admin/session'), admin = { 'X-Admin-CSRF': access.adminCsrf };
  if (onlyHandoff) {
    const before = await read('/admin/bot');
    await post('/admin/bot', { command: 'save', revision: before.revision, config: { ...before.config, enabled: true,
      groups: [{ id: 'synthetic-group', name: '', replies: true, broadcast: true }] }, confirm: true }, admin);
    const handoff = await exerciseRetainedWorkerHandoff({ post, read, rows, python, native, collectLinks, admin });
    return { webRuntime, handoff, focus: 'worker-handoff-only', fullScenarioVerified: false, rateLimitDeferrals, rateLimitWaitSeconds };
  }
  for (const mode of ['plain', 'rich', 'dry-run']) {
    const sent = mode === 'dry-run' ? 0 : 1, simulated = mode === 'dry-run' ? 1 : 0;
    const emptyPoll = { claimed: 0, sent: 0, simulated: 0, skipped: 0, failed: 0, deferred: 0 };
    const beforePolicy = await read('/admin/bot');
    const config = { ...beforePolicy.config, enabled: true, dry_run: null, groups: [{ id: 'synthetic-group', name: '', replies: true, broadcast: true }], templates: { ...beforePolicy.config.templates, activity_published: mode + ': {title}\n正式 {confirmed} 人\n{url}' } };
    await post('/admin/bot', { command: 'save', revision: beforePolicy.revision, config, confirm: true }, admin);
    for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
    const policy = await read('/admin/bot'); assert.equal(policy.revision, beforePolicy.revision + 1);
    const draft = await post('/activities/drafts', { values: { title: 'compiled web ' + mode, category: '其他', location: '合成地點', startsAt: '2099-12-12T18:00:00+08:00', deadline: '2099-12-11T18:00:00+08:00', capacity: 2, description: '合成原文', durationHours: 3, withdrawalDeadline: null, visibility: 'public', timezone: 'Asia/Taipei', minimumParticipants: 0, feePolicy: '', botEnabled: true, joinOwner: true } });
    const key = randomUUID(), command = { revision: draft.revision, confirm: true, acceptConditions: true };
    const published = await post('/activities/' + draft.id + '/draft/publish', command, {}, key);
    const frozen = rows('SELECT * FROM bot_outbox WHERE event_id=? ORDER BY id', draft.id);
    assert.equal(frozen.filter(r => r.kind === 'activity_published').length, 1); assert.equal(frozen.filter(r => r.due_at).length, 2);
    const data = python(mode, draft.id);
    const dispatchExpected = { aliases: 54, passiveMockReplies: mode === 'dry-run' ? 0 : 55,
      originalReplyBodiesVerified: mode === 'dry-run' ? null : true,
      callbackMockAcks: 2, readyAndResumed: true, duplicateEventsSuppressed: true,
      callbackAckBeforeReply: mode === 'dry-run' ? null : true,
      originalOuterEventIdPreserved: mode === 'dry-run' ? null : true, callbackReplySuppressed: mode === 'dry-run',
      deniedGroupsNeverReplied: true, ignoredMessagesNeverReplied: true,
      privateIdentityRestriction: true, actualTransportCalls: 0 };
    assert.deepEqual(data.dispatch, dispatchExpected);
    assert.deepEqual(data.first, { ...emptyPoll, claimed: 1, sent, simulated });
    assert.deepEqual(data.second, emptyPoll);
    assert.equal(data.queries.length, 54); assert.equal(new Set(data.queries.map(row => row.alias)).size, 54);
    assert.equal(data.first.claimed, 1); assert.equal(data.second.claimed, 0); assert.equal(data.first.failed, 0);
    assert.equal(data.first.sent, mode === 'dry-run' ? 0 : 1); assert.equal(data.first.simulated, mode === 'dry-run' ? 1 : 0);
    assert.equal(data.calls.length, mode === 'dry-run' ? 0 : 1); assert.equal(data.revision, policy.revision);
    const latest = rows('SELECT * FROM bot_outbox WHERE event_id=? ORDER BY id', draft.id), delivered = latest.find(r => r.kind === 'activity_published');
    assert.equal(delivered.status, mode === 'dry-run' ? 'skipped' : 'sent'); assert.equal(delivered.attempts, 0);
    assert.equal(delivered.last_error, mode === 'dry-run' ? 'dry-run' : ''); assert.equal(Boolean(delivered.simulated_at), mode === 'dry-run'); assert.equal(Boolean(delivered.sent_at), mode !== 'dry-run');
    const payload = JSON.parse(delivered.delivered_payload_json); assert.equal(payload.msg_type, mode === 'plain' ? 0 : 2);
    for (const reminder of latest.filter(r => r.due_at)) assert.deepEqual(reminder, frozen.find(r => r.id === reminder.id));
    const originalRows = rows('SELECT * FROM bot_outbox ORDER BY id');
    assert.deepEqual(await post('/activities/' + draft.id + '/draft/publish', command, {}, key), published);
    assert.deepEqual(rows('SELECT * FROM bot_outbox ORDER BY id'), originalRows);
    const input = { revision: published.revision, people: ['同行甲', '同行乙'].map(name => ({ isSelf: false, name, note: 'PRIVATE_SYNTHETIC_NOTE', payerKind: 'manager' })), queueMode: 'individual', intent: 'registered' };
    const preview = await post('/activities/' + draft.id + '/registration/preview', input);
    assert.deepEqual(preview.allocation.map(row => row.status), ['confirmed', 'waiting']);
    const joined = await post('/activities/' + draft.id + '/registration', { ...input, conditionsVersion: preview.conditionsVersion, previewToken: preview.token, acceptConditions: true, acceptPartial: true, confirm: true });
    const signup = python(mode, draft.id); assert.equal(signup.first.failed, 0); assert.equal(signup.second.claimed, 0);
    assert.deepEqual(signup.dispatch, dispatchExpected);
    assert.deepEqual(signup.first, { ...emptyPoll, claimed: 1, sent, simulated });
    assert.deepEqual(signup.second, emptyPoll); assert.equal(signup.calls.length, sent);
    const owner = rows('SELECT id FROM attendees WHERE event_id=? AND user_id=?', draft.id, 'alice')[0];
    const beforeWithdrawal = rows('SELECT * FROM bot_outbox ORDER BY id');
    await post('/activities/' + draft.id + '/attendees/' + owner.id + '/registration', { revision: joined.revision, action: 'withdraw', name: '', note: '', payerKind: 'self', reason: '', confirm: true });
    const newRows = rows('SELECT * FROM bot_outbox ORDER BY id').filter(row => !beforeWithdrawal.some(old => old.id === row.id));
    assert.equal(newRows.filter(row => row.channel === 'group' && row.kind === 'registration_changed').length, 1);
    assert.deepEqual(rows('SELECT status FROM attendees WHERE event_id=? ORDER BY seq', draft.id).map(row => row.status), ['withdrawn', 'confirmed', 'confirmed']);
    const withdrawal = python(mode, draft.id); assert.equal(withdrawal.first.failed, 0); assert.equal(withdrawal.second.claimed, 0);
    assert.deepEqual(withdrawal.dispatch, dispatchExpected);
    assert.deepEqual(withdrawal.first, { ...emptyPoll, claimed: 2, sent, simulated, skipped: 1 });
    assert.deepEqual(withdrawal.second, emptyPoll);
    assert.equal(withdrawal.calls.length, mode === 'dry-run' ? 0 : 1);
    assert(!JSON.stringify([...signup.calls, ...withdrawal.calls]).includes('PRIVATE_SYNTHETIC_NOTE'));
    const after = rows('SELECT * FROM bot_outbox WHERE event_id=? ORDER BY id', draft.id);
    assert.equal(after.filter(row => row.channel === 'private').length, 1);
    for (const privateRow of after.filter(row => row.channel === 'private')) { assert.equal(privateRow.status, 'skipped'); assert.match(privateRow.last_error, /no binding/); }
    for (const reminder of after.filter(row => row.due_at)) assert.deepEqual(reminder, frozen.find(row => row.id === reminder.id));
    completed.push(...after.filter(row => ['sent', 'skipped'].includes(row.status)));
    assert(data.mine.includes('尚未绑定')); assert(!JSON.stringify(data.queries).includes('synthetic-retained-'));
    collectLinks(data);
    // Each action goes through the compiled HTTP application. The fixed
    // original worker then consumes its real committed outbox; only platform
    // transport is replaced, including the file-upload response protocol.
    const consume = (kind, count = 1, images = 0) => {
      const pending = rows("SELECT * FROM bot_outbox WHERE status='pending' AND kind=? ORDER BY id", kind);
      assert.equal(pending.length, count);
      const result = python(mode, draft.id);
      assert.deepEqual(result.dispatch, dispatchExpected);
      assert.deepEqual(result.first, { ...emptyPoll, claimed: count, sent: sent * count, simulated: simulated * count });
      assert.deepEqual(result.second, emptyPoll);
      assert.equal(result.calls.length, mode === 'dry-run' ? 0 : count + images);
      assert(result.calls.every(call => ['/v2/groups/synthetic-group/messages', '/v2/groups/synthetic-group/files'].includes(call.path)));
      assert(!JSON.stringify(result.calls).includes('PRIVATE_SYNTHETIC_NOTE'));
      const uploads = result.calls.filter(call => call.path.endsWith('/files'));
      assert.equal(uploads.length, mode === 'dry-run' ? 0 : images);
      const done = pending.map(row => rows('SELECT * FROM bot_outbox WHERE id=?', row.id)[0]);
      assert(done.every(row => row.status === (mode === 'dry-run' ? 'skipped' : 'sent')));
      for (const row of done) {
        assert.equal(row.attempts, 0); assert.equal(row.last_error, mode === 'dry-run' ? 'dry-run' : '');
        assert.equal(Boolean(row.simulated_at), mode === 'dry-run'); assert.equal(Boolean(row.sent_at), mode !== 'dry-run');
        assert.equal(JSON.parse(row.delivered_payload_json).msg_type, JSON.parse(row.payload_json)._settlement_image ? 7 : mode === 'plain' ? 0 : 2);
      }
      completed.push(...done); collectLinks(result);
      return { result, uploads, rows: done };
    };
    const replay = async (path, command, key, response) => {
      const frozen = rows('SELECT * FROM bot_outbox ORDER BY id');
      assert.deepEqual(await post(path, command, {}, key), response);
      assert.deepEqual(rows('SELECT * FROM bot_outbox ORDER BY id'), frozen);
    };
    const lifecycle = [];
    const transition = async (action, kind) => {
      const current = await read('/activities/' + draft.id + '/lifecycle'), path = '/activities/' + draft.id + '/lifecycle';
      const command = { revision: current.revision, action, reason: action === 'cancel' ? '合成取消原因' : '', confirm: true }, key = randomUUID();
      const response = await post(path, command, {}, key), delivered = consume(kind);
      await replay(path, command, key, response);
      lifecycle.push({ action, kind, first: delivered.result.first, second: delivered.result.second, originalReceiptReplayed: true });
    };
    for (const [action, kind] of [['pause', 'registration_paused'], ['resume', 'registration_resumed'], ['formation', 'formation_confirmed'], ['start', 'event_started'], ['finish', 'event_finished']]) await transition(action, kind);
    // This synthetic image is a complete 1x1 RGB PNG, independently generated
    // before the scenario. Verify uploads contain its original bytes, not a URL
    // or an image from a later settlement version.
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
    const current = await read('/activities/' + draft.id + '/lifecycle'), invoice = {
      revision: current.revision, base_version: 0, reviewed_roster: true,
      people: rows('SELECT id,status FROM attendees WHERE event_id=? ORDER BY seq', draft.id).map(row => ({ id: row.id, ...(row.status === 'withdrawn' ? { share: '0', reason: '合成已退出' } : {}) })),
      items: [{ id: randomUUID().replaceAll('-', '').slice(0, 16), name: '合成消費', amount: '10.03' }], group_notice: true,
      payment_codes: ['wechat', 'alipay', 'other'].map(kind => ({ kind, image, name: '合成' + kind })),
    };
    const invoicePreview = await post('/activities/' + draft.id + '/settlement/preview', invoice);
    assert.equal(invoicePreview.snapshot.total_cents, 1003);
    const invoiceCommand = { ...invoice, preview_token: invoicePreview.preview_token, confirm: true }, invoiceKey = randomUUID();
    const saved = await post('/activities/' + draft.id + '/settlement', invoiceCommand, {}, invoiceKey);
    const billed = consume('settlement_updated', 4, 3);
    for (const upload of billed.uploads) assert.equal(upload.body.file_data, image);
    assert.equal(billed.rows.filter(row => JSON.parse(row.payload_json)._settlement_image).length, 3);
    assert(billed.rows.every(row => JSON.parse(row.payload_json)._settlement_version === 1));
    assert.deepEqual(billed.rows.filter(row => JSON.parse(row.payload_json)._settlement_image).map(row => JSON.parse(row.payload_json)._settlement_image.kind).sort(), ['alipay', 'other', 'wechat']);
    await replay('/activities/' + draft.id + '/settlement', invoiceCommand, invoiceKey, saved);
    await transition('cancel', 'event_cancelled');
    const cancelledReminders = rows('SELECT id,status FROM bot_outbox WHERE event_id=? AND due_at IS NOT NULL ORDER BY id', draft.id);
    assert(cancelledReminders.length >= 2 && cancelledReminders.every(row => row.status === 'skipped'));
    assert(frozen.filter(row => row.due_at).every(row => cancelledReminders.some(current => current.id === row.id)));
    for (const action of ['archive', 'unarchive']) {
      const current = await read('/activities/' + draft.id + '/lifecycle');
      await post('/activities/' + draft.id + '/lifecycle', { revision: current.revision, action, reason: '', confirm: true });
      const drained = python(mode, draft.id); assert.deepEqual(drained.first, emptyPoll); assert.deepEqual(drained.second, emptyPoll); assert.equal(drained.calls.length, 0);
    }
    const pollPath = '/time-polls', pollInput = {
      title: '合成投票 ' + mode, category: '约K', location: '合成地點', description: '合成選項', timezone: 'Asia/Taipei', capacity: 8, minimum_participants: 0, fee_policy: '',
      deadline: '2099-12-11T10:00:00Z', time_mode: 'exact', duration_hours: 3, bot_enabled: true,
      options: [{ starts_at: '2099-12-12T18:00:00+08:00' }, { starts_at: '2099-12-13T18:00:00+08:00' }],
    }, pollKey = randomUUID();
    const poll = await post(pollPath, pollInput, {}, pollKey), pollWork = consume('time_poll_published');
    assert(pollWork.rows.every(row => row.poll_id === poll.id && row.event_id === null));
    await replay(pollPath, pollInput, pollKey, poll);
    const ballot = await read('/time-polls/' + poll.id), vote = { revision: ballot.revision, ballot_token: ballot.ballot_token, choices: ballot.options.map(option => ({ option_id: option.id, choice: 'yes' })) }, voteKey = randomUUID();
    const voted = await post(pollPath + '/' + poll.id + '/votes', vote, {}, voteKey);
    await replay(pollPath + '/' + poll.id + '/votes', vote, voteKey, voted);
    const afterVote = python(mode, draft.id); assert.deepEqual(afterVote.first, emptyPoll); assert.deepEqual(afterVote.second, emptyPoll); assert.equal(afterVote.calls.length, 0);
    for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
    results.push({ mode, eventId: draft.id, nativePublication: true, originalReceiptReplayed: true,
      aliases: data.queries.length, dispatch: data.dispatch, first: data.first, second: data.second, signup: signup.first, withdrawalAndPromotion: withdrawal.first,
      singleCombinedWithdrawalCard: true, privateNoticesNeverForwarded: true, actualTransportCalls: 0,
      publicationMockCalls: data.calls.length, originalFlowMockCalls: data.calls.length + signup.calls.length + withdrawal.calls.length,
      totalMockCalls: data.calls.length + signup.calls.length + withdrawal.calls.length + lifecycle.reduce((sum, row) => sum + row.first.sent, 0) + billed.result.calls.length + pollWork.result.calls.length,
      appliedPolicyRevision: data.revision, futureRemindersUnchanged: true,
      lifecycle, archiveUnarchiveNeverBroadcast: true, cancelledReminderWorkPreserved: true,
      settlement: { first: billed.result.first, second: billed.result.second, cards: 4, uploadedOriginalImages: mode === 'dry-run' ? 0 : 3, imageRows: 3, totalCents: 1003, originalReceiptReplayed: true },
      timePoll: { id: poll.id, first: pollWork.result.first, second: pollWork.result.second, originalReceiptReplayed: true, ballotNeverBroadcast: true },
    });
  }
  const simulatedPolicy = await read('/admin/bot');
  await post('/admin/bot', { command: 'save', revision: simulatedPolicy.revision, config: { ...simulatedPolicy.config, dry_run: false }, confirm: true }, admin);
  const noReplay = python('plain', results.at(-1).eventId); assert.equal(noReplay.first.claimed, 0); assert.equal(noReplay.calls.length, 0);
  for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
  const recovery = await exerciseRetainedPythonRecovery({ post, read, rows, python, collectLinks, admin });
  const handoff = await exerciseRetainedWorkerHandoff({ post, read, rows, python, native, collectLinks, admin });
  for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
  for (const url of linkChecks) {
    assert.equal(new URL(url).origin, origin);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) }), html = await response.text();
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60);
        rateLimitDeferrals++; rateLimitWaitSeconds += seconds;
        await new Promise(resolve => setTimeout(resolve, seconds * 1000)); continue;
      }
      assert.equal(response.status, 200, url); assert(html.includes('/assets/'), url); break;
    }
  }
  assert.equal(linkChecks.size, 314);
  const deepLinkRouteInventory = {};
  for (const link of linkChecks) { const url = new URL(link), route = url.pathname + '?' + [...url.searchParams.keys()].sort().join('&'); deepLinkRouteInventory[route] = (deepLinkRouteInventory[route] ?? 0) + 1; }
  return { webRuntime, cases: results, deepLinkShells: linkChecks.size, simulationNotReplayedInRealMode: true, deliveredRowsUnchangedAfterPolicyChanges: true,
    deepLinkRouteInventory, recovery, handoff, rateLimitDeferrals, rateLimitWaitSeconds, rateLimitsRespectedWithOriginalRequestKeys: true };
}
