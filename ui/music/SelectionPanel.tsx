import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Badge,
  Button,
  ChevronDownIcon,
  CloseIcon,
  EmptyState,
  Heading,
  IconButton,
  SegmentedControl,
  Surface,
  Text,
} from "yahha-ui";
import type { MusicEntry, SelectionSnapshot } from "./selection-store.ts";
import {
  entryKind,
  LEVEL_LABELS,
  selectionCommands,
  selectionStore,
} from "./selection-store.ts";

const levelOptions = [4, 3, 2, 1].map((level) => ({
  value: String(level),
  label: LEVEL_LABELS[level],
}));
const useSelection = () =>
  useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
const countsOf = (snapshot: SelectionSnapshot) => {
  const selected = snapshot.entries.filter((entry) =>
    snapshot.ids.has(entry.id),
  );
  return {
    main: selected.filter((entry) => entryKind(entry) === "main").length,
    sub: selected.filter((entry) => entryKind(entry) !== "main").length,
  };
};
const summaryOf = (snapshot: SelectionSnapshot) => {
  const counts = countsOf(snapshot);
  return `领域 ${counts.main}/${snapshot.limits.main} · 细分 ${counts.sub}/${snapshot.limits.sub}`;
};
function SaveButton({
  id,
  snapshot,
}: {
  id: string;
  snapshot: SelectionSnapshot;
}) {
  return (
    <Button
      id={id}
      type="button"
      variant="primary"
      appearance="soft"
      loading={snapshot.saving}
      disabled={snapshot.saving || !snapshot.ids.size}
      onClick={() => selectionCommands.save?.()}
    >
      {snapshot.saving
        ? "保存中…"
        : !snapshot.dirty && snapshot.ids.size
          ? "查看同好 →"
          : "保存并匹配"}
    </Button>
  );
}

function SelectionRow({
  entry,
  snapshot,
}: {
  entry: MusicEntry;
  snapshot: SelectionSnapshot;
}) {
  const main = entryKind(entry) === "main";
  return (
    <div
      className={`music-selection-row${main ? " music-selection-main" : ""}`}
      data-id={entry.id}
    >
      <Text className="music-selection-name">{entry.text}</Text>
      <Text size="sm" tone="muted" className="music-selection-count">
        {entry.count || 0} 人
      </Text>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`移除${entry.text}`}
        title="移除这个词条"
        onClick={() => selectionCommands.remove?.(entry.id)}
      >
        <CloseIcon size={18} />
      </IconButton>
      {!main && (
        <SegmentedControl
          className="music-selection-level"
          label={`${entry.text}的熟悉程度`}
          classNames={{
            options: "music-selection-level-options",
            option: "music-selection-level-option",
          }}
          options={levelOptions}
          value={String(snapshot.levels[entry.id] || 3)}
          onValueChange={(value) =>
            selectionCommands.level?.(entry.id, Number(value))
          }
        />
      )}
    </div>
  );
}

export function SelectionPanel() {
  const snapshot = useSelection();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("jpm.selCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [category, setCategory] = useState("全部");
  const entriesById = new Map(
    snapshot.entries.map((entry) => [entry.id, entry]),
  );
  const chosen = snapshot.order
    .map((id) => entriesById.get(id))
    .filter((entry): entry is MusicEntry => !!entry);
  const main = chosen.filter((entry) => entryKind(entry) === "main");
  const sub = chosen.filter((entry) => entryKind(entry) !== "main");
  const categories = [
    ...new Set([
      ...snapshot.categories,
      ...sub.map((entry) => entry.category || "其他"),
    ]),
  ].filter((cat) => sub.some((entry) => (entry.category || "其他") === cat));
  const activeCategory = categories.includes(category) ? category : "全部";
  const toggle = () =>
    setCollapsed((previous) => {
      try {
        localStorage.setItem("jpm.selCollapsed", previous ? "0" : "1");
      } catch {}
      return !previous;
    });
  return (
    <Surface
      id="selectionCard"
      className="music-selection"
      hidden={!snapshot.available}
      role="region"
      aria-labelledby="selectionTitle"
      data-react-feature="music-selection"
    >
      <header className="music-selection-header">
        <Heading level={2} id="selectionTitle">
          你选的词条
        </Heading>
        <Text id="selCount" size="sm" tone="muted">
          {summaryOf(snapshot)}
        </Text>
        <IconButton
          id="selToggle"
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={!collapsed}
          aria-controls="selBody"
          aria-label={collapsed ? "展开已选词条" : "收起已选词条"}
          onClick={toggle}
        >
          <ChevronDownIcon
            size={18}
            style={{ transform: collapsed ? undefined : "rotate(180deg)" }}
          />
        </IconButton>
      </header>
      <div id="selBody" hidden={collapsed}>
        <div id="selChips" className="music-selection-groups">
          {(
            [
              ["领域", main, snapshot.limits.main],
              ["细分", sub, snapshot.limits.sub],
            ] as [string, MusicEntry[], number][]
          ).map(([title, list, limit]) => (
            <section
              key={title}
              className="music-selection-group"
              aria-label={`已选${title}`}
            >
              <div className="music-selection-group-heading">
                <Heading level={3}>{title}</Heading>
                <Badge>
                  {list.length} / {limit}
                </Badge>
              </div>
              {!list.length && (
                <Text size="sm" tone="muted">
                  还没选，去「发现」挑选喜欢的词条 →
                </Text>
              )}
              {title === "细分" && list.length > 0 && (
                <div
                  className="music-selection-categories"
                  role="group"
                  aria-label="细分类别"
                >
                  {["全部", ...categories].map((cat) => (
                    <Button
                      key={cat}
                      type="button"
                      size="sm"
                      variant={activeCategory === cat ? "primary" : "ghost"}
                      appearance={activeCategory === cat ? "soft" : "default"}
                      aria-pressed={activeCategory === cat}
                      onClick={() => setCategory(cat)}
                    >
                      {cat}{" "}
                      {cat === "全部"
                        ? sub.length
                        : sub.filter(
                            (entry) => (entry.category || "其他") === cat,
                          ).length}
                    </Button>
                  ))}
                </div>
              )}
              {title === "领域"
                ? list.map((entry) => (
                    <SelectionRow
                      key={entry.id}
                      entry={entry}
                      snapshot={snapshot}
                    />
                  ))
                : (activeCategory === "全部"
                    ? categories
                    : [activeCategory]
                  ).map((cat) => (
                    <div className="music-selection-category" key={cat}>
                      {activeCategory === "全部" && (
                        <Text size="sm" tone="muted">
                          {cat} ·{" "}
                          {
                            sub.filter(
                              (entry) => (entry.category || "其他") === cat,
                            ).length
                          }
                        </Text>
                      )}
                      {sub
                        .filter((entry) => (entry.category || "其他") === cat)
                        .map((entry) => (
                          <SelectionRow
                            key={entry.id}
                            entry={entry}
                            snapshot={snapshot}
                          />
                        ))}
                    </div>
                  ))}
            </section>
          ))}
        </div>
        {!snapshot.ids.size && (
          <EmptyState
            title="还没有选词条"
            description="先去「发现」挑选喜欢的领域、歌手或乐队。"
            action={
              <Button
                id="selGoBoard"
                type="button"
                variant="primary"
                appearance="soft"
                onClick={() => selectionCommands.discover?.()}
              >
                去发现音乐 →
              </Button>
            }
          />
        )}
        <div className="music-selection-actions">
          <SaveButton id="saveBtn" snapshot={snapshot} />
          <Button
            id="copySelBtn"
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => selectionCommands.copy?.()}
          >
            复制我的选择
          </Button>
        </div>
        <Text size="sm" tone="muted" className="music-selection-help">
          领域最多选 {snapshot.limits.main} 个、细分最多选 {snapshot.limits.sub}{" "}
          个。细分可调整熟悉程度，× 可移除。修改后记得保存。
        </Text>
      </div>
    </Surface>
  );
}

export function MusicTools() {
  const snapshot = useSelection(),
    dock = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false),
    [dockHeight, setDockHeight] = useState(0);
  useLayoutEffect(() => {
    const onScroll = () => setShowTop(window.scrollY >= 700);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle(
      "has-unsaved",
      snapshot.dockVisible,
    );
    const measure = () =>
      setDockHeight(dock.current?.getBoundingClientRect().height || 0);
    const observer = new ResizeObserver(measure);
    if (dock.current) observer.observe(dock.current);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.classList.remove("has-unsaved");
    };
  }, [snapshot.dockVisible]);
  return (
    <>
      <Surface
        id="mobBar"
        ref={dock}
        className="music-save-dock"
        hidden={!snapshot.dockVisible}
      >
        <div className="music-save-summary">
          <Text size="sm" role="status">
            有未保存的修改
          </Text>
          <Text size="sm" tone="muted" id="mobCount">
            {summaryOf(snapshot)}
          </Text>
        </div>
        <SaveButton id="mobSave" snapshot={snapshot} />
      </Surface>
      <IconButton
        id="toTop"
        className="music-scroll-top"
        type="button"
        variant="secondary"
        aria-label="回到顶部"
        hidden={!showTop}
        style={{
          bottom: `calc(var(--music-tools-bottom) + ${snapshot.dockVisible ? dockHeight + 16 : 0}px)`,
        }}
        onClick={() =>
          window.scrollTo({
            top: 0,
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "auto"
              : "smooth",
          })
        }
      >
        <span aria-hidden="true">↑</span>
      </IconButton>
    </>
  );
}
