# 網站工作在 Python／TypeScript worker 間交接

日期：2026-11-21。變更範圍：`none`；僅隔離演練、驗收 oracle 與文件。177 個運行來源、兩個 compiled API bytes、測試來源與固定 inventory 相對第 168 號保持相同；不合入 `main`，不部署。

原演練由固定 Python bot 消費新網站的業務工作。本次新增 TypeScript consumer adapter，僅載入實際 `.rebuild-dist/api/database.mjs`、`bot/transport.mjs` 與 `bot/outbox.mjs`，不匯入或重打包原始 TS 實作。fixture 校驗同一個合成資料庫的路徑，拒絕 HTTP／Gateway transport，記錄三個實際 runtime hashes 並在每次執行後再核對。平台僅提供受控成功、503 或 202 回應；202 保留實際 API 回傳的 `_unconfirmed_http` 語意。

所有工作仍由實際編譯網站 HTTP 操作建立。七種順序交接涵蓋：Python 失敗後由 TypeScript 恢復、反向恢復；兩邊各自的未確認 202 工作交給另一邊仍不重播，網站也拒絕直接重送；兩邊各自的 dry-run 工作切回 live 後交給另一邊仍保留原模擬列；TypeScript 尊重 Python 持久發送間隔，再等待原時間送出下一張卡。重試保留同一工作 ID、原 payload／created_at 及一次失敗，領取 token 改用新值；已確認、模擬與未確認列，以及十四列未到期提醒保持原資料。

這是受控、順序執行的 library consumer 驗證：每次子程序結束後才交給下一個 consumer，沒有兩個投遞者同時工作。沒有驗證未更新 Python binary 是否採用新 OS 鎖，也沒有啟動正式 runtime 切換，不宣稱正式交接或全 B01–B15 已完成。

局部除錯入口 `node tools/rebuild/smoke-retained-python.mjs --handoff-only` 已通過：9 次固定原 Python worker、9 次實際 compiled TS worker、47 次 HTTP，七種流程和 native runtime hashes 核對完成。該報告明確標示 `fullScenarioVerified=false`，不取代預設完整流程或 CI；完整流程仍跑原通知／報名／退出、六類狀態、結算圖片、投票、到期提醒及所有恢復與交接場景。

初次完整開發演練因 native 202 回應缺少原 API 標記而主動停止並修正，沒有將停止記成通過。第一份局部演練在單側回覆 bytes 比對失敗，診斷保留；原 fixture 的回覆 oracle 已改成在 dispatch 前後分別由原函式計算，僅接受這兩份完整原 bytes，避免跨分鐘倒數失配。不凍結時間、刪除倒數或接受任意文字，鍵盤與被動訊息 ID／seq／外層 event ID 仍逐項驗證。

第 168 號 run `44834692167` 的實際雙映像已獨立核對，原 image artifact `14678680770`、來源與 55 個原 Python blobs、原日誌、62 次原 worker、提醒／恢復 counters、precache bytes／keys 均通過。其 browser job 在 Playwright 前的 retained Python 發送間隔恢復失敗：帶小數 retry_at 會排序在整秒 claimant 時間之後，原等待只加 250ms，可能還領不到工作。原 artifact `14677038753`、失敗日誌與 metadata 保留，實際執行 browser cases 為零。等待現改為跨過下一整秒，仍遵守原儲存時間，不清除／改寫 retry_at，不改正式 worker。該原 job 沒有重啟；unit 在最後觀察時仍執行中。

第 167 號 run `44828590122` 的原完整 CI 已獨立核對：178 檔／2,923 unit、81 檔／843 browser，固定 inventory 全數一次通過；三個原 artifacts、ZIP／metadata／terminal logs、擴充領域 counters、55 個原 Python blobs、precache bytes／keys 均通過。

本輪完整本機演練通過，獨立 oracle 核對 71 次固定原 Python worker、9 次 compiled TS worker、527 次成功 HTTP、三個預期 409 與兩次限流等待，共 532 次 HTTP；314 個不同連結均開啟成功。精確路由分布為 288 個活動操作、19 個活動入口及七個通用／投票入口；七類交接自然等待 45.101 秒，另有網站限流等待 45 秒。完整流程保留所有既有領域及提醒恢復檢查，不以局部報告取代。CI 的 native fixture 單檔唯讀掛載並比對容器內 SHA，三個 runtime bundle 從實際 web image 載入，不把驗證 helper 加入運行映像。自己的原 Linux CI 尚待核對。正式待送／重試／不確定工作對帳、線上實際版本組合、全部 bot 功能、QQ／WebView、正式規模資源、來源世代／reset ancestry、停止 capture custody、media／browser pending 與完整 audited activation 仍未完成。166 capabilities 為 0 fully accepted，`releaseEligible=false`。
