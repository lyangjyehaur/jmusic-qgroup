# Bot Markdown 審查修正（2026-11-11）

狀態：本機修正與離線驗證，尚未發布。

## 發布範圍：`both`

web 的 outbox 組裝／後台預覽與 bot 的投遞都會使用修正後的共用 renderer；
另調整 bot 的錯誤分類、URL 白名單與被動回覆退路。因此按 `both` 規劃，
沒有以本機測試取代正式部署與版本組合驗證。

## 修正行為

- Markdown 的明確拒絕碼列為永久失敗，保留拒絕日誌，停止自動重試。
  網路／平台暫時錯誤、頻控與非同步回應仍沿用各自的處理流程。
- 結算 `group_notice` 原已包含於 frozen `details`／`_details_lines`，
  Markdown 組裝時先移除該完整明細區塊，再集中附加一次。
  系統卡片、使用 `{details}` 的模板與省略 `{details}` 的模板都保留明細；
  純文字原文與已儲存的 context 不改動。
- 模板讀到舊 context 缺少 `previous_starts_at` 時使用空字串，
  不拋出 `KeyError`，也不讀取活動的新狀態冒充排隊當時的事實。
- HTTP／HTTPS 協定採不區分大小寫的 URL 檢查，Markdown、主動純文字、
  跳轉按鈕及被動純文字退路共用同一個白名單判斷。
  含未報備網域的被動純文字回覆會停止發送並記錄
  `reply_skipped`／`unreported_link_host`，避免 Markdown 降級後繞過檢查。
  未設定 `KANBAN_BOT_ALLOWED_HOSTS` 時仍不啟用網域限制。

## 相容性與驗證邊界

沒有新增 migration、設定欄位或 outbox payload 欄位，也不回寫既有待送內容。
測試涵蓋舊 context、缺少 `_details_lines` 的格式、模板更新後重新投遞，
以及 2／20 人長姓名結算卡的系統／自訂模板。舊程式仍能讀取相同資料格式，
但不會自動獲得本次修正。

所有投遞測試使用暫存資料庫和模擬 QQ API；未發送真實群訊息，
未進行正式機操作，也未宣稱完成新版 QQ 用戶端畫面驗收。

## 本機檢查

- Python bot 相關測試：180 項通過。
- 完整 Python 測試：`KANBAN_BOT_ENABLED=0`／`1` 各 466 項通過。
- 前端 Node 測試：11 項通過。
- `python3 deploy/build_guide.py`、`npm run build:locales` 完成，生成檔無差異。
- Python 語法編譯與 `git diff --check` 通過。
