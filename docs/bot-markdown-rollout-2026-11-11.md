# QQ Bot Markdown 與活動序號：設計、範圍與驗收（2026-11-11）

**狀態：設計與本機驗證，尚未 commit、尚未建置、尚未部署。** 本文件不是發布紀錄，
不含任何映像 ID 或發布結果。發布範圍判定見 [deployment-policy.md](deployment-policy.md)。

## 發布範圍：`both`

修改 `qgroup_core/bot_outbox.py`（web 產生 outbox）、`qgroup_core/bot_settings.py`
（共用設定語意）、`public/admin.*`（後台模板）、`qgroup_bot/worker.py`（bot 消費
outbox），跨服務資料契約與設定語意都動到，依規則先按 `both` 評估，且無法證明
只影響單邊。共用核心另新增 `qgroup_core/bot_markdown.py`。

`compose.yaml` 仍讓 web／bot 共用 `QGROUP_TAG`，因此即使設計上可新舊並行，
實際部署仍須成套更新兩個服務並記錄版本組合；不能當成已完成獨立發布設計。

## 資料契約（刻意做成加法，不需 migration）

| 位置 | 變更 | 舊程式讀到時 |
| --- | --- | --- |
| `bot_outbox.payload_json` | 新增可選 `markdown_text`（字串）；`_template_context` 新增 `_label`／`_details_lines`，移除 `_markdown` | 舊 bot 忽略新欄位，照樣送 `text`（msg_type=0） |
| `bot_settings.config.templates` | 新增可選 key `<kind>@md`（寫 Markdown 模板） | 舊 core 的 `read()` 不驗證、可讀；只有管理員**用舊後台按儲存**時，舊 `validate()` 會拒絕這個 key |
| `/api/admin/bot-preview` | 回傳新增 `markdown` 欄位 | 舊前端忽略 |

設定 schema（欄位集合）與資料表 schema 都沒有變動；`defaults()` 不加新欄位。
`both` 仍需成套發布的原因是「舊後台存設定會洗掉／拒絕 `@md`」，不是 payload
格式不相容。過渡期請勿從舊版後台儲存機器人設定。

已存在的待送消息：舊 payload 沒有 `markdown_text`；新 bot 若有
`_template_context` 會在投遞時重算（與純文字模板更新行為一致），沒有則維持純文字。
升級前後的 row 都不需要搬移或回寫。

## 混合版本（本機離線驗證，非實機）

| web | bot | 開關 | 結果 |
| --- | --- | --- | --- |
| 舊 | 舊 | 任意 | 純文字（不變） |
| 舊 | 新 | 0 | 純文字 |
| 舊 | 新 | 1 | 有 `_template_context` 的 row 由新 bot 重算卡片；無則純文字 |
| 新 | 舊 | 任意 | 純文字（舊 bot 忽略 `markdown_text`） |
| 新 | 新 | 0 | 純文字 |
| 新 | 新 | 1 | Markdown；內容檢查失敗自動降級純文字 |

`KANBAN_BOT_MARKDOWN` 同時控制被動 @ 回覆與 14 類主動廣播，**預設 0**。
改 `env_file` 後須 `--force-recreate bot`，單純 restart 不會載入。

## 活動序號

`/活动` 等指令在多場活動時顯示 `1.` `2.` …；使用者直接打 `/名额 2` 即可。
序號解析用與選擇清單相同的 `candidates(db, command)`，因此 `/活动` 看到的第 2 場
就是 `/名额 2` 的第 2 場。8–16 位短碼仍可輸入（向後相容），但不再顯示在清單上，
按鈕 callback 也仍帶完整活動 ID，不受序號變動影響。

被動回覆也全數補齊：`/帮助`、選擇清單、`/活动`＋`/往期`、`/待办` 有專屬卡片，
其餘指令由 `_generic_markdown()` 把既有純文字答案轉成一致版面（標題／粗體活動行／
清單／連結／免責引用），事實來源仍是同一個 `answer()`，不會出現兩種說法。

**限制**：序號是無狀態、每次重新計算的便利值，活動增減或時間推移可能改變排序；
文案已明示「以最近一次清單為準」。財務類／`/往期` 指令的候選集合不同，序號以
**該指令自己**的清單為準。沒有引入跨訊息的選擇狀態或資料庫欄位。

## 安全與合規

- `qgroup_core/bot_markdown.escape_markdown()` 統一處理使用者原文（`* _ [ ] ( ) < > #`、
  換行、控制字元、`://`），系統片段才上格式。
- 送出前檢查 4000 字、控制字元、未報備網域；**keyboard 跳轉按鈕的 URL 也比照白名單**
  （`OutboxWorker._keyboard_problem`）。
- `msg_type=2` 的 body 不帶 `content`（官方要求互斥）。
- 結算逐人明細（顯式 opt-in 的 `group_notice`）在系統卡片與自訂 `@md` 模板都固定附上，
  不會因美化而被省略。
- Markdown 渲染失敗、內容檢查失敗、模板錯誤一律降級純文字；平台回傳 markdown
  拒絕碼只記 log，**不自動重發**，避免重複訊息。

## 已驗證 / 尚未驗證

已驗證（本機）：Python 454 項、前端 JS 11 項、`node --check`、簡繁產物重建
（`npm run build:locales`）、`git diff --check`；序號解析與跨指令一致性、25 個指令
全數產生可用且通過內容檢查的 Markdown、payload 加法相容、開關降級、白名單、
逐人明細保留、管理員 `@md` 模板 escaping。

`test_api.test_concurrent_last_seat_and_promotion` 是既有的併發 HTTP 測試，全套執行
時偶發 `RemoteDisconnected`（本次 3 次全套中 1 次）；單獨執行與全套重跑均通過，
與本次改動無關，未修改該測試。

尚未驗證（須實機）：QQ 對反斜線跳脫與零寬空行的實際渲染、keyboard 搭配
`msg_type=2` 的行為、主動訊息頻控與 `40034105`／`40034011` 等錯誤碼。
正式群目前 `dry_run=false` 且已設為通知目標，**開關開啟前務必先切模擬或只用測試群**。
