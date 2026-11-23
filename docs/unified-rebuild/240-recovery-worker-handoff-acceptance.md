# 恢復副本的實際 bot 交接驗收

更新：2026-11-23。發布範圍：`none`。本批沒有修改運行程式、正式資料或服務，也沒有發送 QQ；不單獨宣告 P6 完成。

驗證沿用[第 237 批](237-admin-and-recovery-acceptance.md)的啟用副本，使用[第 236 批](236-bot-parent-acceptance.md)固定的新網站映像與已保存的正式 Python bot 映像。私有成功輪為第 240 批 `run6`，包括完整終態、容器設定、HTTP／worker 結果及獨立 Python 對帳；原資料、群識別與消息原文不納入 Git。

- 20 次 worker 執行、43 次 HTTP、七種交接通過：Python → TypeScript／TypeScript → Python 的暫時失敗重試、不確定投遞、模擬投遞，以及 15 秒持久化限流。使用自然時鐘，不修改原 due／retry／claim 時間。
- 原 118 筆工作中兩筆已到期提醒，在兩個隔離克隆明確執行模擬 transport；原 Python 與新版各 claim 2／sent 2，消息內容一致。這是隔離確認結果，不是真實 QQ 投遞。兩筆原未來提醒、107 筆已送與七筆不確定工作原樣保留；到期工作的原意圖、payload、target、due／created 保留。
- 不確定工作既不自動重送，也不能以管理重試繞過；已確認投遞不重播，模擬紀錄不能轉成真送。原群列表與排程保持不變；其他驗證設定最後透過 API 恢復原值。
- 已保存 Python 映像的實際 `main.main()` 與新版 `.rebuild-dist/bot/start.mjs` 都啟動並正常停止，各一次受控確認。只替換低階 HTTP／WebSocket transport；沒有連接外部平台。
- 獨立對帳：97 表 schema、integrity／外鍵通過；排除實際操作的 bot 三表及 SQLite sequence 後，93 表的全部原 rowid／storage class／值保持不變。六個原 bot 外部檔案的 bytes 與奈秒 mtime 保全，所有原輸入不變。

保存的正式 Python 映像沒有 `qgroup_bot.ownership`，不會參與新版的 OS 排他鎖。本輪 controller 嚴格循序啟動它；新版 worker 持有實際鎖。更換 worker 必須先停止舊 bot、確認它退出，再啟動新版，不能假設兩者並行受到鎖保護。

前五輪 helper 失敗保留，涉及誤假定舊映像具有鎖、測試 keyboard 預設與身份欄位，以及改群／停排程會依法取消提醒的錯誤測試安排。成功輪保持原群與排程，沒有放寬產品規則。

完整舊站回退、原 HTTP 新寫入與再次恢復的連續驗證另見[第 241 批](241-complete-local-acceptance.md)。
