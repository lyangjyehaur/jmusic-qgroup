# 成分身份、私人欄位與本人操作權限

日期：2026-11-22。變更範圍：`none`；實際部署：`none`。只新增驗收測試及文件，沒有修改運行程式、schema、outbox、設定或網址。未整合 main，保留 Python bot。

## 新增驗證

`apps/api/testsupport/music-permission-matrix.test.ts` 新增 80 個獨立預期案例。8 種身份包含本人、以目標為首位一般同好的會員、無關成分會員、空成分管理員、沒有成分的管理員、救援管理員訪客、訪客及未登入者。

32 個「身份 × 私人性別／公開性別／未關聯／已刪除」案例核對本人資料、固定成分卡、原數字別名、目前聯絡 QQ 查詢、兩種比較入口、詞條選擇者及分享投影。聯絡 QQ 供已保存成分的會員查詢；私人性別只供本人讀取，公開性別才供其他符合查看資格的會員讀取。私人留言保留本人與首位一般同好的既有資格，不能以管理員身份取代。管理員沒有成分時同樣不能查看會員成分卡；救援管理員登入不會取得會員身份。

未關聯的成分繼續保留獨立身份及會員可見資料，原帳號另有成分時不再擁有原私人性別。已刪除目標不能透過固定 ID、別名、聯絡 QQ 或比較入口找回；詞條清單也不包含該目標。本人入口只回傳目前帳號的成分；詞條選擇者與分享投影不夾帶私人留言、性別或原始憑證。原來源的舊稱呼、舊聯絡資料、PIN hash 及私人欄位不能覆蓋目前投影或外洩。

24 個「身份 × 欄位／聯絡 QQ／選擇」案例核對外來 profile ID、成功操作重播及另一帳號使用相同 UUID。只有目前本人可以修改原成分；其他帳號、管理員或訪客不能提交目標資料，也不能取得本人回執內容。15 個案例核對原操作與新 UUID 都重新檢查 scope、精確 Origin 及 CSRF。另 9 個案例核對裝置撤權、移除關聯及 ABA 重新關聯後的原回執和舊原稿，原成功回應不能復活前任資格。

每個 fixture 擁有自己的檔案型暫存資料庫，bot 預設停用，沒有開啟正式資料、憑證、群設定或待送工作。全部讀取及拒絕操作比對所有使用者資料表；成功成分操作之外的活動、帳務、通知、身份與 bot 表保持原樣。

## 結果與測試有效性

6 個 unit 檔案／116 個案例通過，包含新增 80 個案例及既有欄位、聯絡資料、同好、分享和詞條選擇者回歸；TypeScript strict 通過。4 個 browser 檔案／39 個原案例一次通過，0 重試、0 跳過。結果逐項對應預先獨立宣告的新案例及既有固定 inventory；完整 unit inventory 現為 196 檔／3,559 個案例，本輪没有宣稱最新提交全套通過。

隔離副本的 80 個 control 案例通過，再分別移除成分卡的私人性別條件、使私人留言資格一律成立。每份 mutation 的 7 個案例抓到私人欄位外洩，另外 73 個案例通過；報告與文字差分保留。兩處來源還原後核對 222 個來源 pins 與工作目錄相符。副本共用已固定的 package dependencies，修改只發生在隔離 API 副本；測試資料庫仍各自擁有。副本初始化時缺少設定與相對依賴的失敗紀錄也保留，不計入通過案例。

## 193 原完整 CI 核對

固定提交 `60061ea19217a1cc3273a1dea3a4d2a022a8640c`、原 CI `44924130685` 的 unit、browser、actual Linux image 三個工作及全部步驟均為 **success**。原 192 檔／3,280 個 unit 案例和 81 檔／844 個 browser 案例全部一次通過，0 失敗、重試或跳過。原 browser ZIP 的 API digest、大小、CRC、97 個解包檔案 hashes 均核對；unit 與 image ZIP 已於前輪核對。

unit 與 browser inventory 完全相符；193 沒有修改 192 的 browser 宣告。原契約仍與固定 191 產物逐位元組相同，145 個生成器輸入與 54 個權限來源 pins 對應精確 193 Git blobs。原 PWA 的 84 個資源／1,777,913 bytes 也相同。

原 browser Python 報告的 55 個原 blobs、harness pins、71 次原 worker invocation、9 次 native consumer、314 個深連結及 532 個 HTTP 呼叫完成獨立核對，包含 2 次實際限流延後。2 個 API runtime pins 由精確 193 archive 重新生成，184 個輸入逐項核對 Git blobs。一般 browser runtime 為 `development`，由 CI 提交及產物 pins 綁定；actual image 的 rehearsal commit／tree 與固定 Python image 配對已於前輪核對。

194 的原 actual image／Python 配對及 runtime manifest 也已獨立核對：3 個 native bundle 的 107 個輸入相符，531 個 HTTP 呼叫包含 1 次限流延後。194–196 的原完整 CI 尚未取得終態；195 的 image 工作已成功，不能因此宣稱整輪通過。沒有取消或重跑原 CI。

證據保存在 `music-permissions-197/`、`participation-permissions-193/` 及 `time-poll-permissions-194/`。全部群投遞仍為 synthetic，外部 transport 被拒絕；沒有驗收線上 bot 實際版本、真實 QQ 或完整 B01–B15。

本輪為部分領域驗收，`permissionBindingsComplete=false`、`releaseEligible=false`，166 capabilities 仍為 0 fully accepted。完整功能、來源世代、UX、bot 實際版本組合及切換／回退驗收持續進行；依使用者要求，不部署。
