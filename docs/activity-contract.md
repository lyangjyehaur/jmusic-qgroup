# P2 活动流程契约

版本：20261108-4，数据库迁移 2，HTTP 写协议仍为 2。P0／P1 的逐人排队、版本及请求去重继续生效。

## 活动状态

`lifecycle`：`draft`／`scheduled`／`ongoing`／`ended`／`cancelled`。`registration_open` 单独控制报名，`archived_at` 单独控制归档。旧 `status` 保留供兼容，不能作为唯一业务判据。

| 操作 | 权限 | 行为 |
| --- | --- | --- |
| 保存草稿 | 发起者；已接受安排权限的协办可编辑 | 仅发起者／协办可见，不占名额；当前要求填完整有效安排 |
| 发布 | 发起者 | 检查将来时间与报名期限；自动为发起者报名（包含旧草稿） |
| 暂停／恢复、开始、结束、编辑 | 发起者／schedule 协办 | 实际开始关闭普通报名；实际结束进入结算，不改计划起讫时间 |
| 成团确认、取消、归档／取消归档 | 发起者 | 不足最低人数确认需原因；取消需原因；仅结束／取消可归档 |
| 编辑结算 | 发起者 | 结束或取消后可结算；归档不删除账务，旧账不重算 |
| 转交／授予权限 | 发起者 | 邀请需接任者明确接受，不自动保留原发起者管理权 |

计划起讫由 `starts_at`／`duration_hours` 决定，到达计划开始后展示进行中；超过计划结束仅标记 `estimated_over`，仍可延长。`actual_started_at`／`actual_ended_at` 只保存实际确认时间。最低人数不足不自动取消。`timezone` 使用 IANA 标识，新活动默认 Asia/Shanghai；未知旧时区保持 null，浏览器按设备显示，不猜测原时区。跨日显示结束日期；表单拒绝夏令时不存在或重复的本地时间。

## 安排与个人同意

`event_conditions` 保存不可修改的版本快照：类别、计划开始、时长、地点、注意事项、有效退出期限、时区、费用规则。有人报名后修改这些项须填写原因，原有正式／候补／待确认参加者标记 pending。名额上限、标题等一般变动仍进入活动记录，不要求重新接受安排。

`attendee_consents` 追加逐人的决定、版本、操作者、时间及原因；`accepted_conditions_version` 保留最后接受版本，`confirmation_state` 为 accepted／pending／declined。只能由本人或原代报管理人逐人操作。拒绝必须填写原因，保留原报名与约定，不自动退出、不默默收取新费用。重新确认仅限未结束／取消／归档活动。

报名、同行预览与受邀接受需要与展示的活动版本一致；有费用规则或安排版本大于 1 时，旧接口缺少明确同意版本会被拒绝。预览、本人报名、受邀接受发生冲突后，须重新展示规则由用户再次提交。

## 管理与出席

`event_roles` 分开保存 schedule（安排／开始结束）、roster（报名）、attendance（出席）权限。现场补录同时需要 roster 与 attendance。费用、退出期限、可见性仍仅发起者可修改；协办没有结算、归档、授予权限及转交权。

`management_invitations` 有效 7 天，可撤销；可绑定已有本人报名的账号，或使用专属持有者链接。后者任何持链接者均可接受，界面明确提醒只发给指定人。接受前不改变角色；转交后旧发起者的未接受邀请失效，旧发起者只保留自己的报名管理权。公开活动记录不含令牌或内部账号 ID；待接受令牌仅当前发起者可取。

`attendance` 独立于名额及账单：unknown／present／absent／late／left，可选填到离场时间（不能在未来、不能离场早于到场）。活动开始后可核对；结束／取消后更正需原因。已发布账单不受出席变更影响。

现场补录在进行中或结束后、首版结算前可用，逐人创建正式、已到场记录。须补录原因及当前规则确认；超上限与绕过候补分别要求明确确认。付款归属只是现有标记，不产生实收记录。

## 接口与事务

所有写操作要求 `X-Kanban-Version: 2`、`Idempotency-Key`，既有活动写入带 `base_revision`；冲突返回 409，不自动重新提交。结算额外带 `base_version`。业务、审计、通知、请求结果在同一事务内提交。

| 接口 | 用途 |
| --- | --- |
| PATCH /api/events/:id | action 为 publish／pause／resume／start／finish／cancel／formation／archive／unarchive；编辑传完整安排 |
| GET /api/events/:id/conditions | 安排历史快照 |
| PATCH /api/events/:id/attendees/:person/conditions | conditions_version、decision、reason |
| POST /api/events/:id/management/invitations | kind、permissions、target_name、可选 attendee_id、reason |
| GET /api/events/:id/management/invitations/:token | 接任者核对责任与当前版本 |
| POST /api/events/:id/management/invitations/:token/accept | accept_responsibility: true |
| DELETE /api/events/:id/management/invitations/:id | 撤销未接受邀请，须 reason |
| DELETE /api/events/:id/management/roles/:id | 撤销协办，须 reason |
| PATCH /api/events/:id/attendance/:person | attendance、attendance_note、arrived_at、left_at、reason |
| POST /api/events/:id/onsite | people、conditions_version、reason、accept_terms、allow_over_capacity、override_waitlist |

P1 已提交请求的丢响应重试不重新执行业务；旧缓存缺少 P2 字段时，在重新核对访问权后返回当前活动视图。兼容旧网页至 2026-12-08 UTC，之后旧写协议要求刷新。

## 数据保全与后续范围

迁移 2 仅添加列、表和安排基线，原有列、名单状态、账单、历史及图片逐值保留。原 finished 或已有结算活动迁为 ended，原取消／删除映射 cancelled；其他旧活动不会因预计结束已过而变成实际结束。未知实际时间、时区留空；旧费用约定留空；既有参加者接受版本记为原安排 1，不创造额外费用。旧 deleted 继续隐藏，新操作使用归档。

`deploy/verify_migration.py` 对源库所有用户表、原有列逐值比较，在隔离副本连续迁移两次并校验外键和完整性。只有 pre-P1 来源才按 registrations 核对派生名册，避免把 P1 后已变化的真实名册还原成旧资料。

P3 已实现逐人、权重与减免及完整结算版本，见 [逐人结算契约](settlement-contract.md)；原人均版本完整保留。P4 已实现预收、实收及退款，见 [收付款契约](finance-contract.md)。QQ OAuth 等待官方审核后按 P6 接入。
