import { uiText } from './language';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { MusicCatalog, MyMusicEntries, MusicEntryCommand } from '@qgroup/contracts';
import { musicEntryKey } from '@qgroup/domain';
import { z } from 'zod';
import { createWebHttpClient, scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { useReviewedDraft } from './reviewed-draft';
import { DraftFeedback } from './activity-settlement';
import { Field } from './settlement-controls';
type Mine = z.infer<typeof MyMusicEntries>;
type Command = z.infer<typeof MusicEntryCommand>['command'];
const endpoint = '/me/music/entries',
  path = (id: string) => endpoint + '/' + encodeURIComponent(id);
export const categoryLabel = (value: string) =>
  ({ 领域: uiText("領域"), 乐队: uiText("樂隊"), 组合: uiText("組合"), 社团: uiText("社團"), 企划: uiText("企劃") })[value] ?? value;
export function MyMusicEntriesPage() {
  return (
    <>
      <PageIntro title="我的詞條" />
      <div className="page-actions">
        <Link to="/music">音樂詞庫</Link>
        <Link to="/me/music">我的成分</Link>
        <Link to={endpoint + '/new'}>建立詞條</Link>
      </div>
      <MemberAccess>
        {(viewer) => <MineLoader key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}
      </MemberAccess>
    </>
  );
}
function MineLoader({ viewer }: { viewer: Member }) {
  const query = useQuery({
    queryKey: ['private', viewer.scope, 'music-entries', viewer.musicEpoch],
    queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/entries', {}),
  });
  return query.isPending ? (
    <Notice>正在讀取我的詞條…</Notice>
  ) : query.error ? (
    <Failure error={query.error} retry={() => void query.refetch()} />
  ) : (
    <Surface className="detail">
      <Text>
        已建立：領域 {query.data.createdCounts.main}／2，細分 {query.data.createdCounts.sub}／8
      </Text>
      {query.data.entries.length ? (
        <ul className="account-list">
          {query.data.entries.map((entry) => (
            <li key={entry.id}>
              <div>
                <Heading level={2}>{entry.name}</Heading>
                <Text>
                  {entry.kind === 'main' ? '領域' : '細分'} · {categoryLabel(entry.category)} · {entry.count}{' '}
                  人選用
                </Text>
                {entry.aliases.length > 0 && <Text>別名：{entry.aliases.join('、')}</Text>}
              </div>
              <div className="page-actions">
                <Link to={path(entry.id) + '/edit'}>編輯 {entry.name}</Link>
                <Link to={path(entry.id) + '/delete'}>刪除 {entry.name}</Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>尚未建立詞條。</Notice>
      )}
    </Surface>
  );
}
export function MusicEntryEditorPage({ command }: { command: Command }) {
  const { id = '' } = useParams();
  return (
    <>
      <PageIntro title={command === 'create' ? '建立詞條' : command === 'delete' ? '刪除詞條' : '編輯詞條'} />
      <div className="page-actions">
        <Link to={endpoint}>我的詞條</Link>
        <Link to="/music">音樂詞庫</Link>
        <Link to="/me/music">我的成分</Link>
      </div>
      <MemberAccess>
        {(viewer) => (
          <EditorLoader
            key={viewer.scope + ':' + viewer.musicEpoch + ':' + command + ':' + id}
            viewer={viewer}
            command={command}
            id={id}
          />
        )}
      </MemberAccess>
    </>
  );
}
function EditorLoader({ viewer, command, id }: { viewer: Member; command: Command; id: string }) {
  const mine = useQuery({
      queryKey: ['private', viewer.scope, 'music-entries', viewer.musicEpoch],
      queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/entries', {}),
      refetchOnWindowFocus: false,
    }),
    catalog = useQuery({ queryKey: ['music-catalog'], queryFn: () => createWebHttpClient().requestContract('GET /api/v2/music/catalog', {}) });
  if (mine.isPending || catalog.isPending) return <Notice>正在讀取詞條…</Notice>;
  if (mine.error || catalog.error)
    return (
      <Failure
        error={(mine.error ?? catalog.error)!}
        retry={() => {
          void mine.refetch();
          void catalog.refetch();
        }}
      />
    );
  return <EntryEditor viewer={viewer} command={command} id={id} initial={mine.data} catalog={catalog.data} />;
}
const Editable = z
  .object({
    command: z.enum(['create', 'update', 'delete']),
    profileId: z.string().nullable(),
    musicEpoch: z.number().int().nonnegative(),
    id: z.string(),
    revision: z.string(),
    name: z.string(),
    kind: z.enum(['main', 'sub']),
    category: z.string(),
  })
  .strict();
type Value = z.infer<typeof Editable>;
function inputFor(value: Value) {
  const { command, profileId, musicEpoch, id, revision, name, kind, category } = value;
  return MusicEntryCommand.parse(
    command === 'create'
      ? { command, profileId, musicEpoch, name, kind, category, confirm: true }
      : command === 'delete'
        ? { command, profileId, musicEpoch, id, revision, confirm: true }
        : { command, profileId, musicEpoch, id, revision, name, kind, category, confirm: true },
  );
}
function EntryEditor({
  viewer,
  command,
  id,
  initial,
  catalog,
}: {
  viewer: Member;
  command: Command;
  id: string;
  initial: Mine;
  catalog: z.infer<typeof MusicCatalog>;
}) {
  const blank = (fresh: Mine): Value => {
    const entry = fresh.entries.find((e) => e.id === id);
    return {
      command,
      profileId: fresh.profileId,
      musicEpoch: fresh.musicEpoch,
      id,
      revision: entry?.revision ?? '',
      name: entry?.name ?? '',
      kind: entry?.kind ?? 'sub',
      category: entry?.category ?? '其他',
    };
  };
  const client = useQueryClient(),
    [confirmed, setConfirmed] = useState(false),
    form = useReviewedDraft({
      key:
        'qgroup:rebuild:music:entries:v1:' +
        viewer.scope +
        ':' +
        (command === 'create' ? 'new' : id + ':' + command),
      viewer,
      initial,
      blank,
      valueSchema: Editable,
      saveSchema: MusicEntryCommand,
      send: (input, requestId) => authHttp(viewer).requestContract('POST /api/v2/me/music/entries', { body: input, requestId, requestScope: viewer.scope }),
      latest: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/entries', {}),
      fromPending: ({ confirm, ...input }) => ({
        ...blank(initial),
        ...input,
        command: input.command,
        ...(input.command === 'create'
          ? { id: '', revision: '' }
          : { id: input.id, revision: input.revision }),
      }),
      matches: (value, input) => {
        try {
          return (
            value.command === command &&
            value.id === id &&
            JSON.stringify(inputFor(value)) === JSON.stringify(input)
          );
        } catch {
          return false;
        }
      },
      after: (fresh) => {
        setConfirmed(false);
        client.setQueryData(['private', viewer.scope, 'music-entries', viewer.musicEpoch], fresh);
        void client.invalidateQueries({ queryKey: ['catalog'] });
        void client.invalidateQueries({ queryKey: ['music-catalog'] });
        void client.invalidateQueries({ queryKey: ['music-trend'] });
        void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-circles'] });
        void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-trend-members'] });
        void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] });
      },
    }),
    value = form.draft.value,
    entry = form.data.entries.find((e) => e.id === id),
    stale =
      value.profileId !== form.data.profileId ||
      value.musicEpoch !== form.data.musicEpoch ||
      (command !== 'create' && value.revision !== entry?.revision);
  const duplicate =
    command !== 'delete' &&
    catalog.entries.find(
      (e) =>
        e.id !== id &&
        [e.name, ...e.aliases].some((name) => musicEntryKey(name) === musicEntryKey(value.name)),
    );
  const editable = command === 'create' || !!entry,
    blocked = command === 'delete' && !!entry?.count;
  const edit = (patch: Partial<Value>) => {
    form.edit({ ...value, ...patch });
    setConfirmed(false);
  };
  return (
    <Surface className="detail">
      <Text>
        已建立：領域 {form.data.createdCounts.main}／2，細分 {form.data.createdCounts.sub}／8
      </Text>
      {command !== 'create' && entry && <Heading level={2}>{entry.name}</Heading>}
      {!editable && <Notice>詞條不存在、已刪除或不再由目前成分建立。</Notice>}
      {command === 'create' && !form.data.profileId && (
        <Notice>建立詞條會同時建立空白成分；不會自動選取詞條。</Notice>
      )}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (confirmed && !stale && editable && !blocked) {
            try {
              void form.submit(inputFor(value));
            } catch {
              form.setMessage(uiText("請填寫詞條名稱、類型與分類，並重新核對。"));
            }
          }
        }}
      >
        <fieldset disabled={form.locked || !editable}>
          <legend>{command === 'delete' ? '刪除確認' : '詞條資料'}</legend>
          {command === 'delete' ? (
            <Notice>
              {blocked
                ? '已有 ' + entry!.count + ' 人選用，不能刪除。'
                : '刪除後不能還原；如果已有人選用，系統會阻止刪除。'}
            </Notice>
          ) : (
            <>
              <Field label="詞條名稱（最多 24 字）">
                <input value={value.name} onChange={(e) => edit({ name: e.target.value })} />
              </Field>
              <Field label="詞條類型">
                <select value={value.kind} onChange={(e) => edit({ kind: e.target.value as 'main' | 'sub' })}>
                  <option value="main">領域</option>
                  <option value="sub">細分</option>
                </select>
              </Field>
              {value.kind === 'sub' && (
                <Field label="詞條分類">
                  <select value={value.category} onChange={(e) => edit({ category: e.target.value })}>
                    {form.data.categories.map((category) => (
                      <option key={category} value={category}>
                        {categoryLabel(category)}
                      </option>
                    ))}
                    {!form.data.categories.includes(value.category) && (
                      <option value={value.category}>{categoryLabel(value.category)}</option>
                    )}
                  </select>
                </Field>
              )}
              {command === 'update' && (
                <Notice>改名或改類型會影響所有選用者的顯示；既有選擇與熟悉度保留。</Notice>
              )}
              {duplicate && (
                <Notice>
                  已有「{duplicate.name}」，可
                  <Link to={'/music?entry=' + encodeURIComponent(duplicate.id)}>查看既有詞條</Link>。
                </Notice>
              )}
            </>
          )}
          <label className="consent">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={blocked}
            />
            <span>{command === 'delete' ? '確認刪除此詞條。' : '已核對名稱、類型與分類，確認保存。'}</span>
          </label>
        </fieldset>
        {stale && <Notice>原稿與目前詞條或成分不符，請核對最新版本。</Notice>}
        <Button
          type="submit"
          loading={form.busy}
          disabled={
            !!form.readError || (!form.draft.pending && (!confirmed || stale || !editable || blocked))
          }
        >
          {form.draft.pending
            ? '確認原詞條操作結果'
            : command === 'delete'
              ? '刪除詞條'
              : command === 'create'
                ? '建立詞條'
                : '保存詞條'}
        </Button>
      </form>
      <Button
        variant="secondary"
        disabled={form.locked}
        onClick={() => {
          setConfirmed(false);
          void client.invalidateQueries({ queryKey: ['music-catalog'] });
          void form.refresh((old, fresh) => {
            const current = fresh.entries.find((e) => e.id === id);
            return {
              ...old,
              profileId: fresh.profileId,
              musicEpoch: fresh.musicEpoch,
              revision: current?.revision ?? '',
            };
          });
        }}
      >
        核對最新詞條，保留輸入
      </Button>
      <DraftFeedback form={form} />
    </Surface>
  );
}
