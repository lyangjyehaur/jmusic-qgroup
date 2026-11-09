# 非 QQ 收尾驗收（20261108-8）

自動測試在隔離臨時資料庫執行；正式活動不寫入演示資料。以下列出計畫十二個案例的可重跑證據；有些案例跨越多個專項測試，並非宣稱每項都另跑過一場真人活動。

| 計畫案例 | 驗證證據 |
| --- | --- |
| 1. 發起者不參加、代報兩人、其一認領 | `test_identity` 建立此配置；`test_only_manager_invites_and_explicit_double_confirmation_preserves_place`、`test_claim_after_invoicing_keeps_every_money_row_and_person_payer`。另以兩個獨立瀏覽器身分走完申請、補稱呼、核對、查看本人報名；原兩位仍占兩位。 |
| 2. 部分候補、整組、退出遞補 | `test_roster` 的 partial_waitlist、together_waitlist、adding_guests、promotions；`test_identity.test_waiting_claim_preserves_queue_and_together_waitlist_requires_coordination`。 |
| 3. 改安排／費用後接受、拒絕、未確認 | `test_activity_flow` 的 important_changes、conditions_response、legacy_and_stale_pages；`test_settlements` 的 absence_pending_and_withdrawn、accepted_arrangements。新舊約定分開保留。 |
| 4. 跨日延長、遲到早退、現場加入 | `test_dates.js`、`test_activity_flow` 的 elapsed_planned_end、attendance_is_separate、onsite_addition；`test_settlements.test_fixed_weights_duration_and_multiple_items` 核對時長分攤。 |
| 5. 個人消費、免 A、半份、逐項精確對平 | `test_settlements` 的 seven_seats、exempt_still_pays、half_share_rounding、fixed_weights_duration、largest_remainders。 |
| 6. 預收後取消、訂金損失、退押金、退款／報銷 | `test_finance.test_cancel_with_prepay_deposit_loss_and_return_closes_balanced` 完整核對後結清；deposit_return_and_partial_cancellation_loss、payer_advance_reimbursement 補足個人墊付路徑。 |
| 7. 已收款後改帳或付款人 | `test_finance` 的 prepaid_changes、payer_change_preserves_credit、removed_invoice_payer；`test_identity` 凍結認領前後所有金流及圖片資料，duplicate_with_prepayment 保留原款項。 |
| 8. 並行搶位、改帳、斷線重試 | `test_roster` 的 concurrent_previews、idempotency；`test_settlements` 的 competing_writes、identical_request_retry；`test_finance` 的 concurrent_report_confirmation、refund_retry；`test_client.js` 檢查丟失回應查回及 A→B→A 新操作。前輪瀏覽器斷線代理驗收見 P5 發版紀錄。 |
| 9. 轉交與協辦權限 | `test_activity_flow` 的 transfer_requires_recipient_acceptance、attendance_cohost、schedule_cohost；`test_finance` 的 cohost_cannot_confirm_and_transfer_does_not_move_cash。 |
| 10. 歸檔後錯帳更正及重新對平 | `test_finance.test_archived_closed_invoice_correction_retains_history_and_reconciles` 保留舊版、產生第二版、補收與補登消費後再結清；`test_settlements` 的 cancelled_archived_bill_can_be_corrected。 |
| 11. 私有活動與圖片直接接口 | `test_roster` 的 invitation_visibility、private_payment_images；`test_settlements` 的 private_receipts；`test_identity.test_private_link_preview_and_request_do_not_grant_event_or_images`。 |
| 12. 隔離備份恢復 | `test_identity.test_backup_restore_preserves_all_versions_images_cash_and_refunds` 以實際 HTTP 從還原庫讀圖片與餘額，逐值比對所有表；裝置切換／撤銷後重跑遷移保全。正式備份另用 `deploy/verify_migration.py` 遷移兩次並核對所有既有欄位、圖片 bytes、完整性與外鍵。 |

## 手機與介面

- 桌面瀏覽器 1280px：裝置連接、不自動合併、明確切換；管理人發邀請、另一身分補稱呼後申請、管理人核對通過、本人接管管理入口。無 console 錯誤。
- 360×800 真正 CSS 視口：使用僅本機的 iframe 排版測試架（確認 document.clientWidth=360、scrollWidth=360）。25 人長名單可操作末位；認領後本人入口正確且仍為兩人，沒有橫向溢出。
- 兩倍字體壓力測試：僅測試代理把 CSS 字體放大兩倍，確認 360px、不橫溢。修正長標題壓縮內容的問題，資訊、名單及底部各可捲動；可進入第 25 位報名的管理表單。這是排版壓力測試，不等於手機系統大字體真機驗收。
- 測試架、放大字體代理只綁本機回環，未部署；正式 CSP 與禁止嵌入保護保持原設定。
- 圖片：`releases/identity-mobile.png`、`releases/long-roster-mobile.png`、`releases/large-type-mobile.png`；為實際測試 frame 的 360×800 裁圖。

## 仍需真實手機確認的相容性

目前無可操作的真實手機，以下明確保留為實機驗收項，不阻塞非 QQ 功能發布，也不算已通過：

1. QQ 內建瀏覽器開站，填寫日期／時間，鍵盤彈出時輸入欄與保存按鈕能捲到；關閉鍵盤後高度恢復。
2. 在自己的測試活動輸入草稿，按手機返回，暫存再打開，核對文字與圖片；刷新後恢復。
3. 複製活動／認領連結；若系統阻擋剪貼簿，可在文字框手動選取複製，貼到自己的備忘錄核對完整網址。
4. 打開自己有權限的收款碼，確認長按；不能辨識時用「查看原圖／保存原圖」退路。下載、返回後活動仍可用。
5. 手機系統字體設較大，核對長標題、帳單和名單仍可捲動，重要操作可到達。

以上請在自有測試活動或可寫測試環境執行；不要向正式帳本登記假款項。QQ OAuth 另待審核後接入；官方群自動通知另取決於官方權限，站內通知與人工摘要已可用。
