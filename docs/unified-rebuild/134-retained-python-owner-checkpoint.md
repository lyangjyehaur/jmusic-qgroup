# 固定舊 Python、已建置網站與投遞鎖檢查點

日期：2026-11-20。發布範圍 **`none`**；運行變更影響 **`bot`**，修改 TS／保留 Python 的投遞 ownership 防護，沒有更動指令、設定契約、schema、網站入口或 API。其餘新增是隔離驗證工具與 CI。沒有部署、合入 main、使用正式憑證或處理真實待送工作。

## 原 Python 與已建置網站

`smoke-retained-python.mjs` 從明確的原盤點提交 `8da877857f163853c449474e168534e2e493121b` 封存 `qgroup_core/` 與 `qgroup_bot/`，逐份核對全部 55 個 Git blobs。測試只從此私人副本匯入 Python 模組；不把重構分支上的 Python 修改當成原版本證據，也不宣稱這個 SHA 是目前正式 bot 的實際版本。

網站使用 `.rebuild-dist/api/start.mjs` 啟動的真 HTTP 程序及已建置 database bundle。只建立兩個合成帳號與全新 SQLite，不匯入正式資料或測試用 API implementation。網站的運行回報是 `source=development`、commit／tree 為 null；證據另外保存 bundle SHA，不能把本機 bundle 假稱為 production image 或帶來源 label 的正式服務。

從實際 HTTP 完成救援管理登入、三次 bot 模板版本更新、活動建立／發布、部分正式與候補報名、退出與遞補。原 Python `OutboxWorker` 直接讀取同一份正在運行的網站資料庫，分別以文字、Markdown、模擬模式消費工作。Python socket transport 被拒絕，唯一 `api.post` 是 process-local Mock；沒有 gateway、token 或 QQ 投遞。

每種模式驗證發布一則、報名一則、退出及遞補合併一則；重新 poll 無工作。私人成員通知保持 skipped／no binding，不轉發給群，私人備註不進群卡片。重試原發布 request ID／body 只取得原回執，不新增 outbox；未來兩種提醒的所有欄位不變。模板版本套用到 Python runtime revision，後續設定變更不改寫已投遞 rows。最後改為實際發送設定，再用文字 worker poll，先前模擬工作仍不重送。

原 Python 每種模式解析及執行 54 個非縮寫別名的文字／Markdown 查詢，保留個人身份未綁定限制；54 不包含另有 upstream fixture 的縮寫別名。從原查詢、鍵盤及投遞內容取得的 52 個 loopback 舊連結都返回新版 React shell。這裡只證明 HTTP 入口可用，逐一 action／登入後操作仍依完整瀏覽器測試驗收。

測試後重驗原 Python 來源、fixture 與兩個 native bundles 未變，SIGTERM exit 0 並清除合成資料。CI 在已建置網站的獨立 browser job 加入這份測試，先抓取固定原提交；結果 JSON 納入原有私人 artifact。新的 CI 執行尚須取得完整結果，不能以本機通過代替 Linux 或实际 image＋Python 組合。

## 投遞鎖別名修正

原 TS／Python owner factory 對既有 `.bot-owner.sqlite3` 使用 raw open／fstat／close，之後才以 SQLite 取得排他鎖。如果同一程序持有的 inode 被硬連結或移到另一個 owner path，拒絕前的 close 可能解除原 POSIX record lock；單獨測「第二個 constructor 拋例外」不能證明原鎖仍有效。

現在既有 owner 及其 journal／WAL／SHM 側檔只以 lstat 核對類型、唯一連結及 inode，owner 必須保有 0600。既有檔案不另開 raw descriptor、不 chmod。只以 O_EXCL 新建立的 inode 可使用 raw descriptor；遇到另一程序已建立檔案時，改為重新讀 metadata。程序內同時保留 source／owner inode reservation，拒絕不同 path 的同一活躍 inode；失敗與關閉移除自己的 reservation，不刪除持久鎖檔。Python 的建立、關閉新 descriptor 及 inode reservation 共用 thread guard。

新增六項案例（ownership 全檔共 12 項）：四種硬連結 owner／側檔、一個重新命名的 owner，以及 Python 的完整別名／raw-open 檢查。拒絕後移除測試別名，再由獨立 Python 程序嘗試 SQLite 排他鎖，必須仍被原 owner 阻擋。Python 測試額外令 raw os.open 拋例外，證明既有／被拒絕的 inode 不走 raw descriptor。原 TS＋Python 互斥、crash 恢復、SIGTERM／executor 完成前持鎖、sending 原紀錄保留等案例繼續驗證。

## 證據與剩餘驗收

私人開發證據保存於 `/Users/danersaka/.codex/rebuild-verification/linux-133-1f69b629055740a4b68e155951e2c7a7/`：`final-retained-python.json`、`final-bot-tests.json`、ownership regression、strict、完整 build 及隔離 smoke。提交後須核對 fixture／原始碼 Git blobs 與兩個遠端 SHA，並取得包含這次 bot 修正的完整 Linux 測試和新映像；第 132／133 號來源的舊映像不包含本次 ownership 修正。

strict、完整 build、隔離 build smoke 及完整 13 檔／129 項 bot 測試通過，零 failed／pending。12 個 server runtime bundles 中只有 bot runtime.mjs／start.mjs 改變；API、database、分房 worker 與其餘 7 個 bot bundles 保持相同。新 TS／Python guard 保持既有排他鎖的路徑和 SQLite 語意，不啟動第二個投遞者、不自動核對或重播 uncertain 工作。原 Python bot 保留，完整 B01–B15、實際固定 web＋Python／TS 映像組合、實機 QQ、裝置與正式規模尚未完全驗收。

166 項能力仍 `in_progress`，0 項 accepted，`release_eligible=false`。完整刪除／重設世代、來源 ancestry／custody／高水位、私人歷史 latest-erasure、媒體／browser pending／proof、真正停寫 capture 與 audited activation 等原剩餘範圍繼續保留。不部署。
