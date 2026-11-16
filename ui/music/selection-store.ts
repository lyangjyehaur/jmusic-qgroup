export interface MusicEntry {
  id: string;
  text: string;
  category?: string;
  kind?: "main" | "sub";
  count?: number;
}
export interface SelectionSnapshot {
  ids: Set<string>;
  levels: Record<string, number>;
  order: string[];
  entries: MusicEntry[];
  categories: string[];
  limits: { main: number; sub: number };
  dirty: boolean;
  saving: boolean;
  revision: number;
  available: boolean;
  dockVisible: boolean;
}
export interface SelectionCommands {
  save?: () => unknown;
  remove?: (id: string) => void;
  level?: (id: string, level: number) => void;
  discover?: () => void;
  copy?: () => unknown;
}
// Canonical selection data shared by React and the pages still being migrated.
// Consumers exchange data and actions; this module has no DOM dependencies.
export const entryKind = (entry?: MusicEntry) =>
  entry?.kind || (entry?.category === "领域" ? "main" : "sub");
export const LEVEL_LABELS: Record<number, string> = {
  4: "本命",
  3: "常听",
  2: "听过一些",
  1: "只听过几首",
};

export function createSelectionStore() {
  let snapshot: SelectionSnapshot = {
    ids: new Set(),
    levels: {},
    order: [],
    entries: [],
    categories: [],
    limits: { main: 5, sub: 15 },
    dirty: false,
    saving: false,
    revision: 0,
    available: false,
    dockVisible: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<SelectionSnapshot>) => {
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(snapshot[key as keyof SelectionSnapshot], value),
      )
    )
      return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const sortedIds = (
    ids: Set<string>,
    levels: Record<string, number>,
    entries: MusicEntry[],
  ) =>
    [...ids].sort((a, b) => {
      const x = entries.find((entry) => entry.id === a),
        y = entries.find((entry) => entry.id === b);
      return (
        (levels[b] || 3) - (levels[a] || 3) ||
        (y?.count || 0) - (x?.count || 0) ||
        (x?.text || a).localeCompare(y?.text || b, "zh")
      );
    });
  const edit = (patch: Partial<SelectionSnapshot>) =>
    publish({ ...patch, dirty: true, revision: snapshot.revision + 1 });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure: (context: Partial<SelectionSnapshot>) => publish(context),
    level: (id: string) => snapshot.levels[id] || 3,
    reset(selection: (string | { id: string; level?: number })[] = []) {
      const ids = new Set<string>(),
        levels: Record<string, number> = {};
      selection.forEach((item) => {
        const id = typeof item === "string" ? item : item.id;
        if (!id) return;
        ids.add(id);
        levels[id] = typeof item === "object" && item.level ? item.level : 3;
      });
      publish({
        ids,
        levels,
        order: sortedIds(ids, levels, snapshot.entries),
        dirty: false,
        revision: snapshot.revision + 1,
      });
    },
    select(id: string, level = 3) {
      const ids = new Set(snapshot.ids);
      ids.add(id);
      edit({
        ids,
        levels: { ...snapshot.levels, [id]: level },
        order: snapshot.ids.has(id) ? snapshot.order : [...snapshot.order, id],
      });
    },
    remove(id: string) {
      if (!snapshot.ids.has(id)) return;
      const ids = new Set(snapshot.ids),
        levels = { ...snapshot.levels };
      ids.delete(id);
      delete levels[id];
      edit({
        ids,
        levels,
        order: snapshot.order.filter((value) => value !== id),
      });
    },
    markDirty: () => edit({}),
    startSaving() {
      publish({ saving: true });
      return snapshot.revision;
    },
    acknowledgeSave(revision: number) {
      // A request only acknowledges the draft it actually sent. Edits made
      // while that request was in flight must remain dirty and saveable.
      if (revision !== snapshot.revision) return false;
      publish({
        dirty: false,
        order: sortedIds(snapshot.ids, snapshot.levels, snapshot.entries),
      });
      return true;
    },
    finishSaving: () => publish({ saving: false }),
  };
}

export const selectionStore = createSelectionStore();
// Temporary service boundary to the existing API/router, without DOM models.
export const selectionCommands: SelectionCommands = {};
