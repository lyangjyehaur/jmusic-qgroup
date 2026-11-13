# Bot 日志排查

日志以 JSON 单行输出，同时写入容器标准错误与持久文件。时间为 UTC（`ts` 带 `+00:00`）；台北时间须加 8 小时。容器部署默认文件在宿主和容器的 `/var/lib/qgroup/bot-logs/bot-events.jsonl`，沿用现有资料挂载，不需增加目录挂载或修改 Compose 的日志驱动。

## 一次回复怎样追查

1. 先按事件发生的时间找到 `message_received` 或 `interaction_received`，记下 `trace_id`。
2. 按相同 `trace_id` 查阅 `command_parsed`、`reply_prepared`、`reply_sending`、`api_request`、`api_result`、`reply_sent`／`reply_failed`。
3. `input_ref` 对照触发消息，`sender_ref`／`group_ref` 对照成员与群，`sent_ref` 对照平台返回的发出消息。引用是原始 ID 的 SHA-256 前 20 位，不打印原始身份。

```sh
# 例：查询台北时间 16:30–16:45，明确指定 +08:00，避免时区误差
docker logs --timestamps \
  --since '2026-11-10T16:30:00+08:00' \
  --until '2026-11-10T16:45:00+08:00' qgroup-bot

# 已知追踪码，查持久日志（包括轮替档）；以有权限的服务账号或 root 执行
rg '这里替换为trace_id' /var/lib/qgroup/bot-logs/bot-events.jsonl*
```

`reply_sent` 表示平台 API 接受了消息，不表示群友已读。`reply_simulated` 表示没有调用发送 API。发送前已经出现 `reply_sending`，但没有结果，说明进程可能在调用期间被终止；不能据此认定已发送或未发送。日志记录发送内容的 `text_chars`、`text_hash`，可以区分不同输出；默认不保留正文。

同一消息可能以两种 QQ 事件送达。`input_ref` 可跨重复事件匹配；平台给出不同消息 ID 时，可用 `fingerprint_ref` 对照原有去重依据。`message_ignored` 的原因包括 `duplicate`、`not_addressed`、`everyone_mention`、`group_not_allowed`、`bot_author`。

## @全体与平台事件

`message_received` 记录事件类型、`mentions_bot`、`mention_count` 与 `mention_everyone`。后者区分 `true`、`false`、`missing` 和 `invalid`，缺少字段不等于否定。不能只根据 `is_you=true` 宣称是单独 @ 机器人；QQ群是否提供明确的 @全体标记须用实际事件确认。

`mentions_everyone` 汇总平台布尔旗标、全体提及 ID（`all`／`everyone`）、消息中的全体提及标记（如 `<qqbot-at-everyone />`）与简繁 `@全体成员`／`@全员` 等文字。识别为 @全体的消息一律忽略，记录 `everyone_mention`，即使同时提及机器人也不回复；不会按发送者的管理员身份放行。两种群消息事件均须有 `is_you`、机器人 ID 或对应提及标记等直接 @ 证据，不能只凭 `GROUP_AT_MESSAGE_CREATE` 事件名称回复。平台若同时省略全体旗标、ID 与标记，又把全体提及标成 `is_you`，仅凭现有字段仍无法区分，需核对实际事件。

`KANBAN_BOT_VERBOSE=1` 额外记录平台事件类型与顶层字段名称，不输出完整 payload。这个设置不会改变是否回复或是否实际发送。

## 主动投递与重试

按 `outbox_id` 查看同一通知的多次尝试，再按每次的 `trace_id` 查 API 调用。`outbox_claimed` 记录通知类型、尝试次数、排程时间与是否回收旧 claim；`outbox_prepared` 记录实际发出内容的摘要。`intent_hash` 是原排队意图的摘要，两者分开记录。

`outbox_state` 中 `state_persisted=false` 表示 claim 已被其他处理作废或接管，该次状态没有回写。`outbox_sent` 仍可能表示 API 已接受；网络调用与数据库写回之间不能保证恰好一次。`outbox_retry_scheduled` 记录失败次数及 `retry_at`，`outbox_failed` 表示已达到重试上限。`outbox_simulated` 不是真实发送。

API 日志记录 HTTP 状态、平台业务错误码、调用次数、耗时与发送消息引用。401／token 过期后的认证重试仍沿用同一个追踪码。异常保留类型及文件／行号／函数调用位置，不输出可能包含凭证的异常正文、HTTP 请求正文或原始错误响应。

## 保存与正文排查开关

- `KANBAN_BOT_LOG_DIR`：默认 SQLite 同目录下的 `bot-logs`。目录在首次创建时为 0700，日志为 0600。
- 固定轮替：目前档加 4 个历史档，每档约 5 MiB，共约 25 MiB。达到上限会删除最旧档；文件不依赖容器存续，也不随数据库备份脚本备份。
- `KANBAN_BOT_LOG_CONTENT=0`：默认不记录正文，只记录指令和文字摘要。
- `KANBAN_BOT_LOG_CONTENT=1`：短期排查用，只记录实际处理的指令与 bot 输出的限长预览。URL、QQ mention、已知 AppSecret 及常见凭证字段会遮罩；预览仍可能有活动内容、称呼或金额。
- `KANBAN_BOT_LOG_CONTENT_LIMIT=500`：每则预览上限，限制在 80–2000 字。

修改环境后执行 `docker compose up -d --force-recreate bot` 载入。新代码须先构建并切换映像，单改环境不会更新程式。普通未 @ 消息即使开启正文模式也不保存正文。

启动后应看到 `logging_ready` 且 `persistent=true`。若目录无法写入，会输出 `log_storage_unavailable` 并保留控制台日志；应核对挂载路径及 qgroupsvc 的写权限。旧版本没有保留的事件无法补回，日志从新版本启动后开始累积。
