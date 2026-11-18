# 第七十三批實作：舊成分找回操作持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。未合入 main、未部署，未操作正式資料、憑證、群設定或真實 bot 工作。

## 原找回操作與秘密隔離

沿用 `qgroup:rebuild:music:claim:v1:<scope>`，改由共用 IndexedDB 保存安全指標 `{requestId,legacyQQ,action?:'finish'|'cancel'}`。PIN、摘要、OAuth 權杖與授權證明均不入原稿或保全版本。嚴格 schema 同時用於讀取、session 匯入、寫入、衝突保全與收件匣索引；舊 `{requestId,legacyQQ}` 格式仍可用。

送出 PIN、本次 QQ 授權、確認關聯或取消前，均等待完整本機交易提交。伺服器已接受但本機結果確認交易中止，保留原指標或原 action。明確拒絕的本機確認失敗也保留原編號；查核後需要重新輸入 PIN、勾選用途同意，保留原 QQ／UUID，沒有自動重送 PIN。

新增 GET `/api/v2/music/claim?requestId=<UUID>`，沿用原裝置 cookie 與帳號 scope 的權限，準確查原請求；無參數仍查目前請求。無效、重複或額外參數拒絕。瀏覽器核對 claimId 與舊 QQ，回執不符就保留原紀錄，不替換成另一筆請求或開始其授權。

## 中斷、競爭與恢復

關聯／取消 action 隨原 claimId 保存。重開不自動提交，先核對伺服器；完成或已取消才確認清除本機指標。未送達的 action 只能明確以原 claimId／confirm 重試，不能改成另一種 action。取消與完成競爭時，依伺服器的 completed 結果顯示關聯成功。

原 action 的請求已不存在時，提示先核對我的成分；明確重新查核後才能「結束失效的原操作」，只清除本機指標，不把查無請求視為關聯成功或自動建立新請求。

共用 CAS 保全競爭分頁的不同 QQ／UUID 或 finish／cancel action，競爭頁不送 HTTP。session 來源在 IndexedDB 提交後才移除，交易失敗保留來源。收件匣僅列「找回舊成分」及固定入口，不顯示 QQ、原文或通用會員回執按鈕；找回權限仍由專用 API 核對。

切換帳號重新掛載 scoped 表單，前一帳號的延遲回應不能清除原指標或替新帳號顯示結果。無 BroadcastChannel 的登出仍由持久清除世代阻擋舊頁送出口令，並清空記憶體輸入。訪客經模擬 QQ 登入後沿用後端授權轉移，沒有把舊 scope 指標當成授權證明搬給新帳號。

損壞或夾帶 PIN／proof 的原文不匯入、不寫進版本庫；僅提供原文下載，下載後才可清除來源。清除 session 原文前核對來源未變，清除 durable 原文仍使用 CAS 及清除世代。必要提示保留，未加展示文案。

## Bot 與資料相容性

網站專用查詢新增可選參數；未改 schema、bot 指令、設定、模板、outbox 格式或網站入口。原生測試透過實際 Python bot 的唯讀 probe，核對 PIN、授權、原編號查詢、關聯及完成後取消前後的讀取結果一致；活動、名冊、帳務、結算、bot 設定與 pending／sending／sent／failed／skipped 工作列完全不變。

這些均為隔離 fixture／模擬 QQ 證據，不是正式版本組合或真實 QQ 驗收。

## 驗證與剩餘工作

- `npm run build:rebuild` 與 strict 型別檢查通過，仍有既有 bundle 大小警告。
- 原編號查詢、權限隔離、資料保全、Python bot probe、索引與 PIN schema 測試已通過；管理成分／刪除／隱私／遷移回歸合計 **94 項原生測試通過**。
- 找回新增 **18 項**持久化瀏覽器場景全部通過；既有找回 **7 項**、帳號成分持久化 **19 項**、收件匣 **10 項**交叉回歸全部通過，共 **54 項**，無跳過。最後一輪找回／收件匣 **35 項**在最終建置上全數通過。
- 建置後隔離 API／bot smoke、bot 連結、能力台帳與 diff 檢查通過；360px 異常紀錄保全下載及原文一致性已核對，實際截圖已檢視且無水平溢出。
- 首輪修正測試對非同步畫面、同意框出現時機、交易 mock 不能跨 navigation 保留的假設；另一次預覽服務啟動逾時已重新驗證。PIN 欄位在查核完成後可能消失，斷言驗證所有仍存在的欄位都沒有口令值。

`music-recovery.tsx` 已移除直接 session 保存。`music-rooms.tsx`、含 secret 的隱私／管理刪除證明、短效裝置授權、舊 `kanban-local-v1` 遷移、跨裝置 create intent、完整匯出／恢復、實機與實際 web／bot 版本組合仍待完成。全部 166 項能力保留，維持 in_progress、`release_eligible=false`；依使用者要求先不部署。
