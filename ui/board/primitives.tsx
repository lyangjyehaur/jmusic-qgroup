import type {
  Dispatch,
  InputHTMLAttributes,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Accordion,
  Alert,
  Button,
  Checkbox,
  Input,
  Select,
  Switch,
  Text,
  Textarea,
} from "yahha-ui";
import { errorMessage } from "../errors.ts";
import type {
  BoardContextValue,
  DraftState,
  LegacyDraft,
  LegacyField,
  ModalContextValue,
  ReactDraft,
} from "./types.ts";
export interface FormController<T> {
  values: T;
  busy: boolean;
  error: string;
  revision: RefObject<number>;
  set<K extends keyof T>(name: K, value: T[K]): void;
  patch(next: Partial<T> | ((previous: T) => Partial<T>)): void;
  replace: Dispatch<SetStateAction<T>>;
  setError: Dispatch<SetStateAction<string>>;
  run<R>(task: () => R | Promise<R>): Promise<R | null | undefined>;
}
type KeysOfType<T, V> = Extract<
  { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T],
  string
>;
type FieldController<T> = Pick<FormController<T>, "values" | "set" | "busy">;
export const BoardContext = createContext<BoardContextValue | null>(null);
export const ModalContext = createContext<ModalContextValue | null>(null);
export const useBoard = () => {
  const value = useContext(BoardContext);
  if (!value) throw new Error("Board context missing");
  return value;
};
export const useModal = () => {
  const value = useContext(ModalContext);
  if (!value) throw new Error("Modal context missing");
  return value;
};
export const clone = <T,>(value: T): T => structuredClone(value);
export const uid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
export function useForm<T extends object>(
  initial: T | (() => T),
): FormController<T> {
  const [values, setValues] = useState(() =>
    typeof initial === "function" ? initial() : initial,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    revision = useRef(0);
  const patch = useCallback(
    (next: Partial<T> | ((previous: T) => Partial<T>)) => {
      revision.current++;
      setValues((previous) => ({
        ...previous,
        ...(typeof next === "function" ? next(previous) : next),
      }));
    },
    [],
  );
  const set = useCallback(
    <K extends keyof T>(name: K, value: T[K]) =>
      patch((previous) => ({ ...previous, [name]: value })),
    [patch],
  );
  const run = async <R,>(task: () => R | Promise<R>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      return await task();
    } catch (problem) {
      setError(errorMessage(problem));
      return null;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return {
    values,
    set,
    patch,
    replace: setValues,
    busy,
    error,
    setError,
    run,
    revision,
  };
}
export function Field<T extends object>({
  form,
  name,
  label,
  help,
  options,
  multiline,
  children,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "form" | "name" | "size" | "onChange" | "onBlur" | "onFocus"
> & {
  form: FieldController<T>;
  name: KeysOfType<T, string | undefined>;
  label: ReactNode;
  help?: ReactNode;
  options?: readonly (
    string | { value: string; label: ReactNode; disabled?: boolean }
  )[];
  multiline?: boolean;
  children?: ReactNode;
  rows?: number;
}) {
  const value = form.values[name] ?? "";
  const common = {
    ...props,
    name,
    label,
    className: "board-field",
    value: value as string | number,
    disabled: props.disabled || form.busy,
  };
  const control = options ? (
    <Select
      {...(common as Omit<React.ComponentProps<typeof Select>, "options">)}
      options={options.map((option) =>
        typeof option === "string" ? { value: option, label: option } : option,
      )}
      onValueChange={(value) => form.set(name, (value ?? "") as T[typeof name])}
    />
  ) : multiline ? (
    <Textarea
      {...(common as React.ComponentProps<typeof Textarea>)}
      onChange={(event) => form.set(name, event.target.value as T[typeof name])}
    />
  ) : (
    <Input
      {...common}
      onChange={(event) => form.set(name, event.target.value as T[typeof name])}
    />
  );
  return (
    <div className="board-field-row" hidden={props.hidden}>
      {control}
      {help && (
        <Text size="sm" tone="muted" className="field-help">
          {help}
        </Text>
      )}
      {children}
    </div>
  );
}
export function Check<T extends object>({
  form,
  name,
  label,
  switchControl = false,
  ...props
}: Omit<React.ComponentProps<typeof Checkbox>, "form" | "name"> & {
  form: FieldController<T>;
  name: KeysOfType<T, boolean | undefined>;
  switchControl?: boolean;
}) {
  const Component = switchControl ? Switch : Checkbox;
  return (
    <Component
      {...props}
      name={name}
      label={label}
      checked={!!form.values[name]}
      disabled={props.disabled || form.busy}
      onChange={(event) =>
        form.set(name, event.target.checked as T[typeof name])
      }
      className="board-check"
    />
  );
}
export function Form({
  form,
  id,
  children,
  onSubmit,
  footer,
  draft,
}: {
  form: Pick<FormController<object>, "busy" | "error" | "setError">;
  id?: string;
  children?: ReactNode;
  onSubmit?: (intent?: string) => unknown;
  footer?: ReactNode;
  draft?: DraftState;
}) {
  const modal = useContext(ModalContext);
  useEffect(() => {
    if (modal)
      modal.register({
        busy: form.busy,
        dirty: draft?.dirty,
        save: draft?.save,
        discard: draft?.discard,
        choice: !!draft?.choice,
      });
  });
  return (
    <form
      id={id}
      className="board-form"
      inert={form.busy || undefined}
      onInvalidCapture={(event) => {
        const field = event.target as HTMLElement;
        setTimeout(() => {
          field.focus();
          field.scrollIntoView({ block: "nearest" });
        }, 0);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft && !draft.ready()) {
          form.setError(draft.warning || "请先恢复或舍弃已有的本机草稿");
          return;
        }
        onSubmit?.(
          (
            (event.nativeEvent as SubmitEvent)
              .submitter as HTMLButtonElement | null
          )?.value,
        );
      }}
    >
      {draft && <DraftStatus draft={draft} />}
      <div className="form-body">{children}</div>
      <div className="form-footer">
        <ErrorMessage error={form.error} />
        {footer}
      </div>
    </form>
  );
}
export function ErrorMessage({ error, id }: { error?: string; id?: string }) {
  return error ? (
    <Alert id={id} tone="error" className="form-error">
      {error}
    </Alert>
  ) : null;
}
export function Fold({
  title,
  children,
  defaultOpen = false,
  id,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen ? ["content"] : []);
  return (
    <Accordion
      id={id}
      className="board-fold"
      keepMounted
      value={open}
      onValueChange={setOpen}
      onInvalidCapture={() => setOpen(["content"])}
      items={[{ value: "content", title, content: children }]}
    />
  );
}
export function Advanced({
  onChange,
  children,
  defaultOpen = false,
}: {
  onChange?: (open: boolean) => void;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <Switch
        label="高级选项"
        checked={open}
        onChange={(event) => {
          setOpen(event.target.checked);
          onChange?.(event.target.checked);
        }}
        className="board-check"
        data-advanced-toggle
      />
      <div
        hidden={!open}
        data-advanced-only
        onInvalidCapture={() => setOpen(true)}
      >
        {children}
      </div>
    </>
  );
}
export function useDraft<T>(
  key: string,
  data: T,
  restore: (value: NoInfer<T>) => void,
  {
    revision,
    decode,
  }: { revision?: number; decode?: (data: LegacyDraft) => T } = {},
): DraftState {
  const app = useBoard();
  const storageKey = `draft:${app.me.draft_scope}:${key}`;
  const baseline = useRef(JSON.stringify(data)),
    current = useRef(data),
    loaded = useRef(false),
    queue = useRef<Promise<unknown>>(Promise.resolve());
  current.current = data;
  const [choice, setChoice] = useState<ReactDraft<T> | LegacyDraft | null>(
      null,
    ),
    [status, setStatus] = useState(""),
    [warning, setWarning] = useState(""),
    [storageError, setStorageError] = useState("");
  const dirty = JSON.stringify(data) !== baseline.current;
  const load = async () => {
    const row = await app.storage.get<ReactDraft<T> | LegacyDraft>(storageKey);
    setChoice(row?.data || null);
    loaded.current = true;
    setStorageError("");
  };
  useEffect(() => {
    let active = true;
    app.storage
      .get<ReactDraft<T> | LegacyDraft>(storageKey)
      .then((row) => {
        if (active) {
          setChoice(row?.data || null);
          loaded.current = true;
        }
      })
      .catch((error) => {
        if (active) setStorageError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [storageKey]);
  const save = useCallback(async () => {
    if (!loaded.current || choice)
      throw new Error("请先恢复或舍弃已有的本机草稿");
    const capture = clone(current.current);
    if (JSON.stringify(capture) === baseline.current) return;
    const work = () =>
      app.storage.put(storageKey, {
        data: { react: 1, value: capture, revision },
        at: Date.now(),
      });
    queue.current = queue.current.catch(() => {}).then(work);
    await queue.current;
    setStorageError("");
    setStatus("已暂存到本机，尚未发布");
  }, [storageKey, choice, revision]);
  useEffect(() => {
    if (!dirty || choice || !loaded.current) return;
    const timer = setTimeout(
      () => save().catch((error) => setStorageError(errorMessage(error))),
      350,
    );
    return () => clearTimeout(timer);
  }, [data, choice, dirty, save]);
  const discard = async () => {
    await queue.current.catch(() => {});
    await app.storage.remove(storageKey);
    setChoice(null);
    setWarning("");
    setStorageError("");
    loaded.current = true;
    baseline.current = JSON.stringify(current.current);
    setStatus("旧草稿已舍弃");
  };
  const clear = async () => {
    await queue.current.catch(() => {});
    baseline.current = JSON.stringify(current.current);
    await app.storage.remove(storageKey);
    setChoice(null);
  };
  return {
    dirty,
    choice,
    status,
    warning: warning || storageError,
    storageError,
    retry: () =>
      (loaded.current ? save() : load()).catch((error) =>
        setStorageError(errorMessage(error)),
      ),
    save,
    discard,
    clear,
    ready: () => !!loaded.current && !choice && !warning && !storageError,
    restore: () => {
      if (!choice) return;
      const value = choice.react ? choice.value : decode?.(choice);
      if (!value) {
        setWarning("此草稿来自旧版，请保留需要的内容后舍弃草稿并重新填写");
        return;
      }
      restore(clone(value));
      setChoice(null);
      if (choice.warning) setWarning(choice.warning);
      else if (
        revision != null &&
        (choice.revision ?? choice.dataset?.revision) != null &&
        Number(revision) !== Number(choice.revision ?? choice.dataset?.revision)
      )
        setWarning("草稿基于旧版数据，请保留需要的文字并载入最新版后重新核对");
      setStatus("已恢复本机草稿，请核对后重新预览／发布");
    },
  };
}
function DraftStatus({ draft }: { draft: DraftState }) {
  return (
    <div className="draft-status" aria-live="polite">
      {draft.choice ? (
        <>
          <Text size="sm">此表单有本机草稿。</Text>
          <Button size="sm" variant="ghost" onClick={draft.restore}>
            恢复
          </Button>
          <Button size="sm" variant="ghost" onClick={draft.discard}>
            舍弃草稿
          </Button>
        </>
      ) : draft.warning ? (
        <Alert tone="warning">
          {draft.warning}
          {!!draft.storageError && (
            <Button size="sm" variant="ghost" onClick={draft.retry}>
              重试本机草稿存储
            </Button>
          )}
        </Alert>
      ) : (
        !!draft.status && (
          <Text size="sm" tone="muted">
            {draft.status}
          </Text>
        )
      )}
    </div>
  );
}
export const optionsFrom = (
  items?: readonly {
    id: string;
    label?: string;
    nickname?: string;
    name?: string;
  }[],
) =>
  (items || []).map((item) => ({
    value: item.id,
    label: item.label || item.nickname || item.name || item.id,
  }));
export const fieldValues = (fields?: LegacyField[]) =>
  Object.fromEntries(
    (fields || []).map((item) => [
      item.name,
      item.checked !== undefined &&
      [
        "include_self",
        "capacity_unlimited",
        "bot_enabled",
        "reviewed_roster",
        "room_mode",
        "group_notice",
        "convert_legacy",
        "exact_time",
      ].includes(item.name)
        ? item.checked
        : item.value,
    ]),
  );
