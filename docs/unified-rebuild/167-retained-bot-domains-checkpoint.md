# 固定舊 bot 的跨領域網站流程驗收

日期：2026-11-21。變更範圍：`none`；僅隔離演練、CI 與驗收文件。網站／bot 的運行產物沒有改動，不合入 `main`，不部署。

原雙映像流程只涵蓋網站發布、報名與退出遞補。本次擴充共用演練，仍從實際編譯網站的 HTTP API 建立業務，再讓固定原 Python bot `8da877857f163853c449474e168534e2e493121b` 消費已提交 outbox。沒有換用工作目錄的 Python 實作，也沒有直接插入通知來代替網站操作。僅替換平台 transport，檔案上傳回應提供原協議的 `file_info`；新 socket 除預先建立的 event-loop plumbing 外全部拒絕。

plain、rich、dry-run 各跑發布／報名／退出遞補，以及暫停、恢復、確認成團、開始、結束、取消六类通知。結算透過實際 preview／save 保存 1,003 分帳單與微信、支付寶、其他三種原 PNG；固定舊 worker 消費一張文字卡及三張圖片卡，核對原 version、種類、上傳 bytes 與結果。投票由網站建立、投票並重播原操作；投票通知保持 `poll_id`，不錯綁活動。所有業務重播保留原 request key／回執，不新增 outbox；歸檔／取消歸檔與投票 ballot 不廣播；取消後舊提醒工作保留為 skipped。先前已送／模擬工作在政策變更後保持原列，dry-run 歷史不轉成真送。原 54 別名、READY／RESUMED、回呼 ACK／去重／外層 event ID、群與私人身分限制也在每次 worker fixture 中執行。

最後本機完整報告通過：43 次原 worker 執行、184 次成功 HTTP、一次有 `Retry-After` 的限流等待，共 185 次 HTTP；新增領域涵蓋 18 張狀態通知、12 張結算卡、6 次模擬平台原圖上傳及 3 張投票卡。plain／rich 各 17 次 outbox mock transport，dry-run 為零；另有原 handler 的被動回覆 mock。58 個不同連結逐一同 origin 開啟並驗證 SPA；固定路由分布為 48 個活動操作、3 個活動入口、1 個隱私、1 個聯絡、2 個通用操作與 3 個投票入口。獨立 checker 核對模式、領域 counters、原 receipt、圖片／金額、精確路由分布及來源 hashes；不以成功退出碼代替整組核對。

初次組裝的重複變數、錯誤 item ID 格式、未處理的實際 429 與舊連結預期數均保留為診斷。最後演練依實際 `Retry-After` 做有上限的等待，保留相同方法、本文與 key；沒有調高網站限流。雙映像演練總時間上限從 300 增至 600 秒，原容器的記憶體、swap、CPU、PID、唯讀及網路隔離限制不變。這是驗證流程的時間限制，不是正式資源驗收或自動發布保障。

型別、語法與 capability 檢查通過。相對第 166 號，177 個運行來源與兩個 compiled API hashes 保持相同；沒有 schema、outbox、設定語意或 bot 深連結契約改動。第 165 號 run `44818399039` 的原完整 CI 已獨立核對：177 檔／2,900 unit、81 檔／843 browser，全數通過；原三個 artifacts、ZIP／metadata／terminal logs、固定 inventory、實際双映像、55 個原 Python blobs 與 precache bytes／keys 均核對。第 166 號實際双映像原證據已核對，unit／browser 在最後觀察時仍執行中。沒有重啟原 jobs。本輪完整 CI 固定預期仍為 178 檔／2,923 unit、81 檔／843 browser，須核對自己的原 run 與擴充後雙映像結果。

這次補足固定歷史 bot＋編譯網站的更多領域流程，沒有取得線上 bot 的實際版本、真實 QQ／WebView、全 B01–B15、提醒到期與全部失敗／恢復場景、正式資料與資源／完整切換的驗收。來源世代、全部 reset ancestry、停止 capture custody、media／browser pending 與 audited activation 仍待完成。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。
