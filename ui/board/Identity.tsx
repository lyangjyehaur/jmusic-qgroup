import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Heading,
  Input,
  Link,
  Spinner,
  Surface,
  Text,
} from "yahha-ui";
import { errorMessage } from "../errors.ts";
import { prepareCode } from "./domain.ts";
import { Picture } from "./Money.tsx";
import type { FormController } from "./primitives.tsx";
import {
  Check,
  ErrorMessage,
  Field,
  Fold,
  Form,
  uid,
  useBoard,
  useForm,
  useModal,
} from "./primitives.tsx";
import type * as D from "./types.ts";
const codeKinds: Record<string, string> = {
  wechat: "微信",
  alipay: "支付宝",
  other: "其他",
};
function Privacy({
  form,
}: {
  form: Pick<FormController<{ privacy: boolean }>, "busy" | "set"> & {
    values: { privacy: boolean };
  };
}) {
  const app = useBoard();
  return (
    <>
      {!app.me.privacy_accepted && (
        <Check
          form={form}
          name="privacy"
          label={
            <span>
              我已阅读并同意
              <Link href="/privacy" external>
                隐私政策
              </Link>
              ，同意为登录与账号功能处理必要资料。
            </span>
          }
        />
      )}
      <Link href="/contact" external>
        联系运营者
      </Link>
    </>
  );
}
function consent(
  app: D.BoardContextValue,
  f: { values: { privacy: boolean } },
) {
  if (!app.me.privacy_accepted && !f.values.privacy)
    throw new Error("请阅读并勾选同意隐私政策后继续");
  return { accept_privacy: true, privacy_version: app.me.privacy_version };
}
function ensureCanLeave(app: D.BoardContextValue) {
  if (
    [...app.formStates.current.values()].some(
      (status) => status.dirty || status.busy,
    )
  )
    throw new Error("请先暂存并关闭正在编辑的表单");
}
function stamp(app: D.BoardContextValue) {
  try {
    localStorage.setItem(
      "kanban-qq-reauth-v1:" + app.me.draft_scope,
      String(Date.now()),
    );
  } catch {}
}
async function startQQ(
  app: D.BoardContextValue,
  mode: string,
  privacy: { accept_privacy: boolean; privacy_version?: string },
  refresh = false,
) {
  ensureCanLeave(app);
  if (app.me.qq?.needs_reauth) stamp(app);
  const result = await app.api<{ authorize_url: string }>(
    "/api/auth/qq/start",
    "POST",
    {
      mode,
      confirm: true,
      ...privacy,
      operation: uid(),
      return_path: location.pathname + location.search,
    },
  );
  try {
    if (refresh)
      sessionStorage.setItem("kanban-qq-refresh-scope", app.me.draft_scope);
    else sessionStorage.removeItem("kanban-qq-refresh-scope");
  } catch {}
  location.assign(result.authorize_url);
}
function beginQQ(
  app: D.BoardContextValue,
  f: Pick<FormController<{ privacy: boolean }>, "setError" | "run"> & {
    values: { privacy: boolean };
  },
  mode: string,
) {
  try {
    ensureCanLeave(app);
    const privacy = consent(app, f);
    app.confirm(
      mode === "bind" ? "绑定 QQ 到当前账号？" : "使用 QQ 登录账号？",
      mode === "bind"
        ? "绑定保留当前账号的活动、报名和款项，QQ 昵称不会覆盖群内称呼。"
        : app.me.authenticated
          ? "将进入这个 QQ 对应的账号；当前账号分开保留，不自动合并报名或款项。"
          : "将前往 QQ 官方授权，首次登录会创建账号。返回后核对并确认登录。",
      () => startQQ(app, mode, privacy),
      // Closing this layer traverses history and cancels the pending QQ navigation.
      { closeOnSuccess: false },
    );
  } catch (error) {
    f.setError(errorMessage(error));
  }
}
export function AccountView() {
  const app = useBoard(),
    f = useForm({
      privacy: false,
      nickname: "",
      authorize_device: false,
      confirm_close: false,
      deviceLink: "",
    }),
    [info, setInfo] = useState<D.AccountData | null>(null);
  useEffect(() => {
    f.run(async () => {
      const me = await app.api<D.Me>("/api/me");
      app.updateMe(me);
      if (me.authenticated)
        setInfo(await app.api<D.AccountData>("/api/account"));
    });
  }, []);
  const reload = async () =>
    setInfo(await app.api<D.AccountData>("/api/account"));
  const switchAccount = (scope: string) => {
    try {
      ensureCanLeave(app);
      app.confirm(
        "切换账号？",
        "账号与本机草稿分开保留，不合并报名、活动或款项。",
        () =>
          f.run(async () => {
            try {
              await app.api<unknown>("/api/account/switch", "POST", {
                scope,
                operation: uid(),
              });
              location.reload();
            } catch (error) {
              const me = await app.api<D.Me>("/api/me").catch(() => null);
              if (me && me.draft_scope !== app.me.draft_scope)
                location.reload();
              else throw error;
            }
          }),
      );
    } catch (error) {
      f.setError(errorMessage(error));
    }
  };
  return (
    <div className="board-account-view">
      <ErrorMessage error={f.error} />
      {!!f.busy && <Spinner label="正在处理账号" />}
      {!app.me.authenticated ? (
        <>
          <Text>登录后即可发起活动、报名并管理自己的记录。</Text>
          {app.me.qq?.enabled ? (
            <Button
              disabled={f.busy}
              data-identity="qq-login"
              onClick={() => beginQQ(app, f, "login")}
            >
              使用 QQ 登录
            </Button>
          ) : (
            <Text>QQ 登录暂不可用，请稍后重试。</Text>
          )}
          <Text size="sm">首次登录将自动创建账号，登录后可修改群内称呼。</Text>
          <Privacy form={f} />
          {!!app.me.allow_name_registration && (
            <Fold title="使用称呼注册">
              <Text size="sm">
                只创建当前浏览器可用的账号，不能仅凭称呼找回。以后可绑定 QQ。
              </Text>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    const privacy = consent(app, f);
                    app.confirm(
                      "使用这个称呼创建账号？",
                      "请保留当前浏览器，或在账号设置中绑定 QQ，方便以后找回账号。",
                      () =>
                        f.run(async () => {
                          await app.api<unknown>("/api/register", "POST", {
                            nickname: f.values.nickname.trim(),
                            confirm: true,
                            ...privacy,
                          });
                          location.reload();
                        }),
                    );
                  } catch (error) {
                    f.setError(errorMessage(error));
                  }
                }}
              >
                <Field
                  form={f}
                  name="nickname"
                  label="群内称呼"
                  required
                  maxLength={24}
                  autoComplete="nickname"
                />
                <Button type="submit" disabled={f.busy}>
                  创建账号
                </Button>
              </form>
            </Fold>
          )}
        </>
      ) : (
        info && (
          <>
            <Text>当前账号：{app.me.nickname || "未设置称呼"}</Text>
            <Heading level={3}>QQ 账号</Heading>
            {!!info.qq?.bound && (
              <div className="qq-profile">
                <Avatar
                  src={info.qq.avatar_url}
                  name={info.qq.nickname || app.me.nickname}
                />
                <Text>QQ：{info.qq.nickname}</Text>
              </div>
            )}
            {info.qq?.enabled ? (
              <>
                <Text size="sm">
                  {info.qq.bound
                    ? "换设备时，用此 QQ 登录即可。"
                    : "绑定 QQ 可找回当前账号。直接登录将进入该 QQ 对应的账号。"}
                </Text>
                {!!info.qq.bound ? (
                  info.qq.needs_reauth && (
                    <>
                      <Text>资料待更新，bot 暂时无法识别账号。</Text>
                      <Button
                        variant="secondary"
                        onClick={() => app.open("qqReminder")}
                      >
                        重新登录 QQ
                      </Button>
                    </>
                  )
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => beginQQ(app, f, "bind")}
                  >
                    绑定 QQ
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => beginQQ(app, f, "login")}
                >
                  {info.qq.bound ? "换个 QQ 登录" : "使用 QQ 登录"}
                </Button>
              </>
            ) : (
              <Text size="sm">QQ 登录暂不可用，可连接自己的另一台设备。</Text>
            )}
            <Fold title="连接另一台设备">
              <Text size="sm">
                链接有效 10
                分钟、仅限一次。持有者可管理账号与账务，请只发给自己的设备。
              </Text>
              <Check
                form={f}
                name="authorize_device"
                label="只授权自己的另一台设备"
              />
              <Button
                variant="secondary"
                disabled={f.busy}
                onClick={() =>
                  f.run(async () => {
                    if (!f.values.authorize_device)
                      throw new Error("请先确认只连接自己的设备");
                    const result = await app.api<{ link_token: string }>(
                      "/api/account/link",
                      "POST",
                      {
                        authorize_device: true,
                        operation: uid(),
                      },
                    );
                    f.set(
                      "deviceLink",
                      location.origin + "/?account_link=" + result.link_token,
                    );
                  })
                }
              >
                生成限时连接
              </Button>
              {!!f.values.deviceLink && (
                <>
                  <Field
                    form={f}
                    name="deviceLink"
                    label="设备连接，可手动复制"
                    multiline
                    readOnly
                  />
                  <Button
                    variant="ghost"
                    onClick={() => app.copy(f.values.deviceLink, "设备连接")}
                  >
                    复制设备连接
                  </Button>
                </>
              )}
            </Fold>
            <Fold title={"此设备上的账号 · " + info.accounts.length}>
              <Text size="sm">账号分开保留；切换前请暂存并关闭表单。</Text>
              {info.accounts.map((account) => (
                <div className="account-row" key={account.scope}>
                  <Text>
                    {account.nickname || "未设置称呼"} ·{" "}
                    {account.scope.slice(-6)}
                  </Text>
                  {account.current ? (
                    <Text size="sm">当前</Text>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => switchAccount(account.scope)}
                    >
                      切换
                    </Button>
                  )}
                </div>
              ))}
            </Fold>
            <Fold title={"已授权设备 · " + info.devices.length}>
              {info.devices.map((device) => (
                <div className="account-row" key={device.id}>
                  <Text>
                    {device.current
                      ? "当前设备"
                      : "其他设备 · " + device.id.slice(-6)}{" "}
                    · {device.created_at.slice(0, 10)}
                  </Text>
                  {!device.current && (
                    <Button
                      variant="ghost"
                      destructive
                      onClick={() =>
                        app.confirm(
                          "撤销这台设备？",
                          "这台设备将失去当前账号的访问权；它自己的其他账号保留。",
                          () =>
                            f.run(async () => {
                              await app.api<unknown>(
                                "/api/account/revoke",
                                "POST",
                                {
                                  device_id: device.id,
                                  operation: uid(),
                                },
                              );
                              await reload();
                            }),
                        )
                      }
                    >
                      撤销
                    </Button>
                  )}
                </div>
              ))}
            </Fold>
            <Fold title="账号操作记录">
              {info.history.map((row, index) => (
                <Text size="sm" key={index}>
                  {{
                    name_registered: "创建账号",
                    device_link_issued: "生成设备连接",
                    device_link_accepted: "设备已连接",
                    device_revoked: "撤销设备",
                    account_switched: "切换账号",
                    qq_bound: "绑定 QQ",
                    qq_login: "QQ 登录",
                  }[row.action] || row.action}{" "}
                  · {row.created_at}
                </Text>
              ))}
              {!info.history.length && <Text size="sm">暂无记录</Text>}
            </Fold>
            <Privacy form={f} />
            <Fold title="隐私与资料删除">
              <Text size="sm">
                注销会撤销所有设备对本账号的登录权限，移除 QQ
                身份和私人收款码。共用的活动、报名、款项与凭证需进一步核对。请先转交仍由你管理的活动，并核对未结款项。
              </Text>
              <Check
                form={f}
                name="confirm_close"
                label="我了解注销影响，并申请删除账号资料"
              />
              <Button
                variant="ghost"
                destructive
                disabled={f.busy}
                onClick={() => {
                  try {
                    if (!f.values.confirm_close)
                      throw new Error("请先勾选确认注销影响");
                    ensureCanLeave(app);
                    app.confirm(
                      "确认注销账号并申请删除？",
                      "所有设备将失去本账号的访问权限。QQ 再次登录会创建新账号，原记录不会自动找回。涉及共用记录的申请将继续核对。",
                      () =>
                        f.run(async () => {
                          const result = await app.api<D.PrivacyReceiptData>(
                            "/api/auth/close",
                            "POST",
                            { confirm_close: true },
                          );
                          try {
                            sessionStorage.setItem(
                              "kanban-privacy-receipt",
                              JSON.stringify(result),
                            );
                          } catch {}
                          location.replace("/");
                        }),
                    );
                  } catch (error) {
                    f.setError(errorMessage(error));
                  }
                }}
              >
                注销账号并申请删除资料
              </Button>
            </Fold>
            <Button
              variant="secondary"
              disabled={f.busy}
              onClick={() => {
                try {
                  ensureCanLeave(app);
                  app.confirm(
                    "退出当前浏览器？",
                    "当前浏览器中的所有账号授权都会退出，再次使用时请重新登录。共用设备请同时清理网站数据和本机草稿。",
                    () =>
                      f.run(async () => {
                        await app.api<unknown>("/api/auth/logout", "POST", {});
                        location.replace("/");
                      }),
                  );
                } catch (error) {
                  f.setError(errorMessage(error));
                }
              }}
            >
              退出登录
            </Button>
          </>
        )
      )}
    </div>
  );
}
export function ProfileForm({ next }: D.ModalProps["profile"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({ nickname: app.me.nickname || "" }),
    [codes, setCodes] = useState<D.LibraryCode[]>([]),
    p = useForm({ kind: "wechat", code_name: "" }),
    [image, setImage] = useState<string | null>(null),
    [fileKey, setFileKey] = useState(0);
  const initial = useRef(app.me.nickname || "");
  useEffect(() =>
    modal.register({
      busy: f.busy || p.busy,
      dirty: f.values.nickname !== initial.current,
      save: async () => {
        throw new Error("请先保存称呼，或舍弃修改");
      },
      discard: async () => {},
    }),
  );
  const load = () =>
    p.run(async () =>
      setCodes(
        (await app.api<{ codes: D.LibraryCode[] }>("/api/payment-codes")).codes,
      ),
    );
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <form
        id="profile-form"
        onSubmit={(event) => {
          event.preventDefault();
          f.run(async () => {
            const updated = await app.api<D.Me>("/api/profile", "POST", {
              nickname: f.values.nickname.trim(),
            });
            initial.current = f.values.nickname.trim();
            app.updateMe({ ...app.me, ...updated });
            modal.close();
            await app.refresh();
            if (next) next();
            else app.toast("称呼已更新");
          });
        }}
      >
        <Field
          form={f}
          id="nickname-input"
          name="nickname"
          label="群内称呼"
          maxLength={24}
          autoComplete="nickname"
          required
        />
        <ErrorMessage error={f.error} />
        <div className="form-footer">
          <Button type="submit" disabled={f.busy}>
            保存称呼
          </Button>
          <Button variant="ghost" onClick={() => app.open("account")}>
            账号与设备
          </Button>
        </div>
      </form>
      <Fold title={"我的收款码 · " + codes.length}>
        <ErrorMessage error={p.error} />
        <Button variant="ghost" disabled={p.busy} onClick={load}>
          刷新收款码
        </Button>
        <div className="board-code-library">
          {codes.map((code) => (
            <Surface variant="note" key={code.id}>
              <Heading level={4}>
                {codeKinds[code.kind]} · {code.name || "未命名"}
              </Heading>
              <Picture src={code.url} alt={codeKinds[code.kind] + "收款码"} />
              <Button
                variant="ghost"
                destructive
                onClick={() =>
                  app.confirm(
                    "移除这张收款码？",
                    "已发布的结算及历史图片保留。",
                    () =>
                      p.run(async () => {
                        await app.api<unknown>(
                          "/api/payment-codes/" + code.id,
                          "DELETE",
                          {},
                        );
                        setCodes((previous) =>
                          previous.filter((old) => old.id !== code.id),
                        );
                        app.toast("已从个人资料移除");
                      }),
                  )
                }
              >
                移除
              </Button>
            </Surface>
          ))}
        </div>
        {!codes.length && <Text size="sm">还没有收款码，可在下方上传。</Text>}
        <form
          id="payment-library-form"
          onSubmit={(event) => {
            event.preventDefault();
            p.run(async () => {
              if (!image) throw new Error("请选择收款码图片");
              const code = await app.api<D.LibraryCode>(
                "/api/payment-codes",
                "POST",
                {
                  kind: p.values.kind,
                  name: p.values.code_name.trim(),
                  image,
                },
              );
              setCodes((previous) => [
                code,
                ...previous.filter((old) => old.id !== code.id),
              ]);
              setImage(null);
              setFileKey((value) => value + 1);
              p.replace({ kind: "wechat", code_name: "" });
              app.toast("收款码已保存到个人资料");
            });
          }}
        >
          <Field
            form={p}
            name="kind"
            label="收款方式"
            options={Object.entries(codeKinds).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <Field
            form={p}
            name="code_name"
            label="名称（选填）"
            maxLength={40}
          />
          <Input
            key={fileKey}
            label="收款码图片"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            required
            disabled={p.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              setImage(null);
              if (file)
                p.run(async () =>
                  setImage((await prepareCode(file)).split(",")[1]),
                );
            }}
          />
          <Button type="submit" disabled={p.busy || !image}>
            保存收款码
          </Button>
        </form>
      </Fold>
    </>
  );
}
export function QQReminder() {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({ privacy: false });
  useEffect(() => {
    stamp(app);
  }, []);
  return (
    <>
      <div className="qq-profile">
        <Avatar
          src={app.me.qq?.avatar_url}
          name={app.me.qq?.nickname || app.me.nickname || "QQ"}
        />
        <Text>QQ：{app.me.qq?.nickname}</Text>
      </div>
      <Text>bot 暂时无法识别你的账号，请用原 QQ 重新登录。</Text>
      <Text size="sm">稍后处理不影响网站使用。</Text>
      <Privacy form={f} />
      <ErrorMessage error={f.error} />
      <div className="form-footer">
        <Button
          disabled={f.busy}
          onClick={() => {
            let privacy;
            try {
              privacy = consent(app, f);
            } catch (error) {
              f.setError(errorMessage(error));
              return;
            }
            f.run(() => startQQ(app, "bind", privacy, true));
          }}
        >
          重新登录 QQ
        </Button>
        <Button
          variant="ghost"
          data-identity="qq-refresh-later"
          onClick={modal.close}
        >
          稍后处理
        </Button>
      </div>
    </>
  );
}
export function QQReturn() {
  const app = useBoard(),
    f = useForm({ confirm: false, privacy: false }),
    [result, setResult] = useState<D.QQStatus | null>(null);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete("qq");
    history.replaceState(history.state, "", url);
    f.run(async () =>
      setResult(await app.api<D.QQStatus>("/api/auth/qq/status")),
    );
  }, []);
  return (
    <>
      <ErrorMessage error={f.error} />
      {result ? (
        result.status !== "verified" ? (
          <>
            <Text>QQ 授权未完成或已过期，请重新登录。</Text>
            <Button onClick={() => app.open("account")}>返回账号与设备</Button>
          </>
        ) : (
          <>
            <div className="qq-profile">
              <Avatar src={result.avatar_url} name={result.qq_nickname} />
              <Text>QQ：{result.qq_nickname}</Text>
            </div>
            {result.conflict ? (
              <>
                <Alert tone="error">
                  这个 QQ
                  已绑定其他账号，不能绑定到当前账号。原账号与款项分开保留。
                </Alert>
                <Privacy form={f} />
                <Button onClick={() => beginQQ(app, f, "login")}>
                  使用 QQ 登录账号
                </Button>
              </>
            ) : (
              <>
                <Text>
                  {result.mode === "bind"
                    ? "将绑定到当前账号「" +
                      (result.current_nickname || "未设置称呼") +
                      "」，保留现有活动、报名和款项。"
                    : "将登录「" +
                      (result.target_nickname || result.qq_nickname) +
                      "」" +
                      (result.existing_account ? "" : "的新账号") +
                      "。原有账号分开保留，可在账号与设备切换。"}
                </Text>
                <Check
                  form={f}
                  name="confirm"
                  label={
                    "这是我的 QQ，确认" +
                    (result.mode === "bind" ? "绑定当前账号" : "登录此账号")
                  }
                />
                <Button
                  disabled={f.busy}
                  onClick={() =>
                    f.run(async () => {
                      if (!f.values.confirm)
                        throw new Error("请先核对并确认账号操作");
                      ensureCanLeave(app);
                      try {
                        const finished = await app.api<{
                          new_account: boolean;
                          return_path?: string;
                        }>("/api/auth/qq/finish", "POST", {
                          attempt_id: result.attempt_id,
                          confirm: true,
                        });
                        try {
                          const refreshing =
                            result.mode === "bind" &&
                            sessionStorage.getItem(
                              "kanban-qq-refresh-scope",
                            ) === app.me.draft_scope;
                          sessionStorage.setItem(
                            "kanban-qq-authorized",
                            refreshing ? "refresh" : "login",
                          );
                          sessionStorage.removeItem("kanban-qq-refresh-scope");
                          if (finished.new_account)
                            sessionStorage.setItem("kanban-welcome", "1");
                        } catch {}
                        location.replace(finished.return_path || "/");
                      } catch (error) {
                        const me = await app
                          .api<D.Me>("/api/me")
                          .catch(() => null);
                        if (me && me.draft_scope !== app.me.draft_scope)
                          location.replace("/");
                        else throw error;
                      }
                    })
                  }
                >
                  确认{result.mode === "bind" ? "绑定" : "登录"}
                </Button>
              </>
            )}
          </>
        )
      ) : (
        <Spinner label="加载 QQ 授权" />
      )}
    </>
  );
}
export function DeviceView({ token }: D.ModalProps["device"]) {
  const app = useBoard(),
    f = useForm({ accept: false }),
    [info, setInfo] = useState<D.DeviceInfo | null>(null);
  useEffect(() => {
    f.run(async () =>
      setInfo(await app.api<D.DeviceInfo>("/api/account-links/" + token)),
    );
  }, []);
  return (
    <Form
      form={f}
      onSubmit={() =>
        f.run(async () => {
          if (!f.values.accept) throw new Error("请先确认账号归属和授权内容");
          await app.api<unknown>("/api/account/accept", "POST", {
            token,
            accept_access: true,
          });
          const url = new URL(location.href);
          url.searchParams.delete("account_link");
          history.replaceState(history.state, "", url);
          app.open("account");
          app.toast("设备已连接，可选择账号切换");
        })
      }
      footer={info && <Button type="submit">接受设备连接</Button>}
    >
      {info ? (
        <>
          <Text>将「{info.nickname}」账号授权给当前设备。</Text>
          <Text size="sm">
            有效至 {info.expires_at}
            。原有账号、活动与款项分开保留，不自动合并。只有自己的设备之间连接时才接受。
          </Text>
          <Check
            form={f}
            name="accept"
            label="这是我的账号，确认授权当前设备"
            required
          />
        </>
      ) : (
        <Spinner label="加载设备连接" />
      )}
    </Form>
  );
}
export function ClaimView({ eventId, token }: D.ModalProps["claim"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({ person: false, payment: false }),
    [info, setInfo] = useState<D.ClaimInfo | null>(null);
  const load = async () =>
    setInfo(
      await app.api<D.ClaimInfo>(`/api/events/${eventId}/claims/${token}`),
    );
  useEffect(() => {
    f.run(load);
  }, []);
  const existing = () => {
    if (info?.claimed) {
      const url = new URL(location.href);
      url.searchParams.delete("claim");
      history.replaceState(history.state, "", url);
    }
    modal.close();
    app.openDetail(eventId);
  };
  return (
    <Form
      form={f}
      onSubmit={() =>
        app.withProfile(() =>
          f.run(async () => {
            await app.api<D.BoardEvent>(
              `/api/events/${eventId}/claims/${token}/request`,
              "POST",
              {
                base_revision: info!.base_revision,
                confirm_identity: f.values.person,
                keep_payment: f.values.payment,
              },
            );
            await load();
            app.toast("认领申请已提交");
          }),
        )
      }
      footer={
        info &&
        !info.claimed &&
        !info.duplicate &&
        info.claim_status !== "requested" && (
          <Button type="submit">提交认领申请</Button>
        )
      }
    >
      {info ? (
        <>
          <Heading level={3}>{info.title}</Heading>
          {info.claimed ? (
            <>
              <Text>认领已通过，原名额及付款责任保留。</Text>
              <Button onClick={existing}>查看我的报名</Button>
            </>
          ) : (
            <>
              <Text>
                认领「{info.name}」的
                {
                  {
                    confirmed: "正式",
                    waiting: "候补",
                    tentative: "待确认",
                    invited: "待接受邀请",
                    withdrawn: "已退出",
                  }[info.status]
                }
                报名。
              </Text>
              <Text size="sm">
                原名额、排队顺序、已接受的约定和账单均保留。默认付款人：
                {info.payer_name}
                ；认领不转移款项或重算旧账。申请后由原管理人核对。
              </Text>
              {info.duplicate ? (
                <>
                  <Alert tone="warning">
                    你已经有本人报名，不能自动合并。请先核对重复项；已有费用或款项时请和发起者协调。
                  </Alert>
                  <Button onClick={existing}>处理现有报名</Button>
                </>
              ) : info.claim_status === "requested" ? (
                <Alert>
                  {info.requested_by_me
                    ? "申请已提交，等待管理人核对"
                    : "这份邀请已有认领申请，请联系管理人"}
                </Alert>
              ) : (
                <>
                  <Check
                    form={f}
                    name="person"
                    label="这条报名确实是我本人"
                    required
                  />
                  <Check
                    form={f}
                    name="payment"
                    label="已核对并保留原付款责任"
                    required
                  />
                </>
              )}
            </>
          )}
        </>
      ) : (
        <Spinner label="加载认领邀请" />
      )}
    </Form>
  );
}
export function ClaimsSection({ event: e }: D.EventProps) {
  const app = useBoard(),
    claims = e.claim_invitations || [];
  return (
    !!claims.length && (
      <Fold
        title={
          "报名认领 · " + claims.filter((c) => c.can_decide).length + " 待核对"
        }
      >
        {claims.map((c) => (
          <Surface key={c.id} variant="note">
            <Text>
              {c.name} ·{" "}
              {
                {
                  invited: "等待本人申请",
                  requested: "等待管理人核对",
                  approved: "已认领",
                  rejected: "未通过",
                  revoked: "已撤销",
                  expired: "已过期",
                }[c.status]
              }
              {c.requester_name ? " · 申请人 " + c.requester_name : ""}
            </Text>
            {!!c.token && (
              <Button
                variant="ghost"
                onClick={() =>
                  app.copy(
                    location.origin + "/?event=" + e.id + "&claim=" + c.token,
                    "认领链接",
                  )
                }
              >
                复制认领链接
              </Button>
            )}
            {[
              ...(c.token ? ["revoke"] : []),
              ...(c.can_decide ? ["approve", "reject"] : []),
            ].map((action) => (
              <Button
                key={action}
                variant="ghost"
                destructive={action !== "approve"}
                onClick={() =>
                  app.confirm(
                    action === "approve"
                      ? "确认认领人为这位参加者？"
                      : "结束这份认领邀请？",
                    `报名：${c.name}${c.requester_name ? "；申请人：" + c.requester_name : ""}。请通过群内沟通核对身份。原排队、费用责任及历史保留。`,
                    async () => {
                      const updated = await app.api<D.BoardEvent>(
                        `/api/events/${e.id}/claims/${c.id}`,
                        "POST",
                        {
                          base_revision: e.revision,
                          decision: action,
                          confirm_person: true,
                          reason: "管理人核对认领：" + action,
                        },
                      );
                      app.apply(updated);
                      await app.refresh();
                      app.toast("认领处理已保存");
                    },
                  )
                }
              >
                {
                  { revoke: "撤销", approve: "核对并同意", reject: "拒绝" }[
                    action
                  ]
                }
              </Button>
            ))}
          </Surface>
        ))}
      </Fold>
    )
  );
}

export function PrivacyReceipt({ receipt }: D.ModalProps["receipt"]) {
  return (
    <>
      <Text>账号登录身份、QQ 资料及私人收款码已移除。</Text>
      <Text>申请编号：</Text>
      <Text className="receipt-id">{receipt.request_id}</Text>
      <Text>
        {receipt.status === "shared_review"
          ? "共同活动、报名或账务记录仍待核对。请把申请编号发送至下方邮箱，说明希望进一步删除的范围。"
          : "个人账号资料删除已完成。必要处理记录及隔离备份会按隐私政策处理。"}
      </Text>
      <Link href="mailto:203008876@qq.com">203008876@qq.com</Link>
      <Text size="sm">请保存申请编号，便于跟进处理。</Text>
    </>
  );
}
