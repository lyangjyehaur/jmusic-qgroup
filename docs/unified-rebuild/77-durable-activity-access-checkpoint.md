# 第七十一批實作：活動查看邀請操作持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。未合入 main、未部署，未接觸正式資料、憑證、群設定或 bot 工作。

## 原邀請與接受操作

私人活動查看邀請改用共用 IndexedDB 紀錄，保留原 `qgroup:rebuild:activity-draft:access:v1:<帳號 scope>:<活動 ID>:<token>` key 及 `{key,input:{revision,confirm:true}}` 格式。接受前等待完整交易提交，關閉分頁後能從收件匣「活動查看邀請」回原活動與 token 路由。

收件匣只顯示操作類別，回執查詢使用成員 `/me/operations/:key`；不顯示活動地點、原 input、revision 或任意儲存的 URL。原邀請 token 仍只位於原業務路由／scoped key，不會當作通用 API 憑證。允許包含冒號／斜線的原活動 ID，導航時完整編碼；無效 token、dot segments、過長 ID、錯誤 scope 及不可編碼字串不加入索引。

重新載入或從收件匣進入不會自動接受邀請。使用者明確「確認原邀請操作結果」時，沿原 token 路徑以相同 UUID／revision／body 重新提交，由既有伺服器去重並重新核對 token 與目前查看權限。已有回執且活動 revision 更新時回原結果；未送達且 revision 已過期時拒絕原命令，清除確認勾選，重新核對及同意後才可建立新命令。

接受仍只寫入 `event_access` 與回執，不報名、不授管理權、不修改名冊、帳本、稽核或 outbox。API／schema／bot 契約不變。

## 故障、撤權與分頁保全

- put 成功後整筆交易 abort 不發授權 HTTP。接受成功或明確拒絕後，本機確認交易失敗會保留原命令，避免把未完成確認當作可建立新 UUID。
- 429 限流與未知結果保留原命令，不再直接刪除；回執活動 ID 不符也保留原命令並提示核對。
- 雙分頁 CAS 衝突保全兩份 UUID，另一頁不發 HTTP。讀取或載入保全版本不自動提交，重設舊提示／完成狀態與確認。
- 舊 session 在 durable 遷移交易完成後才刪除，abort 留下來源。損壞原文可保全／下載，不能視為有效命令送出。
- 401／403／帳號變更隱藏邀請內容並阻擋操作，保留原帳號紀錄。其他帳號不取得前一帳號命令；舊帳號的延遲成功回應不能清除原紀錄或替新帳號顯示成功。
- 登出完成後以持久清除世代阻擋舊分頁提交，即使沒有 BroadcastChannel。重新核對邀請時清除同意，查詢期間禁止接受。

## 隔離驗證

- `npm run build:rebuild`、最終 `npm run typecheck:rebuild` 通過；仍有既有前端大 chunk 警告。
- 新增持久化場景 **16 項通過**，含上述故障／競爭／限流／帳號切換與下載。原查看邀請及舊入口 **10 項通過**。最終查看邀請／舊入口／收件匣／群通知交叉回歸 **51 項全部通過**，包含上述 26 項場景，無失敗或跳過項目。
- 原命令索引及活動查看 API **26 項通過**；既有舊導航 **52 項通過**，直接交叉核對 Python bot 產生的深連結，不依賴人工列出的路徑。
- API 測試逐表確認查看預覽無寫入，接受只改 grant／回執；已接受後的 revision 變更可去重，但撤銷 grant／token、刪除活動或變草稿不能靠舊回執旁路。
- 建置 smoke 與 `node tests/test_bot_links.js` 通過；本機隔離 API／TS bot 模擬傳輸、ACK／Resume、投遞所有權等既有行為正常，未連線真實 QQ、未啟動正式 worker。
- 360px 保全下載畫面已視覺檢查，無水平溢出；下載原文與損壞原稿一致。`npm run check:capabilities` 與 `git diff --check` 通過。

76 號的群通知原命令及本批查看邀請均已移除直接 session 保存。重新搜尋的剩餘入口是 `music-shouts.tsx`、`music-rooms.tsx`、`music-recovery.tsx`、含 secret 的 `my-privacy.tsx`／`admin-music-erasure.tsx`，以及短效裝置 token；`admin-music-pin.tsx` 保留的是既有異常含 PIN 原文的專用下載／清除流程，不應直接入一般版本庫。舊 `kanban-local-v1` 同源遷移、跨裝置 create intent、完整匯出／恢復、實機及實際 web／bot 版本組合仍待完成。

166 項能力全部保留，狀態仍為 in_progress，`release_eligible=false`。本批不代表全重構驗收完成或可正式切換；依使用者要求先不部署。
