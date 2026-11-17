# 第六十九批實作：通知已讀操作持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。本批隨重構分支同步至兩個原始碼遠端；未合入 main、未部署，未接觸正式資料、憑證或 bot 工作。

## 原操作與關頁恢復

收件匣「標為已讀」與最多 100 筆的批量已讀改用共用 IndexedDB 紀錄。沿用 `qgroup:rebuild:notifications-read:v1:<帳號 scope>` key，僅保存原 UUID 及原通知 ID 清單，不保存通知文字、姓名、活動內容或憑證。關頁後重開收件匣會顯示「確認原已讀操作結果」，不自動送出，也不以新載入的通知替換原清單。

已讀操作就在收件匣本頁核對，沒有再加一份重複的全站未完成操作條目。通知的已讀狀態仍與活動待辦分開：標為已讀不會完成安排回覆、款項或其他業務待辦。

## 儲存故障與分頁競爭

送出前等待完整交易完成；put 請求成功後交易 abort 仍不發 HTTP。同步 busy guard 避免同一事件間隙建立兩個操作。伺服器已接受、本機完成交易失敗時保留原 UUID／body；下次只明確重試原操作，既有伺服器回執保留第一次已讀時間。

明確拒絕也先保存本機確認狀態，再清除 pending；保存失敗仍保留原操作。操作開始時清除前次結果，避免把前次成功當作本次結果。

雙分頁以 CAS 保護，另一份擬送命令在衝突時保全，不直接覆蓋已保存命令或發第二筆 HTTP。明確讀取已保存版本後，才可核對原操作；載入保全版本不會自動將其送出。格式損壞的原文可保全下載，不能載入成未經驗證的命令。

舊 session 原紀錄在 IndexedDB 交易提交後才刪除，遷移 abort 留下原來源。依帳號 scope 隔離；登出完成後以持久清除世代阻擋沒有 BroadcastChannel 的舊分頁重新送出或重建紀錄。其他帳號不會取得前一帳號的操作。

## bot 與驗證

通知 API、schema、outbox、bot 指令、模板與政策不變。原生收件匣測試包含既有 Python worker 消費待送卡片一次，以及查詢／已讀不改 bot 或活動業務紀錄；未連線真實 QQ，未啟動正式 worker。

- `npm run build:rebuild`、最終 `npm run typecheck:rebuild` 通過。
- 管理／收件匣相關瀏覽器最終回歸 **120 項全部通過**，包括新增通知持久化 10 項。初輪修正了三項把已完成的 `null` placeholder 當成 pending 的測試斷言，以及一項尚未等登出清除完成就開始舊頁操作的測試時序；修正後完整回歸通過，無跳過項目。
- 收件匣、管理回執及原操作索引原生測試 **29 項通過**；前一批完整原生回歸 94 個檔案、818 項通過，本批未修改 API／bot 執行程式。
- `npm run test:build:rebuild`、`node tests/test_bot_links.js` 通過，使用隔離資料庫與本機模擬傳輸，未投遞真實 QQ。
- `npm run check:capabilities`、`git diff --check` 通過。360px 損壞原稿恢復畫面已視覺檢查，無水平溢出；保全檔下載內容與原文一致。

完整重構仍有其他 mutations、含 secret 的刪除收據、舊 session recovery／`kanban-local-v1` 遷移、跨裝置 create intent、完整匯入／匯出、實體裝置及正式 web／bot 版本組合待驗收。166 項能力未刪減，本批不將全域能力標為 accepted，`release_eligible=false`。依使用者要求先不部署。

本輪重新搜尋確認仍直接依賴 session 紀錄的入口如下，未將它們算作已完成持久化：

| 入口 | 待處理內容 |
| --- | --- |
| `bot-deliveries.tsx` | 按活動／投票權限的原重送命令、管理授權隔離與關頁回執；不可在遷移時觸發真實投遞 |
| `activity-access.tsx` | 私人活動查看邀請的原 UUID／token／目標與接受結果 |
| `music-shouts.tsx` | 找搭子文字原稿與原發布命令，失去成分權限時的隔離 |
| `music-rooms.tsx` | 自由／活動分房草稿、結果與來源 revision 的保全 |
| `music-recovery.tsx` | 找回操作編號與目前 QQ 授權狀態，PIN 不可持久保存 |
| `my-privacy.tsx`、`admin-music-erasure.tsx` | 含收據 secret 的刪除／重置證明須專門設計，不可直接加入一般原稿白名單或版本庫 |
| `devices.tsx` | 短效裝置授權 token 的生命週期與恢復；不可當作一般表單原稿保存 |
