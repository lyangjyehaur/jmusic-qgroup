import React, { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Accordion,
  Alert,
  Avatar,
  Dialog,
  Image,
  RadioGroup,
  SegmentedControl,
  Tabs,
  Toast,
} from "yahha-ui";
import type { DisclosureModel, LegacyProps } from "./legacy-types.ts";

// Explicit adapters keep the existing controllers' DOM references and events.
// The visible controls, state feedback and overlay are owned by Yahha UI.
export const viewUpdates = new WeakMap<
  HTMLElement,
  React.Dispatch<React.SetStateAction<React.ReactNode>>
>();
export const choicePattern =
  /(?:^|\s)(?:view-switch|room-mode|match-sort-row|sel-seg|tabs)(?:\s|$)/;
const active = (button: HTMLButtonElement) =>
  /(?:^|\s)(?:active|on)(?:\s|$)/.test(button.className) ||
  button.getAttribute("aria-pressed") === "true";

export function ChoiceRegion({
  props = {},
  children,
  model,
  renderMarkup,
}: {
  props?: LegacyProps;
  children?: React.ReactNode;
  model?: HTMLElement;
  renderMarkup: (html: string) => React.ReactNode;
}) {
  const holder = useRef<HTMLDivElement>(null),
    [options, setOptions] = useState<
      { value: string; label: React.ReactNode; disabled: boolean }[]
    >([]),
    [value, setValue] = useState("");
  const buttons = useRef<HTMLButtonElement[]>([]);
  useLayoutEffect(() => {
    const node = holder.current;
    if (!node) return;
    if (model) node.append(model);
    const sync = () => {
      buttons.current = [...node.querySelectorAll("button")];
      setOptions(
        buttons.current.map((button, index) => ({
          value: String(index),
          label: renderMarkup(button.innerHTML),
          disabled: button.disabled,
        })),
      );
      const selected = buttons.current.findIndex(active);
      setValue(selected < 0 ? "" : String(selected));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(node, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "aria-pressed", "disabled"],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <div {...props} className={`${props.className || ""} ui-choice`}>
      <div ref={holder} className="ui-choice-model" hidden>
        {children}
      </div>
      {options.length > 0 && (
        <SegmentedControl
          label={props["aria-label"] || "选项"}
          options={options}
          value={value}
          form="ui-presentation-controls"
          className="ui-segmented"
          classNames={{ options: "ui-segmented-options" }}
          onValueChange={(next) => buttons.current[Number(next)]?.click()}
        />
      )}
    </div>
  );
}

export function NavigationRegion({
  props,
  items,
}: {
  props: LegacyProps;
  items: (React.ComponentProps<typeof Tabs>["items"][number] & {
    active: boolean;
    props: LegacyProps;
  })[];
}) {
  const root = useRef<HTMLDivElement>(null),
    [value, setValue] = useState(
      items.find((item) => item.active)?.value || items[0].value,
    );
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const buttons = [...node.querySelectorAll<HTMLElement>("[role=tab]")];
    buttons.forEach((button, index) => {
      const original = items[index].props;
      for (const [key, val] of Object.entries(original))
        if (key.startsWith("data-") || key === "id" || key === "title")
          button.setAttribute(key, String(val));
      button.classList.add(
        ...(original.className || "").split(/\s+/).filter(Boolean),
      );
      const page = original["data-go"] || original["data-page"];
      const panel = page && document.getElementById(`page-${page}`);
      if (panel) {
        button.setAttribute("aria-controls", panel.id);
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", button.id);
      }
    });
    const observer = new MutationObserver(() => {
      const index = buttons.findIndex((button) =>
        button.classList.contains("active"),
      );
      if (index >= 0) setValue(items[index].value);
    });
    observer.observe(node, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <Tabs
      {...(props as Omit<React.ComponentProps<typeof Tabs>, "items">)}
      ref={root}
      label={props["aria-label"] || "页面"}
      items={items}
      value={value}
      onValueChange={(next) => setValue(next || "")}
      keepMounted
      appearance="ink"
      className={`${props.className || ""} ui-navigation`}
      classNames={{
        list: "ui-tab-list",
        tab: "tab ui-tab",
        panel: "ui-tab-placeholder",
      }}
    />
  );
}

export function DisclosureRegion({
  props,
  title,
  children,
}: {
  props: LegacyProps;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  const element = useRef<DisclosureModel>(null),
    [open, setOpen] = useState(!!props.open);
  const { open: initialOpen, ...attributes } = props;
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    node.toggleAttribute("open", !!initialOpen);
    Object.defineProperty(node, "open", {
      configurable: true,
      get: () => node.hasAttribute("open"),
      set: (value) => {
        const changed = node.hasAttribute("open") !== !!value;
        node.toggleAttribute("open", !!value);
        if (changed) node.dispatchEvent(new Event("toggle"));
      },
    });
    const sync = () => setOpen(!!node.open);
    const observer = new MutationObserver(sync);
    observer.observe(node, { attributes: true, attributeFilter: ["open"] });
    node
      .querySelector(".ui-disclosure-trigger")
      ?.setAttribute("data-ui-summary", "");
    return () => {
      observer.disconnect();
      delete node.open;
    };
  }, []);
  return (
    <div {...attributes} ref={element} data-ui-disclosure="">
      <Accordion
        keepMounted
        headingLevel={4}
        value={open ? ["content"] : []}
        items={[{ value: "content", title, content: children }]}
        onValueChange={(next) => {
          if (element.current) element.current.open = next.length > 0;
          setOpen(next.length > 0);
        }}
        className="ui-disclosure"
        classNames={{
          trigger: "ui-disclosure-trigger",
          panel: "ui-disclosure-panel",
        }}
      />
    </div>
  );
}

function ContentSlot({
  store,
  owner,
}: {
  store: React.RefObject<HTMLDivElement | null>;
  owner: React.RefObject<HTMLElement | null>;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = slot.current,
      content = store.current;
    if (!target || !content) return;
    target.append(content);
    return () => {
      if (content.parentNode === target) owner.current?.prepend(content);
    };
  }, []);
  return <div className="ui-dialog-slot" ref={slot} />;
}

// Only the top native dialog owns a Yahha modal. This matches the board's
// existing stacked-dialog history and avoids two independent focus traps.
const dialogStack: { node: HTMLElement; activate: (open: boolean) => void }[] =
  [];
export function DialogRegion({
  tag,
  props,
  children,
}: {
  tag: string;
  props: LegacyProps;
  children?: React.ReactNode;
}) {
  const owner = useRef<HTMLElement>(null),
    store = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(props["aria-label"] || "详情");
  const [closeLabel, setCloseLabel] = useState("关闭");
  useLayoutEffect(() => {
    const node = owner.current,
      content = store.current;
    if (!node || !content) return;
    const native = node instanceof HTMLDialogElement;
    const moveHome = () => {
      if (content.parentNode !== node) node.prepend(content);
    };
    const entry = {
      node,
      activate: (next: boolean) => {
        if (!next) moveHome();
        setOpen(next);
      },
    };
    const showView = () => {
      if (dialogStack.includes(entry)) return;
      dialogStack.at(-1)?.activate(false);
      dialogStack.push(entry);
      entry.activate(true);
    };
    const hideView = () => {
      const index = dialogStack.indexOf(entry);
      if (index < 0) return;
      const top = index === dialogStack.length - 1;
      dialogStack.splice(index, 1);
      entry.activate(false);
      if (top) dialogStack.at(-1)?.activate(true);
    };
    const sync = () => {
      const heading = store.current?.querySelector(
        ".dialog-heading h2, .modal-head h3, .modal-head h2, form > h2",
      );
      if (heading?.textContent) setTitle(heading.textContent);
      const close = store.current?.querySelector(
        ".dialog-heading [data-close], .modal-head button",
      );
      if (close?.getAttribute("aria-label"))
        setCloseLabel(close.getAttribute("aria-label") || "关闭");
      if (!native) {
        if (node.hidden) hideView();
        else showView();
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(node, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    const nativeClosed = () => hideView();
    if (native) {
      node.addEventListener("close", nativeClosed);
      const show = HTMLDialogElement.prototype.showModal,
        close = HTMLDialogElement.prototype.close;
      node.showModal = () => {
        show.call(node);
        flushSync(showView);
      };
      node.close = (...args: Parameters<HTMLDialogElement["close"]>) => {
        flushSync(hideView);
        close.apply(node, args);
      };
    }
    return () => {
      observer.disconnect();
      hideView();
      if (native) {
        node.removeEventListener("close", nativeClosed);
        Reflect.deleteProperty(node, "showModal");
        Reflect.deleteProperty(node, "close");
      }
    };
  }, []);
  const close = () => {
    if (owner.current instanceof HTMLDialogElement) {
      const event = new Event("cancel", { cancelable: true });
      if (owner.current.dispatchEvent(event)) owner.current.close();
    } else {
      const button =
        store.current?.querySelector<HTMLButtonElement>(".modal-head button");
      if (button) button.click();
      else if (owner.current) owner.current.hidden = true;
    }
  };
  return React.createElement(
    tag,
    { ...props, ref: owner, "data-ui-dialog-owner": "" },
    <div className="ui-dialog-store" ref={store}>
      {children}
    </div>,
    open && (
      <Dialog
        open={true}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={title}
        closeLabel={closeLabel}
        portalContainer={owner}
        className={`ui-dialog ${props.className?.includes("detail-dialog") ? "ui-detail-dialog" : ""}`}
      >
        <ContentSlot store={store} owner={owner} />
      </Dialog>
    ),
  );
}

export function FeedbackRegion({
  tag = "div",
  props,
  children,
  kind = "alert",
}: {
  tag?: string;
  props: LegacyProps;
  children?: React.ReactNode;
  kind?: "alert" | "toast";
}) {
  const ref = useRef<HTMLDivElement>(null),
    [content, setContent] = useState(children),
    [visible, setVisible] = useState(!props.hidden),
    [tone, setTone] = useState<"error" | "warning" | "info">(
      /error/.test(props.className || "")
        ? "error"
        : /draft-status|activity-alert/.test(props.className || "")
          ? "warning"
          : "info",
    );
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    viewUpdates.set(node, setContent);
    const observer = new MutationObserver(() => {
      setVisible(!node.hidden);
      setTone(
        /error/.test(node.className)
          ? "error"
          : /draft-status|activity-alert/.test(node.className)
            ? "warning"
            : "info",
      );
    });
    observer.observe(node, {
      attributes: true,
      attributeFilter: ["hidden", "class"],
    });
    return () => {
      observer.disconnect();
      viewUpdates.delete(node);
    };
  }, []);
  const hasContent = React.Children.toArray(content).some((child) =>
    typeof child === "string" ? child.trim() : !!child,
  );
  return React.createElement(
    tag === "p" ? "div" : tag,
    { ...props, role: undefined, ref, "data-ui-feedback": kind },
    kind === "toast" ? (
      <Toast
        open={visible && hasContent}
        title={content}
        tone="info"
        onClose={() => {
          if (ref.current) ref.current.hidden = true;
          setVisible(false);
        }}
      />
    ) : (
      hasContent && (
        <Alert
          tone={tone}
          role={props.role || (tone === "error" ? "alert" : "status")}
        >
          {content}
        </Alert>
      )
    ),
  );
}

export function AvatarRegion({ props }: { props: LegacyProps }) {
  const model = useRef<HTMLImageElement>(null),
    [snapshot, setSnapshot] = useState({
      hidden: props.hidden,
      src: props.src || null,
      name: props.alt || "头像",
    });
  useLayoutEffect(() => {
    const sync = () =>
      setSnapshot({
        hidden: model.current!.hidden,
        src: model.current!.getAttribute("src"),
        name: model.current!.alt || "头像",
      });
    const observer = new MutationObserver(sync);
    if (model.current) observer.observe(model.current, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return (
    <span className="ui-avatar-region" hidden={snapshot.hidden}>
      <img
        {...(props as React.ImgHTMLAttributes<HTMLImageElement>)}
        ref={model}
        className="ui-avatar-model"
        aria-hidden="true"
      />
      <Avatar
        name={snapshot.name}
        src={snapshot.src || undefined}
        size={props.className?.includes("small") ? "sm" : "md"}
      />
    </span>
  );
}

// Real RadioGroup inputs remain the form model; imperative batch voting and
// form.reset() synchronize the controlled presentation without extra fields.
export function RadioRegion({
  props,
  name,
  required,
  initialValue,
  label,
  options,
}: {
  props: LegacyProps;
  name?: string;
  required: boolean;
  initialValue: string;
  label: React.ReactNode;
  options: React.ComponentProps<typeof RadioGroup>["options"];
}) {
  const ref = useRef<HTMLFieldSetElement>(null),
    [value, setValue] = useState(initialValue);
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const inputs = [
      ...group.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ];
    const sync = () =>
      setValue(inputs.find((input) => input.checked)?.value || "");
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "checked",
    );
    if (!descriptor?.get || !descriptor.set) return;
    const { get, set } = descriptor;
    inputs.forEach((input) =>
      Object.defineProperty(input, "checked", {
        configurable: true,
        get: () => get.call(input),
        set: (next) => {
          set.call(input, next);
          queueMicrotask(sync);
        },
      }),
    );
    const reset = () => setValue(initialValue);
    const form = inputs[0]?.form;
    form?.addEventListener("reset", reset);
    return () => {
      inputs.forEach((input) => Reflect.deleteProperty(input, "checked"));
      form?.removeEventListener("reset", reset);
    };
  }, []);
  return (
    <RadioGroup
      {...(props as Omit<React.ComponentProps<typeof RadioGroup>, "options">)}
      ref={ref}
      name={name}
      required={required}
      label={label}
      options={options}
      value={value}
      onValueChange={setValue}
      highlightSelected
      className={`${props.className || ""} ui-radio`}
      classNames={{ options: "ui-radio-options" }}
    />
  );
}

// Receipt/QR retry handlers update the actual img.src. Mirror it into Image's
// source state so its loading/error fallback can recover as well.
export function ImageRegion({ props }: { props: LegacyProps }) {
  const image = useRef<HTMLImageElement>(null),
    [src, setSrc] = useState(props.src);
  useLayoutEffect(() => {
    const node = image.current;
    if (!node) return;
    const observer = new MutationObserver(() =>
      setSrc(node.getAttribute("src") || undefined),
    );
    observer.observe(node, { attributes: true, attributeFilter: ["src"] });
    return () => observer.disconnect();
  }, [src]);
  return (
    <Image
      {...(props as React.ComponentProps<typeof Image>)}
      ref={image}
      src={src}
      alt={props.alt || ""}
      className="ui-content-image"
      classNames={{ image: props.className }}
    />
  );
}
