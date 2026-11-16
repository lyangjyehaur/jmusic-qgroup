import type { BoardStore, LegacyDraft, ReactDraft } from "./types.ts";
type Recoverable =
  | ReactDraft<{
      _intent: string;
      id: string;
      _revision?: number;
      _lifecycle?: string;
    }>
  | LegacyDraft;
// Keep unsent edits, but never recreate an event after recovering an uncertain POST.
export async function markEventCreated(
  storage: BoardStore,
  scope: string,
  intent: string,
  event: { id: string; lifecycle: string },
) {
  for (const row of await storage.list<Recoverable>(`draft:${scope}:`)) {
    const next = structuredClone(row.data);
    if (next?.react && next.value?._intent === intent) {
      next.value = {
        ...next.value,
        id: event.id,
        _revision: -1,
        _lifecycle: event.lifecycle,
      };
      next.revision = -1;
    } else if (!next.react && next?.dataset?.intent === intent) {
      next.fields = next.fields.map((field) =>
        field.name === "id" ? { ...field, value: event.id } : field,
      );
      next.dataset = {
        ...next.dataset,
        revision: "-1",
        lifecycle: event.lifecycle,
      };
    } else continue;
    next.warning = "原活动已创建；请保留需要的文字，载入该活动最新版后再编辑";
    await storage.put(row.key, { data: next, at: Date.now() });
  }
}
