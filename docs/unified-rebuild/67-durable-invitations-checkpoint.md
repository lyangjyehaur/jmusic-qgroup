# 第六十一批實作：邀請、認領與管理分工原稿持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只修改原生前端、本機原稿及隔離瀏覽器測試；不修改 API、schema、outbox、bot 指令、政策、模板或既有入口。保留 Python bot；未推送、未合入 main、未部署，未操作正式資料、憑證、群設定或真實待送工作。

## 本批範圍

下列既有流程改接 `useDurableRecord` 與共用 IndexedDB，保留原表單格式、對象 ID、revision、原 UUID 與原請求內容：

- 補報名邀請：批次建立、本人接受、候補及目前安排確認。
- 代報認領：建立邀請、本人申請、管理人通過／拒絕／撤銷；原付款責任、隊位、同意及身分移轉規則不變。
- 管理分工：協辦、指定結算人、發起者交接、撤銷邀請／職責及本人接受；帳號綁定與權限取代規則不變。

送出前以同步 busy guard 防止連點，等待 pending 的完整本機交易提交；`put` 成功但交易 abort 仍不送出 HTTP。保存期間卸載也不發出操作。拒絕結果須保存清除 pending 的新狀態後才解鎖；伺服器接受而本機確認失敗時保留原操作，可由新分頁收件匣明確查回。

未送出的原稿須明確恢復。勾選確認、本人核對、付款責任接受、候補接受及職責承擔不持久化，恢復／載入保全版本時重置；已送出的 pending 保留原命令中的確認，只用於原操作重試。離站等待保存，衝突保留兩個版本並提供載入／下載，損壞內容保全後才能繼續。

認領的 `person` 深連結在非同步原稿載入時處理：乾淨表單帶入原穩定對象；既有輸入保留。移除原 mount effect，避免載入時覆蓋舊稿或漏掉預選。

## 邀請連結與身分隔離

三類 token 是特定活動的能力連結，不是登入憑證。管理分工連結可能授予職責，因此不可任意擴大持久儲存白名單。本批僅允許帳號 scope、活動 ID 與對應模式：`invitations:issue/accept:<32字元token>`、`claims:manage/request:<token>`、`delegation:manage/accept:<token>`。不批量複製 sessionStorage；PIN、OAuth／救援憑證、裝置 token 及隱私收據 secret 仍排除。

token 保留在原稿 key／原始目的路由，供一次性連結已消耗時回到原表單核對結果。收件匣顯示類型與狀態，不把 token 或請求內容顯示成文字；連結本身保留原目的地。保全檔只下載原 payload，沒有把 key 額外加入 payload。資料仍屬同源瀏覽器本機儲存，非加密保險庫；成功後的空狀態與保全版本遵循既有本機保留機制，登出／帳號清除沿用 scope 與世代隔離，不宣稱已實作自動過期清理。

所有接受／申請仍須登入、CSRF 與帳號 scope，後端重新檢查權限、綁定對象、期限、安排及基準 revision。重試使用原操作編號、原 body 及原 token 路由，沒有自動接受或把新帳號同意套用至舊操作。這次未修改後端驗權規則。

## 驗證

新增 `durable-invitations.spec.ts`：八種命令由關頁後的新分頁收件匣，以原路由／UUID／body 查回，確認伺服器名單與 revision 不重複變更；三類未完成表單的內容／版本及重新確認；乾淨認領原稿接受新的 person 預選；雙分頁認領衝突與保全版本載入後重新核對身分；已接受管理邀請的本機確認交易 abort；邀請遭拒但本機清除 pending 交易 abort 後仍可查回原操作。

既有邀請／認領／分工測試改用真實 IndexedDB 交易 abort、持久損壞原稿保全及登出後原稿／版本清除斷言，不再以 sessionStorage 故障替代持久交易失敗。

最終驗證：

- `npm run build:rebuild`：嚴格型別、原生前端及 API／bot 產物建置通過。
- 瀏覽器回歸 **208 項通過**：`durable-invitations.spec.ts` 的 **15 個新增情境**、`activity-invitations.spec.ts`、`activity-claims.spec.ts`、`activity-delegation.spec.ts`，及檢查點 66 記錄的 166 項回歸集。
- 360px 認領衝突／保全版本畫面無水平溢出；已檢查截圖、重新確認及恢復操作入口。
- `npm run test:rebuild`：**93 檔／805 項通過**。
- `python3 -m unittest discover -s tests -p 'test_bot_*.py'`：**311 項通過**；`test_time_poll_bot.py`：**15 項通過**。
- `node tests/test_bot_links.js`：三語 bot 網頁入口檢查通過。
- `npm run test:build:rebuild`：建置後 API／bot 空庫、mock HTTP／WebSocket、ACK／Resume、投遞所有權、原生 CLI 與復原阻擋 smoke 通過。
- `npm run check:capabilities`：166 IDs 保留、0 fully accepted、release eligible false；`git diff --check` 通過。

瀏覽器與原生全套依序執行，均使用隔離資料與模擬平台；不代表真實 QQ、實際裝置或正式 web／bot 版本組合已驗收。

O04／O05 仍為 `in_progress`，166 項能力無整體 accepted，`release_eligible=false`。剩餘包括帳號／成分／管理表單、原 `kanban-local-v1` 同源遷移（先查舊 pending 結果、保全原 client intent／版本／圖片）、完整匯入／匯出、跨裝置 create intent、實際裝置及正式切換組合驗收。本批不構成全站完成或切換核准。
