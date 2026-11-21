# 個人收款碼與原發布者權限

日期：2026-11-22。變更範圍：`none`；實際部署：`none`。只新增驗收測試及文件，沒有修改運行程式、schema、outbox、設定或網址。未整合 main，保留 Python bot。

## 新增驗證

`apps/api/testsupport/payment-permission-matrix.test.ts` 獨立宣告本帳號與原發布者的預期資格，不使用 runtime guard 計算預期結果。8 種身份包含兩位不同版本的原發布者、擁有所有活動職責的協辦、帳號管理員、無關會員、救援管理員訪客、訪客及未登入者。

16 個「身份 × 個人碼使用／移除狀態」案例核對個人庫清單、原圖片與移除操作：只能取得本帳號的庫及圖片，管理員、協辦與另一個帳號沒有例外。移除後原個人圖片入口回傳 404；新的移除操作不能冒充已完成收據。

32 個「身份 × 公開／邀請活動 × 原版」案例核對歷史來源另存。資格只屬於該版原發布者，不能以目前活動職責、管理員身份或另一個版本的發布資格代替。保留既有差異：活動資產描述須有目前活動查看權；另存本人原先發布的原圖使用有限的原發布者資格。原活動刪除後重新保存與原保存操作重播均受阻；已保存到個人庫的原圖仍由本帳號讀取。

另外 12 個案例核對移除收據、裝置撤權、帳號 scope、精確 Origin 與 CSRF。原帳號可恢复相同移除收據，另一個帳號不能使用該操作 UUID；裝置撤銷後不能重播。輸入 body 均符合既有 schema，精確斷言 401／403／404／409 及對應錯誤碼。

每個 fixture 建立自己擁有的暫存資料庫及圖片目錄，沒有開啟正式資料、憑證、bot 工作或 vault 下的資料庫別名。所有讀取及拒絕操作都比對全部使用者資料表與圖片檔案 inventory／原 bytes 的 SHA-256。另存操作逐位元組核對原 PNG，其他帳號、活動、結算、款項、通知及 bot 表保持原樣；相同 UUID 重播不新增圖片或個人碼。

## 結果與有效性

新增 60 個案例全部通過。连同既有收款碼測試，2 个 unit 檔案／76 個案例通過；TypeScript strict 通過。相關 browser 的 8 個原案例一次通過，0 重試、0 跳過。固定 inventory 與獨立列出的新案例逐項相同；全站 unit 固定 inventory 現為 195 檔／3,479 個案例，本輪沒有宣稱完整新提交全套通過。

隔離副本先通過 60 個 control 案例，再分別使個人圖片查詢的帳號條件失效、移除原發布者檢查。另一帳號讀圖與無關會員另存私人活動原圖的案例，各偵測到應回傳 404／403 卻回傳 200；兩份預期失敗報告保留，副本還原並核對全部來源 pins。工作目錄的運行程式未修改。

## 192 原完整 CI 核對

固定提交 `7b7ef8f33393ba59a8df624609a248d217a0857f`、原 CI `44922094423` 的 unit、browser、actual Linux image 三個工作及全部步驟為 **success**：191 檔／3,226 個 unit 案例、81 檔／844 個 browser 案例全部一次通過，0 失敗、0 重試／跳過。原 ZIP 的 API digest、大小、CRC 及解包 hashes 均核對相符。

unit 固定 inventory 完全相同。browser 固定 inventory 只依明確 192 Git blob 的 AST 更新原 reset 第三個案例的位置（第 28 行改為第 29 行）；ID、名稱及其餘案例保持相同，未依 CI 實際結果反推預期 inventory。原契約與固定 191 產物逐位元組相同，145 個生成器輸入及 54 個權限來源 pins 對應精確 Git blobs；PWA 的 84 個資源／1,777,913 bytes 也保持固定。

原 browser Python 相容性報告的 55 個原 blobs、全部 harness pins、2 個重新生成的 API pins 及 3 個 native bundle pins 已核對；活動／結算／投票、恢復與交接的 71 次原 worker invocation、9 次 native consumer、314 個深連結及 532 個 HTTP 呼叫保持通過。一般 browser runtime 為 `development`、沒有內嵌 commit；其來源由原 CI 提交與產物 pins 綁定。另份 actual image 的明確 rehearsal commit／tree 與 Python image 配對已於 [195](195-settlement-permissions-checkpoint.md) 核對，兩者的版本敘述不混用。

193 的原 image 與 Python 配對也已完成來源／runtime 核對；原 unit 工作 success，192 檔／3,280 個案例及原契約已逐項核對。原 browser 仍在執行，不能宣稱 193 完整 CI 通過。194／195 的原 image 工作 success，unit／browser 仍在執行；沒有取消或重跑任何原 CI。

證據：`payment-permissions-196/`；192／193 原 CI 證據分別保存在 `reset-response-synchronization-192/`、`participation-permissions-193/`。全部投遞仍為 synthetic，外部 transport 被拒絕；沒有驗收線上 bot 實際版本、真實 QQ 或完整 B01–B15。

本輪為部分領域權限驗證，`permissionBindingsComplete=false`、`releaseEligible=false`，166 capabilities 仍為 0 fully accepted。完整功能、資料來源世代、UX、bot 實際版本組合及切換／回退驗收持續進行；依使用者要求，不部署。
