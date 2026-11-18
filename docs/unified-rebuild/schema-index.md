# 合成空庫資料表索引

自核准程式基線在臨時目錄建立，不含正式資料；看板初始化連續執行兩次。來源與限制見 [程式盤點](05-source-audit.md)。

## 看板業務庫

| 表 | 欄位 |
| --- | --- |
| `account_audit` | `id`、`user_id`、`action`、`details_json`、`created_at` |
| `admin_audit` | `id`、`action`、`before_value`、`after_value`、`created_at` |
| `admin_role_history` | `id`、`user_id`、`actor_ref`、`before_value`、`after_value`、`revision`、`created_at` |
| `admin_sessions` | `token_hash`、`credential_hash`、`expires_at`、`created_at` |
| `admin_user_metadata` | `user_id`、`note`、`manual_qq`、`revision`、`updated_at`、`updated_by` |
| `attendee_claims` | `id`、`event_id`、`attendee_id`、`token`、`issuer_id`、`requester_id`、`status`、`expires_at`、`created_at`、`decided_at` |
| `attendee_consents` | `id`、`attendee_id`、`event_id`、`version`、`decision`、`actor_id`、`actor_name`、`reason`、`created_at` |
| `attendee_payment_origins` | `attendee_id`、`payer_id`、`payer_name`、`claimant_owns`、`payer_user_id` |
| `attendees` | `seq`、`id`、`event_id`、`manager_id`、`user_id`、`party_id`、`name`、`note`、`payer_kind`、`status`、`withdrawal_requested`、`withdrawal_reason`、`invitation_token`、`legacy_registration_id`、`created_at`、`updated_at`、`accepted_conditions_version`、`confirmation_state`、`attendance`、`attendance_note`、`arrived_at`、`left_at` |
| `auth_requests` | `token_hash`、`request_key`、`signature`、`response_json`、`created_at` |
| `bot_group_ignores` | `id`、`group_id`、`reason`、`created_at` |
| `bot_groups` | `group_id`、`first_seen`、`last_seen`、`last_event`、`membership` |
| `bot_outbox` | `id`、`event_id`、`poll_id`、`kind`、`dedupe_key`、`channel`、`target`、`payload_json`、`due_at`、`status`、`attempts`、`last_error`、`claimed_at`、`created_at`、`sent_at`、`retry_at`、`simulated_at`、`delivered_payload_json`、`claim_token`、`recipient_user_id` |
| `bot_runtime` | `id`、`applied_revision`、`checked_at`、`last_attempt_at`、`deployment_group` |
| `bot_settings` | `id`、`revision`、`config_json`、`updated_at` |
| `bot_settings_history` | `revision`、`config_json`、`created_at`、`actor_ref`、`action` |
| `browser_accounts` | `token_hash`、`user_id`、`created_at` |
| `browser_sessions` | `token_hash`、`user_id`、`created_at` |
| `device_links` | `id`、`token`、`user_id`、`status`、`expires_at`、`created_at`、`used_by` |
| `event_access` | `event_id`、`user_id`、`created_at` |
| `event_audit` | `id`、`event_id`、`version`、`actor_id`、`actor_name`、`action`、`before_json`、`after_json`、`reason`、`created_at` |
| `event_conditions` | `event_id`、`version`、`snapshot_json`、`summary`、`actor_name`、`created_at` |
| `event_roles` | `id`、`event_id`、`user_id`、`permissions_json`、`created_at` |
| `event_room_plans` | `event_id`、`version`、`snapshot_json`、`created_at` |
| `events` | `id`、`owner_id`、`title`、`category`、`location`、`starts_at`、`deadline`、`capacity`、`description`、`status`、`created_at`、`duration_hours`、`revision`、`withdrawal_deadline`、`visibility`、`invite_token`、`lifecycle`、`registration_open`、`actual_started_at`、`actual_ended_at`、`archived_at`、`timezone`、`minimum_participants`、`formation_state`、`conditions_version`、`change_summary`、`cancellation_reason`、`fee_policy`、`draft_join_owner`、`bot_enabled` |
| `external_identities` | `provider`、`client_id`、`subject`、`user_id`、`display_name`、`created_at` |
| `external_profiles` | `provider`、`client_id`、`user_id`、`avatar_url` |
| `external_unionids` | `provider`、`client_id`、`subject`、`union_id`、`created_at` |
| `finance_entries` | `seq`、`id`、`event_id`、`kind`、`payload_json`、`occurred_at`、`actor_id`、`actor_name`、`created_at`、`source_report_id`、`reversal_of` |
| `finance_report_actions` | `seq`、`event_id`、`report_id`、`decision`、`actor_id`、`actor_name`、`reason`、`created_at` |
| `finance_reports` | `seq`、`id`、`event_id`、`reporter_id`、`reporter_name`、`payload_json`、`created_at` |
| `image_assets` | `digest`、`size`、`mime`、`created_at` |
| `login_attempts` | `id`、`token_hash`、`user_id`、`provider`、`app_id`、`mode`、`status`、`expires_at`、`created_at`、`openid`、`nickname`、`return_path`、`privacy_version`、`avatar_url`、`union_id` |
| `management_invitations` | `id`、`event_id`、`token`、`kind`、`target_name`、`recipient_id`、`permissions_json`、`status`、`initiator_id`、`accepted_by`、`created_at`、`expires_at`、`accepted_at` |
| `notifications` | `id`、`user_id`、`event_id`、`kind`、`message`、`created_at`、`read_at` |
| `privacy_consents` | `user_id`、`version`、`accepted_at` |
| `privacy_requests` | `id`、`user_id`、`status`、`created_at`、`updated_at`、`note` |
| `qq_accounts` | `app_id`、`openid`、`user_id`、`nickname`、`created_at` |
| `qq_attempts` | `id`、`token_hash`、`user_id`、`app_id`、`mode`、`status`、`expires_at`、`created_at`、`openid`、`nickname` |
| `registrations` | `id`、`event_id`、`user_id`、`note`、`created_at` |
| `request_results` | `user_id`、`request_key`、`signature`、`response_json`、`response_status`、`created_at` |
| `roster_parties` | `seq`、`id`、`event_id`、`manager_id`、`queue_mode`、`created_at` |
| `schema_migrations` | `version`、`applied_at` |
| `settlement_code_images` | `event_id`、`version`、`kind`、`name`、`digest` |
| `settlement_details` | `event_id`、`version`、`snapshot_json` |
| `settlement_history` | `id`、`event_id`、`version`、`total_cents`、`headcount`、`note`、`qr_image`、`updated_at`、`actor_id`、`actor_name`、`kind`、`changed_fields` |
| `settlement_receipt_images` | `event_id`、`version`、`item_id`、`digest` |
| `settlement_receipts` | `event_id`、`version`、`item_id`、`image` |
| `settlements` | `event_id`、`total_cents`、`headcount`、`qr_image`、`updated_at`、`note` |
| `site_settings` | `id`、`allow_name_registration`、`revision` |
| `time_poll_ballots` | `poll_id`、`user_id`、`updated_at` |
| `time_poll_history` | `id`、`poll_id`、`actor_id`、`action`、`details_json`、`created_at` |
| `time_poll_options` | `id`、`poll_id`、`position`、`starts_at` |
| `time_poll_votes` | `poll_id`、`user_id`、`option_id`、`choice` |
| `time_polls` | `id`、`owner_id`、`title`、`category`、`location`、`description`、`timezone`、`duration_hours`、`capacity`、`minimum_participants`、`fee_policy`、`deadline`、`status`、`revision`、`vote_revision`、`created_at`、`decided_at`、`selected_option_id`、`event_id`、`reason`、`result_json`、`respondent_count`、`bot_enabled`、`time_mode` |
| `user_admin_roles` | `user_id`、`is_admin`、`revision`、`updated_at` |
| `user_payment_codes` | `id`、`user_id`、`kind`、`name`、`digest`、`created_at`、`archived_at` |
| `users` | `id`、`token_hash`、`nickname`、`created_at` |
| `visitor_sessions` | `token_hash`、`expires_at`、`created_at` |

完整性：`ok`；外鍵違規：0。

## 成分身分庫

| 表 | 欄位 |
| --- | --- |
| `entry_intents` | `token_hash`、`qq`、`source_session`、`target_user_id`、`payload`、`expires` |
| `link_audit` | `id`、`qq`、`actor`、`before_user_id`、`after_user_id`、`created` |
| `link_overrides` | `qq`、`user_id`、`revision`、`updated` |
| `links` | `qq`、`app_id`、`openid`、`user_id`、`created`、`source` |
| `login_attempts` | `bucket`、`created` |
| `native_profiles` | `qq`、`payload` |
| `prelinks` | `qq`、`user_id`、`created` |
| `profile_contacts` | `qq`、`number`、`updated` |
| `sessions` | `token_hash`、`qq`、`expires`、`source_session`、`pending_until` |
| `used_oauth` | `attempt`、`created` |

完整性：`ok`；外鍵違規：0。

## 重構 schema 15 新增的同意紀錄

以上為凍結舊系統索引。重構庫目前有 96 張表（59 相容＋37 重構／遷移），本次在 schema 14 加入兩張表，保留舊 `privacy_consents`，不推定或移轉新同意。詳見[檢查點 95](95-unified-privacy-checkpoint.md)。

| 表 | 欄位與用途 |
| --- | --- |
| `unified_privacy_consents` | `user_id`、`version` 組合主鍵；`accepted_at` 首次時間、`source` 明確確認／名稱註冊／QQ |
| `unified_privacy_receipts` | `user_id`、`request_key` 組合主鍵；`version`、`signature`，關聯原同意版本，供原操作查回 |

關閉帳號時由 `privacy_requests` 新增 trigger 清除這兩張表的該帳號紀錄；TypeScript 與舊 Python 刪除流程均有合成驗證。服務啟動不自動升級，舊 schema 14 TypeScript 映像也不接受 schema 15 庫。
