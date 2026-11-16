import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Divider,
  Heading,
  Input,
  Link,
  RadioGroup,
  SegmentedControl,
  Select,
  Surface,
  Text,
  Textarea,
} from "yahha-ui";
import { errorMessage, errorStatus } from "../errors.ts";
import type * as A from "./admin-types.ts";
import { useAdmin } from "./AdminApp.tsx";
import { Check, Field, Fold, Form, clone, useForm } from "./primitives.tsx";
const configLabels: Record<string, string> = {
  enabled: "主动通知",
  replies_enabled: "指令回复",
  dry_run: "发送模式",
  broadcast_kinds: "通知事件",
  schedule_enabled: "定时提醒",
  deadline_hours: "截止提醒时间",
  estimated_over_delay_minutes: "预计结束提醒时间",
  quiet_enabled: "勿扰开关",
  quiet_start: "勿扰开始",
  quiet_end: "勿扰结束",
  timezone: "勿扰时区",
  min_interval_seconds: "发送间隔",
  templates: "消息模板",
  groups: "群组设置",
};
const groupReasons: Record<string, string> = {
  group_not_allowed: "此群未允许指令回复",
  replies_disabled: "全局指令回复已关闭",
  dry_run: "模拟模式，未实际发送",
  duplicate: "重复事件，已去重",
  bot_author: "来自机器人，已忽略",
};
const initial = (info: A.BotInfo) => ({
  ...clone(info.config),
  deadline_hours: String(info.config.deadline_hours),
  estimated_over_delay_minutes: String(
    info.config.estimated_over_delay_minutes,
  ),
  min_interval_seconds: String(info.config.min_interval_seconds),
  dry_run:
    info.config.dry_run === null
      ? "inherit"
      : info.config.dry_run
        ? "simulate"
        : "live",
  groups: clone(info.group_status.groups),
});
export function BotSettings({ info: original }: { info: A.BotInfo }) {
  const app = useAdmin(),
    [info, setInfo] = useState(original),
    [runtime, setRuntime] = useState(original),
    f = useForm(() => initial(original)),
    [kind, setKind] = useState(Object.keys(original.kinds)[0] || ""),
    [groupId, setGroupId] = useState(""),
    [preview, setPreview] = useState<{ text: string; markdown: string } | null>(
      null,
    ),
    [mode, setMode] = useState("text"),
    [saved, setSaved] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null),
    markdownRef = useRef<HTMLTextAreaElement>(null),
    lastField = useRef("text"),
    v = f.values,
    latest = useRef({ busy: f.busy });
  latest.current = { busy: f.busy };
  const setup = (next: A.BotInfo) => {
    setInfo(next);
    setRuntime(next);
    f.replace(initial(next));
    setPreview(null);
  };
  const mergeGroups = (next: A.BotInfo) => {
    setRuntime(next);
    f.patch((previous) => ({
      groups: [
        ...previous.groups.map((group) => {
          const observed = next.group_status.groups.find(
            (value) => value.id === group.id,
          );
          return observed
            ? {
                ...group,
                last_seen: observed.last_seen,
                membership: observed.membership,
                reference: observed.reference,
              }
            : group;
        }),
        ...next.group_status.groups
          .filter(
            (group) => !previous.groups.some((value) => value.id === group.id),
          )
          .map((group) => ({ ...group, replies: false, broadcast: false })),
      ],
    }));
  };
  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.hidden || latest.current.busy) return;
      try {
        mergeGroups(await app.request<A.BotInfo>("/api/admin/bot-settings"));
      } catch (error) {
        if (errorStatus(error) === 401) f.setError(errorMessage(error));
      }
    }, 10000);
    return () => clearInterval(timer);
  }, []);
  const change: typeof f.set = (name, value) => {
    setPreview(null);
    f.set(name, value);
    setSaved("");
  };
  const fields = { ...f, set: change };
  const updateGroup = <K extends keyof A.BotGroup>(
    id: string,
    name: K,
    value: A.BotGroup[K],
  ) =>
    change(
      "groups",
      v.groups.map((group) =>
        group.id === id ? { ...group, [name]: value } : group,
      ),
    );
  const richKey = kind + info.markdown_suffix,
    text = v.templates[kind] ?? info.default_template,
    markdown = v.templates[richKey] || "";
  const template = (rich: boolean, value: string) => {
    const templates = { ...v.templates },
      key = rich ? richKey : kind;
    if (rich ? !value.trim() : value === info.default_template)
      delete templates[key];
    else templates[key] = value;
    change("templates", templates);
  };
  const config = (): A.BotConfig => ({
    ...v,
    dry_run: v.dry_run === "inherit" ? null : v.dry_run === "simulate",
    groups: v.groups
      .filter(
        (group) =>
          group.name ||
          group.replies ||
          group.broadcast ||
          group.manual ||
          group.configured,
      )
      .map(({ id, name, replies, broadcast }) => ({
        id,
        name,
        replies,
        broadcast,
      })),
    deadline_hours: Number(v.deadline_hours),
    estimated_over_delay_minutes: Number(v.estimated_over_delay_minutes),
    min_interval_seconds: Number(v.min_interval_seconds),
  });
  const insert = (variable: string) => {
    const rich = lastField.current === "markdown",
      field = rich ? markdownRef.current : textRef.current,
      source = rich ? markdown : text,
      start = field?.selectionStart ?? source.length,
      end = field?.selectionEnd ?? source.length,
      token = "{" + variable + "}";
    template(rich, source.slice(0, start) + token + source.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <Surface className="admin-panel">
      <Heading level={2}>QQ 机器人</Heading>
      <Text id="bot-runtime" size="sm" role="status">
        当前配置第 {runtime.revision} 版；
        {runtime.runtime.applied_revision === null
          ? "机器人尚未回报配置状态"
          : "机器人已载入第 " + runtime.runtime.applied_revision + " 版"}
        {runtime.runtime.checked_at
          ? "；回报时间 " +
            new Date(runtime.runtime.checked_at).toLocaleString()
          : ""}
        {runtime.revision !== info.revision ? "；有新版配置，请重新载入" : ""}
      </Text>
      <Text size="sm">
        保存后无需重启。每场活动仍须开启群同步，邀请活动与草稿不会进入群。
      </Text>
      <Form
        id="bot-settings-form"
        form={f}
        onSubmit={() =>
          f.run(async () => {
            const result = await app.request<{ bot: A.BotInfo }>(
              "/api/admin/bot-settings",
              {
                config: config(),
                base_revision: info.revision,
              },
            );
            setup(result.bot);
            setSaved("机器人设置已保存，等待机器人回报载入状态。");
          })
        }
        footer={
          <>
            <Button type="submit">保存机器人设置</Button>
            <Button
              variant="secondary"
              onClick={() =>
                f.run(async () => {
                  setup(
                    await app.request<A.BotInfo>("/api/admin/bot-settings"),
                  );
                  setSaved("已重新载入，未保存的修改已清除。");
                })
              }
            >
              重新载入
            </Button>
          </>
        }
      >
        <Fold title="群组管理" defaultOpen>
          <Text size="sm">
            新发现的群默认停用。备注不会修改 QQ
            群名；更换通知目标会作废旧待送通知，不会转发到新群。
          </Text>
          <Text size="sm">
            {info.group_status.inherited
              ? "沿用原部署默认群；保存后由本页管理。"
              : "当前由本页管理群组。"}
          </Text>
          <RadioGroup
            label="主动通知目标群"
            value={v.groups.find((group) => group.broadcast)?.id || ""}
            onValueChange={(id) =>
              change(
                "groups",
                v.groups.map((group) => ({
                  ...group,
                  broadcast: group.id === id,
                })),
              )
            }
            options={[
              { value: "", label: "不设置主动通知目标群" },
              ...v.groups.map((group) => ({
                value: group.id,
                label: group.name || group.reference || group.id,
              })),
            ]}
          />
          <div id="bot-groups" className="admin-stack">
            {v.groups.map((group) => (
              <Surface variant="note" key={group.id}>
                <Heading level={4}>
                  {group.deployment_default
                    ? "原部署默认群"
                    : group.last_seen
                      ? "已发现的群"
                      : "手动配置的群"}
                </Heading>
                <Text size="sm">
                  {group.membership === "removed"
                    ? "机器人已被移出"
                    : group.last_seen
                      ? "最近收到事件 " +
                        new Date(group.last_seen).toLocaleString()
                      : "尚未收到群事件"}
                </Text>
                <Input
                  label="管理备注"
                  value={group.name}
                  maxLength={60}
                  onChange={(event) =>
                    updateGroup(group.id, "name", event.target.value)
                  }
                />
                <Text size="sm">
                  日志对应标识：{group.reference || group.id}
                </Text>
                <Checkbox
                  label="允许此群 @ 回复"
                  checked={group.replies}
                  onChange={(event) =>
                    updateGroup(group.id, "replies", event.target.checked)
                  }
                />
                <Fold title="查看群标识">
                  <Text className="receipt-id">{group.id}</Text>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      change(
                        "groups",
                        v.groups.map((value) =>
                          value.id === group.id
                            ? {
                                ...value,
                                name: "",
                                replies: false,
                                broadcast: false,
                                manual: false,
                                configured: false,
                              }
                            : value,
                        ),
                      )
                    }
                  >
                    停用并清除此群配置
                  </Button>
                  <Text size="sm">保存后停用，发现记录保留。</Text>
                </Fold>
              </Surface>
            ))}
          </div>
          <Button
            id="bot-groups-refresh"
            variant="secondary"
            onClick={() =>
              f.run(async () => {
                mergeGroups(
                  await app.request<A.BotInfo>("/api/admin/bot-settings"),
                );
                setSaved("已刷新群组与诊断，保留未保存的修改。");
              })
            }
          >
            刷新群组与诊断
          </Button>
          <Fold title="手动添加群标识">
            <Text size="sm">
              在群里 @ 一次后刷新即可发现。group_openid 不是 QQ
              群号；不确定时先保持停用。
            </Text>
            <Input
              label="群标识"
              value={groupId}
              maxLength={128}
              onChange={(event) => setGroupId(event.target.value)}
            />
            <Button
              variant="secondary"
              onClick={() => {
                const id = groupId.trim();
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
                  f.setError("请输入 QQ 事件中的有效群标识，不是 QQ 群号。");
                  return;
                }
                change(
                  "groups",
                  v.groups.some((group) => group.id === id)
                    ? v.groups.map((group) =>
                        group.id === id ? { ...group, manual: true } : group,
                      )
                    : [
                        ...v.groups,
                        {
                          id,
                          name: "",
                          replies: false,
                          broadcast: false,
                          manual: true,
                          membership: "unknown",
                        },
                      ],
                );
                setGroupId("");
              }}
            >
              添加到待保存列表
            </Button>
          </Fold>
          <Fold title="最近未回复的 @ 与按钮操作">
            {runtime.group_status.ignores.map((row, index) => (
              <Text size="sm" key={index}>
                {v.groups.find((group) => group.id === row.group_id)?.name ||
                  row.group_id}{" "}
                · {new Date(row.created_at).toLocaleString()} ·{" "}
                {groupReasons[row.reason] || row.reason}
              </Text>
            ))}
            {!runtime.group_status.ignores.length && (
              <Text size="sm">暂无记录。可在测试群里 @ 一次，再刷新查看。</Text>
            )}
            <Text size="sm">
              历史原因不代表当前设置，仅保留最近 100
              条，不保存聊天正文或成员身份。
            </Text>
          </Fold>
        </Fold>
        <Heading level={3}>功能开关</Heading>
        <Check
          form={fields}
          name="enabled"
          label="开启主动通知"
          switchControl
        />
        <Check
          form={fields}
          name="replies_enabled"
          label="开启指令回复"
          switchControl
        />
        <Field
          form={fields}
          name="dry_run"
          label="发送模式"
          options={[
            { value: "inherit", label: "沿用部署设置" },
            { value: "simulate", label: "模拟，不实际发送" },
            { value: "live", label: "实际发送" },
          ]}
        />
        <Text size="sm">
          发送模式同时适用于通知与回复。关闭主动通知会作废待送通知，重新开启不补发旧通知；已提交
          QQ 的消息无法撤回。
        </Text>
        <Fold title="通知事件" defaultOpen>
          <div className="board-check-grid">
            {Object.entries(info.kinds).map(([kind, label]) => (
              <Checkbox
                key={kind}
                label={label}
                checked={v.broadcast_kinds.includes(kind)}
                onChange={(event) =>
                  change(
                    "broadcast_kinds",
                    event.target.checked
                      ? [...v.broadcast_kinds, kind]
                      : v.broadcast_kinds.filter((value) => value !== kind),
                  )
                }
              />
            ))}
          </div>
        </Fold>
        <Fold title="提醒时间">
          <Check
            form={fields}
            name="schedule_enabled"
            label="开启定时提醒"
            switchControl
          />
          <Field
            form={fields}
            name="deadline_hours"
            label="报名截止前几小时提醒"
            type="number"
            min="1"
            max="720"
            required
          />
          <Field
            form={fields}
            name="estimated_over_delay_minutes"
            label="超过预计结束后几分钟提醒"
            type="number"
            min="0"
            max="1440"
            required
          />
          <Text size="sm">修改后重排未来提醒，不补发已错过的提醒。</Text>
        </Fold>
        <Fold title="发送时段与间隔">
          <Check
            form={fields}
            name="quiet_enabled"
            label="开启勿扰时段"
            switchControl
          />
          <div className="form-row">
            <Field
              form={fields}
              name="quiet_start"
              label="开始"
              type="time"
              required
            />
            <Field
              form={fields}
              name="quiet_end"
              label="结束"
              type="time"
              required
            />
          </div>
          <Field
            form={fields}
            name="timezone"
            label="勿扰时区"
            required
            maxLength={80}
          />
          <Field
            form={fields}
            name="min_interval_seconds"
            label="主动通知最短间隔（秒）"
            type="number"
            min="0"
            max="3600"
            required
          />
          <Text size="sm">
            勿扰期间延后主动通知，0
            秒不额外限制。指令回复仍即时响应；失效提醒跳过。
          </Text>
        </Fold>
        <Fold title="消息模板">
          <Select
            label="通知类型"
            id="bot-template-kind"
            value={kind}
            options={Object.entries(info.kinds).map(([value, label]) => ({
              value,
              label,
            }))}
            onValueChange={(value) => {
              setKind(value ?? "");
              setPreview(null);
            }}
          />
          <Text size="sm">
            {Object.hasOwn(v.templates, kind)
              ? "纯文字：自定义模板"
              : "纯文字：默认模板"}{" "}
            ·{" "}
            {Object.hasOwn(v.templates, richKey)
              ? "Markdown：自定义模板"
              : "Markdown：系统自动生成卡片"}
          </Text>
          <Textarea
            id="bot-template-text"
            label="纯文字模板"
            ref={textRef}
            value={text}
            rows={7}
            maxLength={2000}
            spellCheck={false}
            onFocus={() => {
              lastField.current = "text";
            }}
            onChange={(event) => template(false, event.target.value)}
          />
          <Text size="sm">
            必须保留 {"{url}"}。{"{details}"}{" "}
            由系统生成；自定义文字按原文发送，最多 2000 字、展开后最多 4000 字。
          </Text>
          <div className="owner-tools">
            {Object.entries(info.variables).map(([key, label]) => (
              <Button key={key} variant="ghost" onClick={() => insert(key)}>
                {label} {"{" + key + "}"}
              </Button>
            ))}
          </div>
          <Textarea
            id="bot-template-markdown"
            label="Markdown 模板（可选）"
            ref={markdownRef}
            value={markdown}
            rows={8}
            maxLength={2000}
            spellCheck={false}
            onFocus={() => {
              lastField.current = "markdown";
            }}
            onChange={(event) => template(true, event.target.value)}
          />
          <Text size="sm">
            留空自动生成卡片；仅部署开启 KANBAN_BOT_MARKDOWN=1
            时生效。可用标题、粗体、删除线、清单、链接与引用，变量值只留纯文字，仍须保留{" "}
            {"{url}"}。
          </Text>
          <div className="owner-tools">
            <Button
              variant="secondary"
              onClick={() => template(false, info.default_template)}
            >
              使用默认纯文字模板
            </Button>
            <Button
              variant="secondary"
              onClick={() => template(true, info.default_markdown_template)}
            >
              插入 Markdown 示例
            </Button>
            <Button variant="secondary" onClick={() => template(true, "")}>
              清除 Markdown 模板
            </Button>
            <Button
              id="bot-preview"
              variant="secondary"
              onClick={() =>
                f.run(async () =>
                  setPreview(
                    await app.request<{ text: string; markdown: string }>(
                      "/api/admin/bot-preview",
                      {
                        config: config(),
                        kind,
                      },
                    ),
                  ),
                )
              }
            >
              预览示例
            </Button>
          </div>
          <Text size="sm">预览使用示例资料，不会发送群消息。</Text>
          {preview && (
            <>
              <SegmentedControl
                label="预览模式"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "text", label: "纯文字" },
                  { value: "source", label: "Markdown 原始码" },
                  { value: "render", label: "Markdown 效果" },
                ]}
              />
              {mode === "render" ? (
                <div className="bot-preview bot-preview-render">
                  {preview.markdown ? (
                    <Markdown source={preview.markdown} />
                  ) : (
                    <Text size="sm">
                      此事件没有可送出的 Markdown 内容；投递时退回纯文字。
                    </Text>
                  )}
                </div>
              ) : (
                <pre className="bot-preview">
                  {mode === "source"
                    ? preview.markdown || "（无 Markdown 内容）"
                    : preview.text}
                </pre>
              )}
            </>
          )}
        </Fold>
      </Form>
      {saved && <Text role="status">{saved}</Text>}
      <Fold title="配置修改记录">
        {info.history.map((item) => (
          <Text size="sm" key={item.revision}>
            第 {item.revision} 版 · {new Date(item.created_at).toLocaleString()}{" "}
            ·{" "}
            {item.action === "revert"
              ? "恢复配置"
              : item.action === "baseline"
                ? "部署默认配置"
                : "保存配置"}{" "}
            · {item.changes.map((key) => configLabels[key] || key).join("、")}
          </Text>
        ))}
        <Button
          variant="secondary"
          disabled={f.busy || info.revision === 0}
          onClick={() =>
            f.run(async () => {
              const result = await app.request<{ bot: A.BotInfo }>(
                "/api/admin/bot-revert",
                {
                  base_revision: info.revision,
                },
              );
              setup(result.bot);
              setSaved("已恢复上一版配置，并保存为新版本。");
            })
          }
        >
          恢复上一版配置
        </Button>
        <Text size="sm">
          恢复会保存为新版本并重新应用通知与提醒规则，历史记录保留。
        </Text>
      </Fold>
    </Surface>
  );
}
function Inline({ text }: { text: string }) {
  const tokens = String(text)
    .replace(/\u200B/g, "")
    .split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|~~[^~]+~~)/g);
  return tokens.map((token, index) => {
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link)
      return (
        <Link external href={link[2]} key={index}>
          {link[1]}
        </Link>
      );
    if (token.startsWith("**") && token.endsWith("**"))
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("~~") && token.endsWith("~~"))
      return <s key={index}>{token.slice(2, -2)}</s>;
    return token;
  });
}
function Markdown({ source }: { source: string }) {
  const blocks: React.ReactNode[] = [],
    lines = String(source).split("\n");
  let list: { type: "ol" | "ul"; lines: string[] } | null = null;
  const close = () => {
    if (list) {
      const Tag = list.type;
      blocks.push(
        <Tag key={blocks.length}>
          {list.lines.map((line, index) => (
            <li key={index}>
              <Inline text={line} />
            </li>
          ))}
        </Tag>,
      );
      list = null;
    }
  };
  for (const line of lines) {
    const bare = line.replace(/\u200B/g, "").trim();
    let match;
    if (
      (match = line.match(/^[-*]\s+(.*)$/)) ||
      (match = line.match(/^\d+\.\s+(.*)$/))
    ) {
      const type = /^\d/.test(line) ? "ol" : "ul";
      if (
        (list as { type: "ol" | "ul"; lines: string[] } | null)?.type !== type
      ) {
        close();
        list = { type, lines: [] };
      }
      list!.lines.push(match[1]);
      continue;
    }
    close();
    if (!bare) {
      blocks.push(<br key={blocks.length} />);
      continue;
    }
    if (bare === "***") {
      blocks.push(<Divider key={blocks.length} />);
      continue;
    }
    if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push(
        <Heading
          key={blocks.length}
          level={Math.min(6, match[1].length + 2) as 1 | 2 | 3 | 4 | 5 | 6}
        >
          <Inline text={match[2]} />
        </Heading>,
      );
      continue;
    }
    if ((match = line.match(/^>\s+(.*)$/))) {
      blocks.push(
        <blockquote key={blocks.length}>
          <Inline text={match[1]} />
        </blockquote>,
      );
      continue;
    }
    blocks.push(
      <Text key={blocks.length}>
        <Inline text={line} />
      </Text>,
    );
  }
  close();
  return blocks;
}
