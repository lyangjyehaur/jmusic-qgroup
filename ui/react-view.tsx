import type { DOMNode, HTMLReactParserOptions } from "html-react-parser";
import parse, {
  Element as MarkupElement,
  Text as MarkupText,
  attributesToProps,
  domToReact as renderDOM,
} from "html-react-parser";
import React, { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  CloseIcon,
  Divider,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  Select,
  Spinner,
  Surface,
  Switch,
  Text,
  Textarea,
  ThemeProvider,
} from "yahha-ui";
import type { LegacyProps, SelectModel } from "./legacy-types.ts";
import {
  AvatarRegion,
  ChoiceRegion,
  DialogRegion,
  DisclosureRegion,
  FeedbackRegion,
  ImageRegion,
  NavigationRegion,
  RadioRegion,
  choicePattern,
  viewUpdates,
} from "./patterns.tsx";

// The data/API controllers retain their native form refs during the migration.
// React owns each view boundary and renders real Yahha components. Explicit
// boundaries avoid a DOM-wide MutationObserver and never rewrite user content.
const roots = new Map<Element, Root>();
let features: Record<string, React.ComponentType> = {};
const controls = new WeakMap<Element, { host: HTMLElement; root: Root }>();
const badges =
  /(?:^|\s)(?:category-label|count-badge|admin-user-role|cat-tag|mini-tag|sim-badge|lv-badge|lv-mini|event-badge|gender-tag|niche-badge|kind-tag|me-badge|attendance-badge|room-person-badge)(?:\s|$)/;
const removals = new WeakMap<Element, () => void>();

// Nested rows can be removed independently of their enclosing view root.
// Let React remove its own node so reopening the form can unmount cleanly.
function OwnedNode({
  tag,
  props,
  children,
}: {
  tag: string | typeof Surface;
  props: LegacyProps & { variant?: "note" | "paper" };
  children?: React.ReactNode;
}) {
  const [removed, setRemoved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    removals.set(element, () => flushSync(() => setRemoved(true)));
    return () => {
      removals.delete(element);
    };
  }, [removed]);
  if (removed) return null;
  return React.createElement(tag, { ...props, ref }, children);
}
const nativeClass = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "className",
);
const ghost =
  /(?:^|\s)(?:link|text-button|icon-button|icon-btn|refresh-button|profile-button|notification-button|home-qq-button)(?:\s|$)/;
const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((o) => ({
    value: o.value,
    label: o.textContent || "",
    disabled: o.disabled,
  }));

function SelectField({
  children,
  label,
  className,
  value,
  defaultValue,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: React.ReactNode;
}) {
  const model = useRef<SelectModel>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [snapshot, setSnapshot] = useState<{
    options: ReturnType<typeof optionsOf>;
    value: string;
    disabled: boolean;
    hidden: boolean;
    required: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const select = model.current;
    if (!select) return;
    const sync = () =>
      setSnapshot({
        options: optionsOf(select),
        value: select.value,
        disabled: select.disabled,
        hidden: select.hidden,
        required: select.required,
      });
    select.__uiSync = sync;
    // The model is a real select: FormData, reset(), options, disabled fields,
    // existing validation and server payloads retain their native semantics.
    const desc = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    );
    if (!desc?.get || !desc.set) return;
    const { get, set } = desc;
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => get.call(select),
      set: (v) => {
        set.call(select, v);
        sync();
      },
    });
    const observer = new MutationObserver(sync);
    observer.observe(select, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    select.addEventListener("change", sync);
    const reset = () => queueMicrotask(sync);
    const form = select.form;
    form?.addEventListener("reset", reset);
    sync();
    return () => {
      observer.disconnect();
      select.removeEventListener("change", sync);
      form?.removeEventListener("reset", reset);
      Reflect.deleteProperty(select, "value");
      delete select.__uiSync;
    };
  }, []);
  const { id, name, required, disabled, hidden, ...visibleProps } = props;
  const triggerProps = Object.fromEntries(
    Object.entries(visibleProps).filter(([key]) => !key.startsWith("data-")),
  );
  return (
    <span className="ui-select" hidden={snapshot?.hidden ?? hidden}>
      <select
        {...props}
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        hidden={hidden}
        className={[className, "ui-select-model"].filter(Boolean).join(" ")}
        ref={model}
        aria-hidden="true"
        tabIndex={-1}
        defaultValue={defaultValue ?? value}
        onFocus={() => trigger.current?.focus()}
        onInvalid={(event) => {
          event.preventDefault();
          setError(model.current?.validationMessage || "");
          trigger.current?.focus();
        }}
      >
        {children}
      </select>
      {snapshot && (
        <Select
          {...triggerProps}
          id={id ? `${id}-trigger` : undefined}
          ref={trigger}
          label={label || null}
          aria-label={
            props["aria-label"] ||
            (typeof label === "string" ? label : undefined) ||
            props.title ||
            (!label ? name || "请选择" : undefined)
          }
          className="ui-select-field"
          classNames={{ trigger: className }}
          options={snapshot.options}
          value={snapshot.value || null}
          disabled={snapshot.disabled}
          required={false}
          error={error || undefined}
          portalContainer={model.current?.closest("dialog") || undefined}
          onValueChange={(next) => {
            const select = model.current;
            if (!select) return;
            select.value = next ?? "";
            setError("");
            select.dispatchEvent(new Event("input", { bubbles: true }));
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }}
        />
      )}
    </span>
  );
}

function Control({
  tag,
  props,
  children,
  label,
}: {
  tag: string;
  props: LegacyProps;
  children?: React.ReactNode;
  label?: React.ReactNode;
}) {
  if (tag === "button") {
    const c = props.className || "";
    const icon =
      /\b(?:icon-button|icon-btn|chip-x|to-top)\b/.test(c) &&
      !!props["aria-label"];
    const Component = icon ? IconButton : Button;
    return (
      <Component
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        aria-label={props["aria-label"] || text(children)}
        type={
          props.type === "button" || props.type === "reset"
            ? props.type
            : "submit"
        }
        variant={
          /\bprimary\b/.test(c)
            ? "primary"
            : ghost.test(c)
              ? "ghost"
              : "secondary"
        }
        appearance={/\bprimary\b/.test(c) ? "soft" : "default"}
        destructive={/\bdanger\b/.test(c)}
        size={/\bsmall\b/.test(c) ? "sm" : "md"}
      >
        {/^[×✕]$/.test(text(children)) ? <CloseIcon size={18} /> : children}
      </Component>
    );
  }
  if (tag === "select")
    return (
      <SelectField
        {...(props as React.SelectHTMLAttributes<HTMLSelectElement>)}
        label={label}
      >
        {children}
      </SelectField>
    );
  if (tag === "textarea")
    return (
      <Textarea
        {...(props as React.ComponentProps<typeof Textarea>)}
        label={label || null}
        className="ui-field"
        classNames={{ textarea: props.className }}
        defaultValue={String(props.defaultValue ?? text(children))}
      />
    );
  if (
    tag === "input" &&
    !["hidden", "radio", "range", "color"].includes(props.type || "")
  ) {
    if (props.type === "checkbox") {
      const Component = props.role === "switch" ? Switch : Checkbox;
      return (
        <Component
          {...(props as React.ComponentProps<typeof Checkbox>)}
          label={null}
          className="ui-checkbox"
          classNames={{ input: props.className }}
        />
      );
    }
    return (
      <Input
        {...(props as React.ComponentProps<typeof Input>)}
        label={label || null}
        className="ui-field"
        classNames={{ input: props.className }}
      />
    );
  }
  return tag === "input"
    ? React.createElement(tag, props)
    : React.createElement(tag, props, children);
}
function text(children: React.ReactNode) {
  return React.Children.toArray(children)
    .map((c) =>
      typeof c === "string" ? c : typeof c === "number" ? String(c) : "",
    )
    .join("");
}
function labelOf(node: MarkupElement) {
  const parent = node.parent;
  return parent instanceof MarkupElement && parent.name === "label"
    ? parent.children
        .filter((n): n is MarkupText => n instanceof MarkupText)
        .map((n) => n.data)
        .join(" ")
        .trim()
    : undefined;
}
function domToReact(
  nodes: MarkupElement["children"],
  options: HTMLReactParserOptions,
) {
  return renderDOM(
    nodes.filter((node): node is DOMNode => node.type !== "root"),
    options,
  );
}
const parseOptions: HTMLReactParserOptions = {
  replace(node) {
    if (
      node.type === "script" ||
      (node instanceof MarkupElement && node.name === "script")
    )
      return <></>;
    if (!(node instanceof MarkupElement) || node.type !== "tag") return;
    const tag = node.name,
      props = attributesToProps(node.attribs || {}) as LegacyProps;
    // Migrated features render TSX directly; their children never enter the
    // legacy HTML parser or DOM-control adapters.
    const Feature = features[props["data-react-feature"] || ""];
    if (Feature) return <Feature />;
    if (tag === "dialog")
      props.onKeyDownCapture = (event) => {
        // Escape dismisses a select before dismissing its enclosing native dialog.
        if (
          event.key === "Escape" &&
          event.currentTarget.querySelector(
            "[role=combobox][aria-expanded=true]",
          )
        )
          event.preventDefault();
      };
    if (tag === "label") {
      const field = node.children.find(
        (n): n is MarkupElement =>
          n instanceof MarkupElement &&
          ["input", "textarea", "select"].includes(n.name),
      );
      if (
        field &&
        field.attribs?.type !== "radio" &&
        field.attribs?.type !== "hidden"
      ) {
        const position = node.children.indexOf(field);
        const fieldProps = attributesToProps(
          field.attribs || {},
        ) as LegacyProps;
        if ("value" in fieldProps) {
          fieldProps.defaultValue = fieldProps.value;
          delete fieldProps.value;
        }
        if ("checked" in fieldProps) {
          fieldProps.defaultChecked = fieldProps.checked;
          delete fieldProps.checked;
        }
        if (field.name === "select" && fieldProps.defaultValue === undefined) {
          const selected = field.children?.find(
            (n): n is MarkupElement =>
              n instanceof MarkupElement &&
              n.name === "option" &&
              "selected" in (n.attribs || {}),
          );
          if (selected)
            fieldProps.defaultValue =
              selected.attribs.value ??
              text(domToReact(selected.children || [], parseOptions));
        }
        if (fieldProps.type === "checkbox") {
          const rest = node.children.filter(
            (n) =>
              n !== field &&
              !(
                n instanceof MarkupElement &&
                /\bswitch-track\b/.test(n.attribs.class || "")
              ),
          );
          const Component = fieldProps.role === "switch" ? Switch : Checkbox;
          return (
            <div
              {...props}
              className={`${props.className || ""} ui-check-field`}
            >
              <Component
                {...(fieldProps as React.ComponentProps<typeof Checkbox>)}
                label={domToReact(rest, parseOptions)}
                className="ui-checkbox"
                classNames={{ input: fieldProps.className }}
              />
            </div>
          );
        }
        const label = domToReact(
          node.children.slice(0, position),
          parseOptions,
        );
        return (
          <div {...props} className={`${props.className || ""} ui-label`}>
            <Control tag={field.name} props={fieldProps} label={label}>
              {domToReact(field.children || [], parseOptions)}
            </Control>
            {domToReact(node.children.slice(position + 1), parseOptions)}
          </div>
        );
      }
    }
    if (tag === "details") {
      const summary = node.children.find(
        (n): n is MarkupElement =>
          n instanceof MarkupElement && n.name === "summary",
      );
      const titleNodes = (summary?.children || []).flatMap((n) =>
        n instanceof MarkupElement && /^h[1-6]$/.test(n.name)
          ? n.children
          : [n],
      );
      return (
        <DisclosureRegion
          props={props}
          title={domToReact(titleNodes, parseOptions)}
        >
          {domToReact(
            node.children.filter((n) => n !== summary),
            parseOptions,
          )}
        </DisclosureRegion>
      );
    }
    if (
      (tag === "fieldset" && /\bpoll-choice\b/.test(props.className || "")) ||
      /\b(?:gender-row|bot-preview-modes)\b/.test(props.className || "")
    ) {
      const legend = node.children.find(
        (n): n is MarkupElement =>
          n instanceof MarkupElement && n.name === "legend",
      );
      const inputs: MarkupElement[] = [];
      const visit = (n: MarkupElement["children"][number]) => {
        if (n instanceof MarkupElement) {
          if (n.name === "input") inputs.push(n);
          for (const child of n.children) visit(child);
        }
      };
      visit(node);
      const options = inputs.map((input) => ({
        value: input.attribs.value,
        label: domToReact(
          (input.parent instanceof MarkupElement
            ? input.parent.children
            : []
          ).filter((n) => n !== input),
          parseOptions,
        ),
        disabled: "disabled" in input.attribs,
      }));
      return (
        <RadioRegion
          props={props}
          name={inputs[0]?.attribs.name}
          required={inputs.some((n) => "required" in n.attribs)}
          initialValue={
            inputs.find((n) => "checked" in n.attribs)?.attribs.value || ""
          }
          label={
            legend
              ? domToReact(legend.children, parseOptions)
              : /gender-row/.test(props.className || "")
                ? "性别"
                : "预览模式"
          }
          options={options}
        />
      );
    }
    // Markup snapshots describe initial native state, never controlled values.
    if (["input", "textarea", "select"].includes(tag)) {
      if ("value" in props) {
        props.defaultValue = props.value;
        delete props.value;
      }
      if ("checked" in props) {
        props.defaultChecked = props.checked;
        delete props.checked;
      }
    }
    if (tag === "option" && props.selected) {
      delete props.selected;
    }
    let children = domToReact(node.children || [], parseOptions);
    if (tag === "select" && props.defaultValue === undefined) {
      const selected = node.children?.find(
        (n): n is MarkupElement =>
          n instanceof MarkupElement &&
          n.name === "option" &&
          "selected" in (n.attribs || {}),
      );
      if (selected)
        props.defaultValue =
          selected.attribs.value ??
          selected.children
            ?.map((n) => (n instanceof MarkupText ? n.data : ""))
            .join("");
    }
    const c = props.className || "";
    if (["tabBar", "discoverNav", "gatherNav"].includes(props.id || "")) {
      const buttons = node.children.filter(
        (n): n is MarkupElement =>
          n instanceof MarkupElement && n.name === "button",
      );
      return (
        <NavigationRegion
          props={props}
          items={buttons.map((button, index) => ({
            value: String(index),
            label: domToReact(button.children, parseOptions),
            content: null,
            active: /\bactive\b/.test(button.attribs.class || ""),
            props: attributesToProps(button.attribs) as LegacyProps,
          }))}
        />
      );
    }
    if (choicePattern.test(c))
      return (
        <ChoiceRegion props={props} renderMarkup={markup}>
          {children}
        </ChoiceRegion>
      );
    if (tag === "dialog" || /(?:^|\s)modal(?:\s|$)/.test(c))
      return (
        <DialogRegion tag={tag} props={props}>
          {children}
        </DialogRegion>
      );
    if (
      /(?:^|\s)(?:toast|error-banner|activity-alert|preview-bar|form-error|error|status-banner|draft-status)(?:\s|$)/.test(
        c,
      )
    )
      return (
        <FeedbackRegion
          tag={tag}
          props={props}
          kind={/\btoast\b/.test(c) ? "toast" : "alert"}
        >
          {children}
        </FeedbackRegion>
      );
    if (/\bloading-state\b/.test(c))
      return (
        <div {...props}>
          <Spinner label={text(children) || "加载中"} />
        </div>
      );
    if (/\bempty-state\b/.test(c)) {
      const title = node.children.find(
        (n): n is MarkupElement =>
          n instanceof MarkupElement && /^h[1-6]$/.test(n.name),
      );
      const action = node.children.filter(
        (n) => n instanceof MarkupElement && ["button", "a"].includes(n.name),
      );
      const rest = node.children.filter(
        (n) => n !== title && !action.includes(n),
      );
      return (
        <div {...props}>
          <EmptyState
            title={
              title ? domToReact(title.children, parseOptions) : text(children)
            }
            description={title ? domToReact(rest, parseOptions) : undefined}
            action={domToReact(action, parseOptions)}
          />
        </div>
      );
    }
    if (tag === "img" && /\bqq-avatar\b/.test(c))
      return <AvatarRegion props={props} />;
    if (
      tag === "img" &&
      /(?:payment-code-link|settlement-code|invoice-image|library-code)/.test(
        (node.parent instanceof MarkupElement
          ? node.parent.attribs.class
          : "") || "",
      )
    )
      return <ImageRegion props={props} />;
    if (/\bparticipant-avatar\b/.test(c)) {
      const img = node.children.find(
        (n): n is MarkupElement =>
          n instanceof MarkupElement && n.name === "img",
      );
      return (
        <Avatar
          className={c}
          data-ui-avatar=""
          name={
            node.children
              .find(
                (n): n is MarkupElement =>
                  n instanceof MarkupElement && n.name === "span",
              )
              ?.children?.map((n) => (n instanceof MarkupText ? n.data : ""))
              .join("") || "头像"
          }
          src={img?.attribs.src}
          size="sm"
          aria-hidden="true"
        />
      );
    }
    if (/^h[1-6]$/.test(tag))
      return (
        <Heading {...props} level={Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6}>
          {children}
        </Heading>
      );
    if (tag === "p")
      return (
        <Text
          {...props}
          size={
            /\b(?:tiny|field-help|muted|detail-secondary)\b/.test(c)
              ? "sm"
              : "md"
          }
          tone={/\b(?:muted|field-help)\b/.test(c) ? "muted" : "default"}
        >
          {children}
        </Text>
      );
    if (tag === "a" && !/\bevent-card\b/.test(c))
      return (
        <Link
          {...(props as React.ComponentProps<typeof Link>)}
          href={props.href || ""}
        >
          {children}
        </Link>
      );
    if (tag === "hr") return <Divider {...props} />;
    if (["button", "input", "textarea", "select"].includes(tag))
      return (
        <Control tag={tag} props={props} label={labelOf(node)}>
          {children}
        </Control>
      );
    if (
      /(?:^|\s)(?:room-assignment-card|room-unassigned|event-room|trial-panel|poll-option|poll-vote-toolbar|allocation-preview|room-explainer|note-quote)(?:\s|$)/.test(
        c,
      )
    )
      return (
        <OwnedNode
          tag={Surface}
          props={{
            ...props,
            variant: /room-explainer|note-quote/.test(c) ? "note" : "paper",
            className: `${c} ui-surface`,
          }}
        >
          {children}
        </OwnedNode>
      );
    if (badges.test(c))
      return (
        <Badge
          {...props}
          tone={
            /mini-tag|lv-|me-badge|attendance-badge/.test(c)
              ? "accent"
              : "neutral"
          }
        >
          {children}
        </Badge>
      );
    if (
      /(?:^|\s)(?:event-card|home-account|admin-card|card)(?:\s|$)/.test(
        props.className || "",
      )
    ) {
      return (
        <OwnedNode tag={tag} props={props}>
          <Surface className="ui-paper">{children}</Surface>
        </OwnedNode>
      );
    }
    return [
      "area",
      "base",
      "br",
      "col",
      "embed",
      "hr",
      "img",
      "link",
      "meta",
      "param",
      "source",
      "track",
      "wbr",
    ].includes(tag) ? (
      <OwnedNode tag={tag} props={props} />
    ) : (
      <OwnedNode tag={tag} props={props}>
        {children}
      </OwnedNode>
    );
  },
};
const markup = (value: unknown) => parse(String(value ?? ""), parseOptions);

function clear(target: Element) {
  for (const [host, root] of [...roots])
    if (target === host || target.contains(host)) {
      flushSync(() => root.unmount());
      roots.delete(host);
    }
}
function mount(
  target: Element,
  children: React.ReactNode,
  position: "replace" | "append" | "prepend" = "replace",
) {
  if (position === "replace") {
    clear(target);
    target.replaceChildren();
  }
  const host = document.createElement("ui-fragment");
  host.className = "ui-fragment";
  if (position === "prepend") target.prepend(host);
  else target.append(host);
  const root = createRoot(host);
  roots.set(host, root);
  flushSync(() => root.render(children));
}
function controlMarkup(target: Element, children: React.ReactNode) {
  const info = controls.get(target);
  if (!info) return false;
  const props = attributesToProps(
    Object.fromEntries([...target.attributes].map((a) => [a.name, a.value])),
  ) as LegacyProps;
  delete props["data-variant"];
  delete props["data-appearance"];
  delete props["data-destructive"];
  delete props["data-size"];
  delete props.children;
  if (target.tagName !== "BUTTON") return false;
  flushSync(() =>
    info.root.render(
      <Control tag="button" props={props}>
        {children}
      </Control>,
    ),
  );
  return true;
}
function html(target: HTMLElement, value: unknown) {
  const update = viewUpdates.get(target);
  if (update) {
    flushSync(() => update(markup(value)));
    return value;
  }
  if (target.tagName === "SELECT") {
    target.innerHTML = String(value ?? "");
    (target as SelectModel).__uiSync?.();
    return value;
  }
  if (!controlMarkup(target, markup(value))) mount(target, markup(value));
  return value;
}
function setText(target: HTMLElement, value: unknown) {
  const update = viewUpdates.get(target);
  if (update) {
    flushSync(() => update(String(value ?? "")));
    return value;
  }
  if (controlMarkup(target, String(value ?? ""))) return value;
  clear(target);
  target.textContent = String(value ?? "");
  return value;
}
function insert(target: Element, position: string, value: unknown) {
  const children = markup(value);
  if (position === "beforeend") mount(target, children, "append");
  else if (position === "afterbegin") mount(target, children, "prepend");
  else throw new Error(`Unsupported view insertion: ${position}`);
}
function create(tag: string) {
  if (!["button", "input", "textarea", "select"].includes(tag))
    return document.createElement(tag);
  const host = document.createElement("ui-fragment");
  host.className = "ui-fragment ui-control-island";
  const root = createRoot(host);
  roots.set(host, root);
  flushSync(() =>
    root.render(
      <Control
        tag={tag}
        props={{ type: tag === "button" ? "button" : undefined }}
      />,
    ),
  );
  const control = host.querySelector<HTMLElement>(tag);
  if (!control) throw new Error(`Missing ${tag} control`);
  controls.set(control, { host, root });
  const base = control.className;
  Object.defineProperty(control, "className", {
    configurable: true,
    get: () => nativeClass?.get?.call(control),
    set: (value: string) => {
      nativeClass?.set?.call(control, `${base} ${value}`.trim());
      if (tag === "button") {
        control.dataset.variant = /\bprimary\b/.test(value)
          ? "primary"
          : ghost.test(value)
            ? "ghost"
            : "secondary";
        control.dataset.appearance = /\bprimary\b/.test(value)
          ? "soft"
          : "default";
        control.dataset.destructive = String(/\bdanger\b/.test(value));
      }
    },
  });
  return control;
}
const enhanced = new WeakMap<Element, HTMLElement>();
function node(value: Element): Element {
  const existing = enhanced.get(value);
  if (existing) return existing;
  if (
    value instanceof HTMLElement &&
    choicePattern.test(value.className) &&
    !value.classList.contains("ui-choice")
  ) {
    const host = document.createElement("ui-fragment");
    host.className = "ui-fragment";
    const root = createRoot(host);
    roots.set(host, root);
    enhanced.set(value, host);
    const props = attributesToProps(
      Object.fromEntries([...value.attributes].map((a) => [a.name, a.value])),
    ) as LegacyProps;
    value.removeAttribute("id");
    flushSync(() =>
      root.render(
        <ChoiceRegion props={props} model={value} renderMarkup={markup} />,
      ),
    );
    return host;
  }
  if (
    value instanceof HTMLElement &&
    badges.test(value.className) &&
    !("uiBadge" in value.dataset)
  ) {
    const label = value.textContent;
    value.dataset.uiBadge = "";
    mount(
      value,
      <Badge
        tone={
          /mini-tag|lv-|me-badge|attendance-badge/.test(value.className)
            ? "accent"
            : "neutral"
        }
      >
        {label}
      </Badge>,
    );
  }
  if (value instanceof HTMLElement && value.dataset.uiAvatarName) {
    mount(value, <Avatar name={value.dataset.uiAvatarName} size="md" />);
    value.removeAttribute("style");
    delete value.dataset.uiAvatarName;
  }
  return controls.get(value)?.host || value;
}
function remove(value: Element) {
  const host = node(value),
    removeOwned = removals.get(host);
  clear(host);
  if (removeOwned) removeOwned();
  else host.remove();
}
function boot(
  options: { features?: Record<string, React.ComponentType> } = {},
) {
  features = options.features || {};
  const content = document.body.innerHTML;
  const root = createRoot(document.body);
  flushSync(() =>
    root.render(
      <ThemeProvider theme="pink" className="ui-root">
        {markup(content)}
      </ThemeProvider>,
    ),
  );
  document.documentElement.dataset.ui = "yahha";
  document.body.removeAttribute("data-ui-pending");
}
export const UI = {
  boot,
  html,
  text: setText,
  insert,
  create,
  node,
  remove,
  ready: (callback: () => void) => queueMicrotask(callback),
  children: (element: Element): Element[] =>
    [...element.children].flatMap((child) =>
      child.matches("ui-fragment:not(.ui-control-island)")
        ? UI.children(child)
        : [child],
    ),
};
