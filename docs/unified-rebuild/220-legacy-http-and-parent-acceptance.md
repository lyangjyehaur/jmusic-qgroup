# 舊版 HTTP 回退操作與父項驗收

2026-11-23。發布範圍 **`none`**：本批只補驗收測試、台帳及文件，沒有修改運行程式，不合併 main、不部署。

使用第 219 批同一份授權隔離副本，來源 manifest SHA256 為 `591a7209bf5ef07b3a79569a4abd411899660acfcf25b24ee1fb9e38098bbd7c`。私人資料、回退產物及原始報告均留在 Git 外。本批沒有重新擷取正式資料、使用正式憑證、啟動投遞者或發送 QQ 消息。

## 實際舊版操作

從固定看板 `83eb54ce94f935a4048aaf63a410206723f09bd8` 與成分站 `be51e065bd0d64a2df3a783ca14672d92ba6d49a` 封存原程式，逐檔核對 Git blob。由原 `Handler` 在本機 loopback HTTP server 接收請求，禁止外網；使用隔離副本中的合成帳號。

- 看板：新增活動、遺失回應後以原 key 查回、修改活動、精確重試、異內容 key 衝突、非發起者拒絕、舊 revision 與未知操作拒絕，以及讀取新版建立的凍結逐人帳單。
- 成分站：保存選擇及程度、留言、聯絡號、發布喊話與冷卻限制；拒絕修改他人成分、缺失 proxy key、空選擇及未知操作。原配對備份流程仍執行。
- 再次 forward：獨立 Python 核對 59 張共用表的欄位型別、值及 rowid，另核對 21 張不應變更的新版專用表。上述實際 HTTP 新寫入保留，原 outbox、bot 設定、凍結帳單與財務列不變；完整性及外鍵通過。原輸入新庫檔案雜湊不變。

此演練使用既有回退投影及 `4fb6bbb86f12e1ef3e3569f1b31ed91573f1eaa1` 的 migration 程式。forward 產物仍要求後續 proof／source rebase／recovery，不是可直接啟動的正式恢復庫。

## 歷史下載、刪除與恢復

以同批 224 檔 v2 套件（manifest `f22cfe4716ed6a4a58586297e7c9da64bd81a567b7912c9cc04a3bea75ed675b`）建立隔離歷史 catalog 與 retained erasure authority。固定原成分站掛載明確的歷史及刪除適配器，沒有替換原業務 Handler。

驗證 30 份封存歷史、每階段 30 份可用原備份與當前匯出，累計 244 次刪除後下載。原管理刪除寫入 authority sequence 1；全部下載均套用最新刪除，不保留被刪會員、建立者引用或喊話。恢復舊資料與身分庫、還原較舊本機 ledger 時匯出回應 503；明確恢復 retained ledger 並執行原 replay 後再次通過。獨立新程序重啟後，sequence 及刪除仍保留，身份關聯與會話沒有復活。

缺失 proxy／管理權、非法 catalog query、未知／穿越名稱均拒絕；另一程序持有 authority 鎖時匯出 503，釋鎖後恢復。原 `backup_pair` 的 30 組保留規則可能輪替最舊普通備份，已按原行為核對 404；封存 catalog 的 30 份歷史仍全部可用。原套件所有檔案大小及雜湊重新核對相符。

測試協調器等待原 HTTP request thread 完成後再直接讀 authority，避免把 response body 已讀完誤當成 handler 已釋鎖。此處只加觀測用 `finish` 通知，沒有改變原 handler、ledger、時間或鎖語意。失敗的協調器嘗試及 stderr 保留；不將它們記為通過。

## C04 完整本機條件

原條件為「跨領域一致；不因切頁重設主題或草稿」。本批逐條核對後將 C04 標記通過：

| 條件 | 直接證據 |
| --- | --- |
| 深／淺／跟隨系統、舊偏好與跨頁／跨分頁一致 | 既有 appearance browser 案例，含系統 media 變化、活動及音樂頁 |
| 未保存成分和活動原稿不受主題變更影響 | 新增 browser 案例：兩個工作頁同時未完成，第三頁依次切深／淺；程度、活動名稱及說明保持原值，兩份 durable rows 重載前後完全相等，API mutation 為零 |
| 儲存損壞／拒寫不覆蓋原偏好，介面仍可操作 | 既有 `failed local preferences` 案例，確認原 raw 保全後才保存 |
| 深色跨領域可讀 | 既有活動成分對話框及音樂控制項實際 computed style 斷言 |

本機四項 browser 測試全部通過，沒有 retry、skip 或 flaky。第一次因手動預覽佔用 5082 而未能啟動 fixture，已保留失敗；停止本任務預覽後四項重新完整執行成功。這是固定原條件的父項審核，不以全套測試數直接推定其他功能通過。165 個其他既有父項及 U01–U03 仍維持原狀態，整體 P6 尚未完成。

## CI 與剩餘界線

`d5363bde9505b5cfb28417a36010ff3415808e30` 的 [CI 45049853048](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/45049853048) 映像工作已成功，原產物已下載並重新核對來源、映像 ID、52 個固定 Python 檔案及 6 個 harness pins。Linux runtime、54 aliases、314 深連結、531 HTTP 呼叫、71 次原 worker 與 9 次 native worker、自然時鐘恢復、逐次消費者交接和清理通過。它是 observed-source 重建映像驗證；第 219 批真正匯出的線上 bot 映像驗證保持獨立。本批新增 browser 案例未包含在此 CI 提交。

完整 unit／browser 工作仍等待終態，不把映像成功當成全部 CI 通過。仍須其餘父項完整審核、回退後刪除的新寫入 forward／proof／source rebase 成套恢復及原 web／music／bot 配合。真 QQ／WebView、外部 custody 與正式停寫切換各按條件記錄；本批不放行正式切換，`originalP6Complete=false`、`releaseEligible=false`。
