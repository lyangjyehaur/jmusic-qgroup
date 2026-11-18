# 第七十八批實作：活動／投票建立識別與原 React 草稿辨識

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只操作本機隔離 fixture、瀏覽器 context 與 mock QQ；未合入 main、未部署，未操作正式資料、憑證或 bot 待送工作。

## 同一原稿只建立一次

新增可選 UUID 建立識別：活動 `clientIntent`、時間投票 `client_intent`。新版空白表單產生並隨本機原稿保存，送出前與 payload／請求 UUID 一起嚴格提交；恢復、網路重試、明確拒絕與後續編輯維持同一建立識別。早期未帶此欄位的原稿與 pending payload 保持可讀，不修改已存在的待確認請求；活動在下一次新建送出前補存識別，投票在明確恢復並解除鎖定後補存。

服務端沿用原 `request_results`，沒有新增 schema。以原協議 `sha256('create '+intent)`／`sha256('create time-poll '+intent)` 建立持久別名；別名和業務資料、追加稽核、請求 UUID 回執在同一 immediate transaction 提交。不同請求 UUID、相同建立識別與相同內容只取得既有結果；內容變更回傳 `CREATE_INTENT_RESOLVED`，不建立第二筆、不覆寫既有結果。

Python 原回執若已存在，保持其 signature 與 response 原文不動。新版只重新檢查目前實體、身份與權限，再提供目前入口；不把原 Python signature 改成新版 signature，也不從「舊草稿仍在」推導另建活動／投票。活動較新安排與版本保留；投票重試只讀目前版本，不重跑建立或 bot hook。

被刪除、找不到或已移轉權限的原目標拒絕查詢／新建，不將其當成 missing。未知或損壞原結果拒絕辨識。相同 UUID 在另一帳號仍只查該帳號的別名，不能用建立識別取走別人的資料。

## 原結果查詢與本機保留

新增只讀 POST `/api/v2/me/create-intents/view`，要求會員、account scope、同 origin、CSRF 與限流。只回傳 missing 或目前的 kind／ID／revision／入口／可編輯狀態，不提供凍結的 owner、邀請 token、名冊、款項或原 response。

活動與投票新建頁可明確查詢原建立識別。查到原活動連向目前草稿／安排；查到原投票連向原投票並提示建立後不能改寫候選。本機後續編輯與操作原稿不會因此清除、重送、轉換或自動導頁。服務端拒絕另建時保留編輯，解除已明確拒絕的 pending；尚未確認的網路結果仍按既有精確 payload／UUID 恢復。

查不到回執明確提示不能據此認定未建立。查詢前後重新取得目前 session，並核對掛載時的本機 device epoch；切帳號、登出、換稿世代或卸載頁面後，延遲結果不能回到舊稿畫面。沒有 BroadcastChannel、登出後又登入同帳號也不能只靠相同 scope 放行；新增合成世代清除測試，不宣稱它是真實 QQ 重登入驗收。

共用 reviewed draft 的損壞原稿保全也改為載入實際已提交的替代稿：避免重新呼叫空白表單產生器，使畫面建立識別與儲存庫識別分岔。原損壞內容先進版本保全庫，替代稿 strict commit 後才解鎖；新增測試比較原結果查詢實際送出的 UUID 與保存的 UUID。

## 補齊目前舊看板的 React 格式

原看板 `ui/board/primitives.tsx` 的 `useDraft` 目前保存 `{react:1,value:capture,revision}`；檢查點 83 的欄位格式辨識不足以顯示這些原稿。本批補齊活動／複製活動、時間投票、包廂、結算與款項的原 React 結構，保留原 value、外層 revision（含明確 undefined）、候選順序、建立識別、款項固定 ID 與圖片版本引用；仍支援更早的 fields／dataset 格式。

活動內嵌 ID 必須與原 form key 一致。原編輯缺 ID 或指向其他活動時保持未知及阻擋狀態，不錯誤導向新建。不能辨識的 React 版本／結構保留原快照，不轉換。

保全頁顯示原 React 表單資料；不生成新候選、不套目前預設值、不重基準版本。活動／投票新建草稿即使沒有原 request row，也可用保存的有效 UUID 查原建立結果。查詢前後重新驗證來源快照與本機 epoch；舊分頁已改寫來源時保全兩份、拒絕繼續用舊快照查詢。憑證隔離與不可匯出規則維持。

## bot 與隔離驗證

沒有改動 Python bot、TypeScript worker、schema、outbox 格式、模板、QQ 指令或網址。活動仍只建立未發布草稿，沒有名冊、條件或群通知副作用；投票相同建立識別不重跑通知 hook。別名失敗時整筆交易回滾，包含投票候選、history 與已排入的 mock bot outbox。

- strict TypeScript、React／API／bot build 通過；既有 bundle 大小警告仍存在。
- 建立識別／原稿辨識、原回執、活動草稿、時間投票、身份 bot、活動 bot、管理 bot、隱私與 worker outbox **89 項原生測試通過**。含 Python 原 signature 差分、相同 intent 不同 UUID、後续編輯、刪除／移轉、跨帳號、CSRF、損壞回執及完整交易回滾。
- 活動／投票、財務／結算／包廂、音樂詞條、共用原稿、登入／隱私、原保全与新建立識別共 **97 項瀏覽器場景驗證通過**。擴大回歸 96 項全數通過後，新增本機登出世代場景；最終受影響的建立識別 5 項與原保全 14 項重跑均通過。最早的小範圍測試曾有 1 項定位誤判：投票成功前 `/time-polls/new` 也符合泛用路徑 regex；已改成等待 16 位原 ID。沒有跳過測試或修改服務限流。
- 建置後隔離 API、bounded room worker、bot HTTP／WebSocket／ACK／Resume／原生 runtime／停機及備份 smoke 通過，沒有正式 worker 或真實 QQ 投遞。
- 360px 原 React 草稿／建立結果保全頁人工檢視通過，無水平溢出；僅保留欄位、資料、操作與必要提示。截圖 `test-results/unified-legacy-react-mobile.png` 為合成資料，測試重跑會清除此目錄。

## 仍待完成

本批完成持久建立別名、原結果綁定與目前原 React 草稿辨識，**尚未開放逐欄位轉換**。原 `kanban-local-v1` 保留，相關原稿／原請求繼續阻擋新版編輯入口，不宣稱已完成完整本機遷移。

下一批須將活動／投票兩種原格式轉為正式目的表單，保留原 IANA 時區／跨日／DST 歧義、版本與後續編輯。缺時區、未完成時間、未知欄位不得套目前預設；需明確補齊或維持保全。既有活動須核對原目的與目前版本再採用；既有投票不能從後續草稿重建。目標原稿 strict commit、可重試的來源映射、競爭／待確認目的稿處理、轉換後再檢查原來源與登出 epoch 均須驗證。

包廂、結算、款項、原非建立命令的精確 adapter、特殊身份／授權入口、匯出重新匯入、實機／QQ WebView、實際候選 web／bot 組合、完整對帳與新寫入回退仍未驗收。166 項能力維持 `in_progress`，`release_eligible=false`；完整重構目標持續進行，依使用者要求不部署。
