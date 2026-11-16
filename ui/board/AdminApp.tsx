import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Dialog,
  Heading,
  Link,
  Spinner,
  Surface,
  Text,
  ThemeProvider,
} from "yahha-ui";
import { errorStatus } from "../errors.ts";
import type * as A from "./admin-types.ts";
import { BotSettings } from "./BotSettings.tsx";
import {
  Check,
  ErrorMessage,
  Field,
  Fold,
  Form,
  ModalContext,
  useForm,
} from "./primitives.tsx";
import type * as D from "./types.ts";
const AdminContext = createContext<A.AdminContextValue | null>(null);
export const useAdmin = () => {
  const app = useContext(AdminContext);
  if (!app?.session) throw new Error("Admin session required");
  return { ...app, session: app.session };
};
function AdminApp() {
  const [session, setSession] = useState<A.AdminSession | null>(null),
    [loaded, setLoaded] = useState(false),
    [message, setMessage] = useState(""),
    [modal, setModal] = useState<{
      title: string;
      id: string;
      content: React.ReactNode;
      key: string;
    } | null>(null),
    [container, setContainer] = useState<HTMLElement | null>(null),
    csrf = useRef(""),
    modalStatus = useRef<D.FormStatus>({}),
    f = useForm({ key: "" });
  const request: A.AdminApi = async <T,>(
    path: string,
    data?: unknown,
  ): Promise<T> => {
    let status = 0,
      outcome = "network_error";
    try {
      const response = await fetch(path, {
        method: data ? "POST" : "GET",
        credentials: "same-origin",
        headers: {
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(csrf.current ? { "X-Kanban-Admin": csrf.current } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      status = response.status;
      outcome = response.ok ? "success" : "rejected";
      let result;
      try {
        result = await response.json();
      } catch (error) {
        outcome = "invalid_response";
        throw error;
      }
      if (!response.ok) {
        if (response.status === 401) {
          csrf.current = "";
          setSession(null);
        }
        throw Object.assign(new Error(result.error || "操作失败，请重试"), {
          status: response.status,
        });
      }
      return result as T;
    } finally {
      try {
        globalThis.BoardAnalytics?.request(
          path,
          data ? "POST" : "GET",
          status,
          outcome,
        );
      } catch {}
    }
  };
  const load = async () => {
    try {
      const info = await request<A.AdminSession>("/api/admin/session");
      csrf.current = info.csrf;
      setSession(info);
    } catch (error) {
      if (errorStatus(error) !== 401) throw error;
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    f.run(load);
  }, []);
  const close = () => setModal(null);
  const app: A.AdminContextValue = {
    request,
    session,
    load,
    message,
    setMessage,
    open: (title, id, content) => {
      modalStatus.current = {};
      setModal({ title, id, content, key: crypto.randomUUID() });
    },
    close,
  };
  return (
    <AdminContext.Provider value={app}>
      <ThemeProvider theme="pink" className="ui-root react-board react-admin">
        <main className="page admin-page">
          <Link href="/">返回群聚看板</Link>
          <Heading level={1}>管理后台</Heading>
          <ErrorMessage error={f.error} />
          {!loaded ? (
            <Spinner label="加载管理后台" />
          ) : !session ? (
            <Surface className="admin-panel">
              <Heading level={2}>管理员登录</Heading>
              <Text size="sm">
                已授权的管理员账号可直接访问。请先
                <Link href="/">返回看板登录或切换账号</Link>
                ；也可使用有效一小时的独立管理凭证。
              </Text>
              <Form
                form={f}
                id="admin-login"
                onSubmit={() =>
                  f.run(async () => {
                    await request<void>("/api/admin/login", {
                      key: f.values.key,
                    });
                    f.set("key", "");
                    await load();
                  })
                }
                footer={<Button type="submit">登录管理后台</Button>}
              >
                <Field
                  form={f}
                  name="key"
                  label="管理凭证"
                  type="password"
                  required
                  maxLength={256}
                  autoComplete="off"
                />
              </Form>
            </Surface>
          ) : (
            <div id="admin-settings" className="admin-stack">
              <Text size="sm">
                {session.auth_method === "account"
                  ? "管理员账号登录"
                  : "管理凭证登录 · 有效一小时"}
              </Text>
              <Users />
              <MusicLinks />
              <Registration />
              <BotSettings key={session.csrf} info={session.bot} />
              <Surface className="admin-panel">
                <Heading level={2}>资料删除申请</Heading>
                <Text size="sm">
                  账号登录身份及私人资料已由系统移除。共用记录须核对活动、款项及凭证；填写说明不会自动删除记录。
                </Text>
                {session.privacy_requests?.map((item) => (
                  <PrivacyReview key={item.id} item={item} />
                ))}
                {!session.privacy_requests?.length && (
                  <Text size="sm">暂无资料删除申请</Text>
                )}
              </Surface>
              <Button
                id="admin-logout"
                variant="ghost"
                onClick={() =>
                  f.run(async () => {
                    await request<void>("/api/admin/logout", {});
                    csrf.current = "";
                    await load();
                  })
                }
              >
                {session.auth_method === "account"
                  ? "退出管理后台及当前账号"
                  : "退出管理后台"}
              </Button>
            </div>
          )}
          {message && <Text role="status">{message}</Text>}
        </main>
        <section
          ref={setContainer}
          id={modal?.id}
          data-react-dialog
          data-open={modal ? "true" : undefined}
        >
          {modal && container && (
            <ModalContext.Provider
              value={{
                register: (status) => {
                  modalStatus.current = status;
                },
                close,
                requestClose: close,
                setTitle: () => {},
              }}
            >
              <Dialog
                open
                title={modal.title}
                closeLabel="关闭"
                portalContainer={container}
                className="board-dialog"
                onOpenChange={(open) => {
                  if (!open && !modalStatus.current.busy) close();
                }}
              >
                <React.Fragment key={modal.key}>{modal.content}</React.Fragment>
              </Dialog>
            </ModalContext.Provider>
          )}
        </section>
      </ThemeProvider>
    </AdminContext.Provider>
  );
}
function Users() {
  const app = useAdmin(),
    f = useForm({ search: "", unionid: "all" }),
    [query, setQuery] = useState({ search: "", unionid: "all", offset: 0 }),
    [info, setInfo] = useState<A.UsersResult | null>(null);
  const load = async (params = query) => {
    const result = await app.request<A.UsersResult>(
      "/api/admin/users?" +
        new URLSearchParams({ ...params, offset: String(params.offset) }),
    );
    if (params.offset && params.offset >= result.total) {
      setQuery({
        ...params,
        offset: Math.max(
          0,
          Math.floor((result.total - 1) / result.limit) * result.limit,
        ),
      });
      return;
    }
    setInfo(result);
  };
  useEffect(() => {
    f.run(() => load());
  }, [query]);
  return (
    <Surface className="admin-panel">
      <Heading level={2}>用户管理</Heading>
      <Text size="sm">
        授权前请核对账号 ID 与 QQ 昵称。待补齐 UnionID 的用户需用原 QQ
        重新登录。
      </Text>
      <Form
        form={f}
        id="users-search"
        onSubmit={() =>
          setQuery({
            search: f.values.search.trim(),
            unionid: f.values.unionid,
            offset: 0,
          })
        }
        footer={
          <>
            <Button type="submit" variant="secondary">
              搜索
            </Button>
            <Button variant="ghost" onClick={() => f.run(() => load())}>
              重新载入
            </Button>
          </>
        }
      >
        <div className="form-row">
          <Field
            form={f}
            name="search"
            label="搜索账号"
            type="search"
            maxLength={100}
            placeholder="称呼、账号 ID、QQ 昵称、QQ 号或备注"
          />
          <Field
            form={f}
            name="unionid"
            label="QQ UnionID"
            options={[
              { value: "all", label: "全部状态" },
              { value: "bound", label: "已取得 UnionID" },
              { value: "missing", label: "UnionID 待补齐" },
              { value: "unbound", label: "未绑定 QQ" },
            ]}
          />
        </div>
      </Form>
      {info && (
        <>
          <Text size="sm">共 {info.total} 个账号</Text>
          <div id="admin-users" className="admin-stack">
            {info.users.map((user) => (
              <Surface variant="note" className="admin-user" key={user.id}>
                <Heading level={3}>
                  {user.nickname || "未设置称呼"} ·{" "}
                  {user.is_admin ? "管理员" : "普通用户"}
                  {user.id === app.session.current_user_id ? " · 当前账号" : ""}
                </Heading>
                <Text className="receipt-id" translate="no">
                  {user.id}
                </Text>
                {user.identities.map((identity, index) => (
                  <Text size="sm" key={index}>
                    {identity.provider === "qq"
                      ? "QQ 绑定昵称"
                      : identity.provider}
                    ：{identity.display_name}
                    {identity.provider === "qq"
                      ? " · UnionID：" +
                        (identity.unionid_bound ? "已取得" : "待补齐")
                      : ""}
                  </Text>
                ))}
                {!user.identities.length && (
                  <Text size="sm">未绑定第三方账号</Text>
                )}
                <Text size="sm">
                  手动关联 QQ 号：{user.manual_qq || "未填写"}
                </Text>
                {!!user.note && (
                  <Text size="sm" className="board-pre-wrap">
                    内部备注：{user.note}
                  </Text>
                )}
                <Text size="sm">
                  注册时间：{new Date(user.created_at).toLocaleString()}
                </Text>
                <div className="owner-tools">
                  <Button
                    variant="secondary"
                    data-user-metadata={user.id}
                    disabled={f.busy}
                    onClick={() =>
                      app.open(
                        "备注与手动 QQ 关联",
                        "users-metadata",
                        <UserMetadata
                          user={user}
                          onSave={() => f.run(() => load())}
                        />,
                      )
                    }
                  >
                    编辑备注与 QQ 号
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={
                      f.busy ||
                      (user.id === app.session.current_user_id && user.is_admin)
                    }
                    onClick={() =>
                      app.open(
                        "确认权限变更",
                        "users-confirm",
                        <RoleConfirm
                          user={user}
                          onSave={() => f.run(() => load())}
                        />,
                      )
                    }
                  >
                    {user.is_admin ? "撤销管理员" : "设为管理员"}
                  </Button>
                </div>
                {user.id === app.session.current_user_id && (
                  <Text size="sm">
                    当前账号的管理员权限须由其他管理员撤销。
                  </Text>
                )}
              </Surface>
            ))}
          </div>
          {!info.users.length && <Text size="sm">没有符合条件的账号</Text>}
          <div className="owner-tools">
            <Button
              variant="secondary"
              disabled={f.busy || !info.offset}
              onClick={() =>
                setQuery({
                  ...query,
                  offset: Math.max(0, info.offset - info.limit),
                })
              }
            >
              上一页
            </Button>
            <Text size="sm">
              {info.total ? Math.floor(info.offset / info.limit) + 1 : 0} /{" "}
              {Math.ceil(info.total / info.limit)}
            </Text>
            <Button
              variant="secondary"
              disabled={f.busy || info.offset + info.limit >= info.total}
              onClick={() =>
                setQuery({ ...query, offset: info.offset + info.limit })
              }
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </Surface>
  );
}
function UserMetadata({
  user: initial,
  onSave,
}: {
  user: A.AdminUser;
  onSave: () => unknown;
}) {
  const app = useAdmin(),
    [user, setUser] = useState(initial),
    f = useForm({ manual_qq: initial.manual_qq, note: initial.note });
  return (
    <Form
      form={f}
      id="users-metadata-form"
      onSubmit={() =>
        f.run(async () => {
          await app.request<void>("/api/admin/users/metadata", {
            user_id: user.id,
            note: f.values.note,
            manual_qq: f.values.manual_qq,
            base_revision: user.metadata_revision,
          });
          app.close();
          app.setMessage("已保存内部备注与手动 QQ 关联");
          await onSave();
        })
      }
      footer={
        <>
          <Button variant="secondary" onClick={app.close}>
            取消
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              f.run(async () => {
                const result = await app.request<A.UsersResult>(
                    "/api/admin/users?" +
                      new URLSearchParams({ search: user.id }),
                  ),
                  latest = result.users.find((u) => u.id === user.id);
                if (!latest) throw new Error("账号不存在或已注销");
                setUser(latest);
                f.replace({ manual_qq: latest.manual_qq, note: latest.note });
              })
            }
          >
            重新载入已保存内容
          </Button>
          <Button type="submit">保存</Button>
        </>
      }
    >
      <Text>{user.nickname || "未设置称呼"}</Text>
      <Text className="receipt-id">{user.id}</Text>
      <Text size="sm">
        仅管理员可见。人工 QQ 号不代表 QQ 登录验证，不影响登录、账号绑定或合并。
      </Text>
      <Field
        form={f}
        name="manual_qq"
        label="手动关联 QQ 号"
        inputMode="numeric"
        maxLength={12}
        pattern="[1-9][0-9]{4,11}"
        placeholder="选填，5 至 12 位数字"
      />
      <Field
        form={f}
        name="note"
        label="内部备注"
        multiline
        rows={5}
        maxLength={1000}
      />
      <Text size="sm">
        同一 QQ 号只能手动关联一个账号；清空后保存可解除，注销时会删除。
      </Text>
    </Form>
  );
}
function RoleConfirm({
  user,
  onSave,
}: {
  user: A.AdminUser;
  onSave: () => unknown;
}) {
  const app = useAdmin(),
    f = useForm({});
  return (
    <Form
      form={f}
      onSubmit={() =>
        f.run(async () => {
          try {
            await app.request<void>("/api/admin/users", {
              user_id: user.id,
              is_admin: !user.is_admin,
              base_revision: user.revision,
            });
            app.close();
            app.setMessage(user.is_admin ? "已撤销管理员权限" : "已设为管理员");
          } finally {
            await onSave();
          }
        })
      }
      footer={
        <>
          <Button variant="secondary" onClick={app.close}>
            取消
          </Button>
          <Button type="submit">
            {user.is_admin ? "撤销管理员" : "设为管理员"}
          </Button>
        </>
      }
    >
      <Text>{user.nickname || "未设置称呼"}</Text>
      <Text className="receipt-id">{user.id}</Text>
      <Text>
        {user.is_admin
          ? "撤销后无法继续使用管理后台或协助编辑其他人的活动。"
          : "此账号将能管理全部后台设置及用户权限，并协助编辑有权查看的已发布活动安排。"}
      </Text>
    </Form>
  );
}
const musicStatuses: Record<string, string> = {
  unlinked: "未关联",
  prelinked: "看板账号关联",
  oauth: "已完成 QQ 授权",
};
function MusicLinks() {
  const app = useAdmin(),
    f = useForm({ search: "", status: "all" }),
    [info, setInfo] = useState<A.MusicLinksResult | null>(null),
    [query, setQuery] = useState(f.values);
  const load = async () =>
    setInfo(await app.request<A.MusicLinksResult>("/api/admin/music-links"));
  useEffect(() => {
    f.run(load);
  }, []);
  const rows =
    info?.members.filter(
      (member) =>
        (query.status === "all" || query.status === member.status) &&
        [
          member.qq,
          member.name,
          member.user_id,
          member.board_name,
          member.contactQQ,
        ].some((value) =>
          String(value).toLowerCase().includes(query.search.toLowerCase()),
        ),
    ) || [];
  return (
    <Surface className="admin-panel">
      <Heading level={2}>成分站关联</Heading>
      <Text size="sm">
        这里管理实际登录关联，修改会改变谁能使用该成分资料；与仅供备注的手动 QQ
        号分别维护。
      </Text>
      <Link href="/music/admin.html">打开成分站管理后台</Link>
      <Form
        form={f}
        id="music-links-search"
        onSubmit={() =>
          setQuery({ ...f.values, search: f.values.search.trim() })
        }
        footer={
          <>
            <Button type="submit" variant="secondary">
              搜索
            </Button>
            <Button variant="ghost" onClick={() => f.run(load)}>
              重新载入
            </Button>
          </>
        }
      >
        <Field
          form={f}
          name="search"
          label="搜索成分关联"
          type="search"
          maxLength={100}
        />
        <Field
          form={f}
          name="status"
          label="关联状态"
          options={[
            { value: "all", label: "全部状态" },
            ...Object.entries(musicStatuses).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
      </Form>
      {info && (
        <Text size="sm">
          共 {info.members.length} 位成分会员，
          {info.members.filter((m) => m.user_id).length} 位已关联；显示{" "}
          {rows.length} 位
        </Text>
      )}
      <div className="admin-stack">
        {rows.map((member) => (
          <Surface variant="note" key={member.qq}>
            <Heading level={3}>
              {member.name || member.qq} · {musicStatuses[member.status]}
            </Heading>
            <Text size="sm">成分 ID／QQ：{member.qq}</Text>
            {!!member.contactQQ && (
              <Text size="sm">QQ 号（自填）：{member.contactQQ}</Text>
            )}
            <Text size="sm">
              看板账号：{member.user_id ? member.board_name || "—" : "—"}
              {member.user_id && !member.board_active
                ? " · 账号不存在或已注销"
                : ""}
            </Text>
            {!!member.user_id && (
              <Text className="receipt-id">{member.user_id}</Text>
            )}
            {!member.has_pin && !member.user_id && (
              <Text size="sm">没有旧口令，须由管理员核对后建立关联。</Text>
            )}
            <Button
              variant="secondary"
              disabled={f.busy}
              onClick={() =>
                app.open(
                  "修改成分站关联",
                  "music-link-dialog",
                  <MusicLink member={member} onSave={() => f.run(load)} />,
                )
              }
            >
              {member.user_id ? "修改或解除关联" : "建立关联"}
            </Button>
          </Surface>
        ))}
      </div>
      {info && !rows.length && <Text size="sm">没有符合条件的成分会员</Text>}
      <Fold title="最近关联变更">
        {info?.history.map((item, index) => (
          <Text size="sm" key={index}>
            {item.qq}：{item.before_user_id || "—"} →{" "}
            {item.after_user_id || "—"} · {item.actor_name} ·{" "}
            {new Date(item.created * 1000).toLocaleString()}
          </Text>
        ))}
      </Fold>
    </Surface>
  );
}
function MusicLink({
  member: initial,
  onSave,
}: {
  member: A.MusicMember;
  onSave: () => unknown;
}) {
  const app = useAdmin(),
    [member, setMember] = useState(initial),
    [users, setUsers] = useState<A.AdminUser[]>([]),
    f = useForm({ search: "", user_id: "", confirmed: false });
  const save = (id: string) =>
    f.run(async () => {
      if (!f.values.confirmed) throw new Error("请先确认已核对账号");
      await app.request<void>("/api/admin/music-links", {
        qq: member.qq,
        user_id: id,
        base_revision: member.revision,
      });
      app.close();
      app.setMessage(
        id ? "成分站关联已保存" : "成分站关联已解除，原成分资料保留",
      );
      await onSave();
    });
  return (
    <Form
      form={f}
      id="music-link-form"
      onSubmit={() => save(f.values.user_id)}
      footer={
        <>
          <Button variant="secondary" onClick={app.close}>
            取消
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              f.run(async () => {
                const result = await app.request<A.MusicLinksResult>(
                    "/api/admin/music-links",
                  ),
                  latest = result.members.find((m) => m.qq === member.qq);
                if (!latest) throw new Error("成分会员不存在");
                setMember(latest);
                setUsers([]);
                f.replace({ search: "", user_id: "", confirmed: false });
              })
            }
          >
            重新载入
          </Button>
          {!!member.user_id && (
            <Button variant="secondary" onClick={() => save("")}>
              解除关联
            </Button>
          )}
          <Button type="submit">保存关联</Button>
        </>
      }
    >
      <Text>
        {member.name || "—"} · {member.qq}
      </Text>
      <Text size="sm">
        当前账号：{member.board_name || "—"} · {member.user_id || "—"}
      </Text>
      <Field
        form={f}
        name="search"
        label="查找看板账号"
        type="search"
        maxLength={100}
      />
      <Button
        variant="secondary"
        onClick={() =>
          f.run(async () => {
            if (!f.values.search.trim())
              throw new Error("请输入看板称呼或账号 ID");
            const result = await app.request<A.UsersResult>(
              "/api/admin/users?" +
                new URLSearchParams({ search: f.values.search.trim() }),
            );
            setUsers(result.users);
            f.set("user_id", "");
          })
        }
      >
        查找账号
      </Button>
      <Field
        form={f}
        name="user_id"
        label="新的关联账号"
        required
        options={[
          { value: "", label: "请先查找并选择账号" },
          ...users.map((user) => ({
            value: user.id,
            label: (user.nickname || "未设置称呼") + " · " + user.id,
          })),
        ]}
      />
      <Text size="sm">
        修正将撤销旧授权，改为管理员对应。解除关联保留成分资料，原用户需用旧口令重新关联；没有口令时仍需管理员协助。
      </Text>
      <Check
        form={f}
        name="confirmed"
        label="已核对成分会员与看板账号，确认此次变更"
        required
      />
    </Form>
  );
}
function Registration() {
  const app = useAdmin(),
    f = useForm({ allow: app.session.settings.allow_name_registration }),
    revision = useRef(app.session.settings.revision);
  return (
    <Surface className="admin-panel">
      <Heading level={2}>注册方式</Heading>
      <Form
        form={f}
        id="registration-settings"
        onSubmit={() =>
          f.run(async () => {
            try {
              const result = await app.request<{ settings: A.AdminSettings }>(
                "/api/admin/settings",
                {
                  allow_name_registration: f.values.allow,
                  base_revision: revision.current,
                },
              );
              revision.current = result.settings.revision;
              app.setMessage("注册设置已保存");
            } catch (error) {
              await app.load();
              throw error;
            }
          })
        }
        footer={<Button type="submit">保存设置</Button>}
      >
        <Check
          form={f}
          name="allow"
          label="允许免第三方登录注册"
          switchControl
        />
        <Text size="sm">
          关闭不删除已建立的账号；默认须使用第三方登录注册。
        </Text>
        <Text size="sm">
          {app.session.providers.some((p) => p.enabled)
            ? "QQ 登录已配置"
            : "QQ 未配置，关闭称呼注册后将无法注册。"}
        </Text>
      </Form>
    </Surface>
  );
}
function PrivacyReview({ item }: { item: A.PrivacyRequest }) {
  const app = useAdmin(),
    f = useForm({ note: item.note || "" });
  return (
    <Surface variant="note">
      <Heading level={3}>
        {item.status === "completed" ? "个人账号资料已删除" : "共用记录待核对"}
      </Heading>
      <Text size="sm">{item.created_at}</Text>
      <Text className="receipt-id">{item.id}</Text>
      <Text size="sm">
        {Object.entries(item.shared_records)
          .map(([table, count]) => table + ": " + count)
          .join("；") || "无关联共用记录"}
      </Text>
      <Form
        form={f}
        onSubmit={() =>
          f.run(async () => {
            await app.request<void>("/api/admin/privacy-review", {
              request_id: item.id,
              note: f.values.note,
            });
            app.setMessage("处理说明已保存");
            await app.load();
          })
        }
        footer={
          <Button variant="secondary" type="submit">
            保存处理说明
          </Button>
        }
      >
        <Field
          form={f}
          name="note"
          label="处理说明"
          required
          multiline
          maxLength={1000}
        />
      </Form>
    </Surface>
  );
}
export function mountAdmin() {
  createRoot(document.getElementById("admin-root")!).render(<AdminApp />);
}
