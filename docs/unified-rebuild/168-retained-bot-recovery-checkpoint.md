# 固定舊 bot 的提醒、延後與重試驗收

日期：2026-11-21。變更範圍：`none`；僅隔離演練、CI 與驗收文件。177 個運行來源與兩個 compiled API bytes 相對第 167 號保持相同；不合入 `main`，不部署。

共用網站／舊 bot 演練新增恢復流程。所有通知都由實際編譯網站的 HTTP 業務操作建立，再由固定 Python bot `8da877857f163853c449474e168534e2e493121b` 消費同一個合成 SQLite。除了平台 transport 回應，沒有替換 worker、時鐘、提醒計算或重試實作，也沒有直接插入通知、修改 due／retry／claim 時間。每次呼叫都建立新的原 worker 程序，檢查持久狀態與跨程序恢復。

plain、rich、dry-run 各建立一場報名截止提醒，以網站的 `deadline_hours=1` 規則排程，在原到期時間前確認未送，等待自然到期後核對單次真送模擬或 dry-run 模擬；另一個未到期的預計結束提醒保留原列。勿擾使用實際 UTC 分鐘邊界，發送間隔使用原持久 reservation；延後不增加失敗次數，不影響 54 個公開別名與回呼的即時回覆。

transport 分別提供暫時 503、429、永久拒絕及非同步 202 回應。暫時失敗依原 worker 的 15 秒退避恢復，429 依原 60 秒配額等待恢復；不清除 retry_at。永久失敗由網站授權入口核對後重送，保留原失敗列，新工作從零次失敗開始；重播原 request key／回執不再排第二份工作。202 的未確認狀態保留，worker 不自動重送，網站拒絕直接重送。已送、模擬及失敗歷史在後續政策改動後保持原列。

新增 helper 與原 fixture 都納入 source hashes；雙映像使用相同流程。CI 外層上限從 600 增至 900 秒，以容納自然等待與容器 HTTP 操作；記憶體、swap、CPU、PID、唯讀及網路隔離限制保持原設定。沒有放寬網站限流，429 仍以原 key 等待實際 Retry-After。

第一輪診斷發現演練誤把相同政策的 no-op save 當作新 revision，已改依真實保存回執檢查；第二輪通過投遞恢復流程後，在新增深連結的完整檢查中遇到網站全域 429，已補上依原 Retry-After 等待的 GET 檢查；没有調高網站限流。第三輪完成全部 HTTP 檢查後，發現新增活動各有 16 個不同入口，原數量預期多算了九個入口，已修正總數為 202。這三輪診斷均不列為完整通過證據。最後完整本機演練通過：62 次原 worker 執行、376 次成功 HTTP、一個預期 409 阻擋回應與兩次 429 等待，共 379 次 HTTP；202 個不同連結均開啟成功。獨立 checker 已核對三種提醒模式、四種故障、持久延後／恢復、原重送回執、精確路由分布與整組 counters。自然到期／恢復共等待 270.529 秒，另有原網站限流等待 100 秒。本輪原 Linux CI 尚待完成核對。

第 166 號原完整 CI 已核對：178 檔／2,923 unit、81 檔／843 browser，三個原 artifacts、ZIP／metadata／terminal logs、固定 inventory、55 個原 Python blobs 與 precache bytes／keys 通過。第 167 號雙映像原 artifact `14675706719` 與 run `44828590122` 的 image job 已核對，包括六類活動狀態、投票與結算圖片；其原 unit／browser 在最後觀察時仍執行中，沒有重啟原 jobs。本輪固定預期仍為 178 檔／2,923 unit、81 檔／843 browser。

本次不代表所有提醒、限流、Gateway 連線或 B01–B15 完整驗收；預計結束提醒自然到期、所有身份與群政策、正式待送資料、線上實際版本組合、真實 QQ／WebView 與正式規模資源仍待驗證。來源世代／reset ancestry、停止 capture custody、media／browser pending 與完整 audited activation 尚待完成。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。
