# 時間投票身份、狀態與重播驗證

日期：2026-11-22。變更範圍：`none`；實際部署：`none`。只新增驗收測試與文件，沒有修改運行程式、schema、outbox、設定或網址。未整合 main，保留 Python bot。

## 新增驗證

`apps/api/testsupport/time-poll-permission-matrix.test.ts` 獨立宣告身份與預期權限，不用 runtime guard 計算預期結果。8 種身份與開放、關閉、截止、定案、取消、刪除六種狀態組成 48 個交叉案例：發起者、已有選票的會員、擁有活動全部職責的協辦、帳號管理員、無關會員、救援管理員訪客、訪客與未登入者。

每個組合核對公開詳情、管理頁與活動／歷史清單：公開結果保留本人選票及彙總，不向其他身份顯示發起者的逐人回覆、歷史或 bot 投遞資料；協辦與管理員不因此獲得投票發起者權限。訪客可以用相符裝置 scope 查看公開投票，不能投票或管理；救援憑證也不把訪客變成會員。已刪除投票的管理 context 只保留給實際發起者恢復操作。

使用有效 body 檢查七種管理動作與改票的身份／狀態拒絕，斷言具體的 401／403／404／409，不把 `INVALID_INPUT` 當作權限驗證成功。每批讀取及每次拒絕都比對全部使用者資料表。各 fixture 使用自己擁有的 `:memory:` 資料庫、synthetic session 與停用 bot；救援登入亦使用本測試的模擬憑證。

另外 17 個案例檢查：

- 5 種會員可修改自己的選票，其他會員選票保持原樣；相同 UUID 返回原收據，不重複改票，換內容重播則拒絕。
- 發起者可關閉、延長、取消、移除、關閉群同步及定案；各動作只寫入一次，重播保留最小原結果，包括移除後的恢復。
- 上述六種動作完成後移轉所有權，原發起者不能重播或讀取管理 context；新發起者可以讀取。不能靠已保存的收據繞過當前所有權。

## 驗證結果

新增 65 個案例全部通過；連同既有時間投票測試，2 檔／79 個 unit 案例通過。相關 browser 的原 11 個案例一次通過，0 重試、0 跳過；TypeScript strict 通過。固定 inventory 與獨立列出的新案例逐項相同。全站 unit 固定 inventory 現為 193 檔／3,345 個案例，本輪沒有宣稱完整新提交全套通過。

隔離副本先通過 65 個 control 案例，再只移除寫入前的當前發起者檢查。新增移轉後重播案例偵測到應回傳 403 卻回傳 200；保留原預期失敗報告，還原副本並核對全部來源 pins。工作目錄的運行程式從未修改。初次 fixture 在建立 ballot 前插入 votes 而違反外鍵；修正順序後，另發現模擬救援口令太短。兩份 setup 失敗報告保留，最終使用符合既有規則的 fixture，未放寬資料或授權規則。

## 191 原完整 CI 已核對

固定提交 `2ded904f2ed432e309fe618f4d26440ef159ec2e`、原 CI `44920259602` 的 unit、browser、actual Linux image 三個工作全部為 **success**。原 191 檔／3,226 個 unit 與 81 檔／844 個 browser 案例逐項核對，全部一次通過，0 失敗、0 重試／跳過。原 ZIP 的 API digest、大小、CRC 及解包 hashes 相符；契約、145 個生成器輸入與 54 個權限來源 pins 保持固定。PWA 的 84 個資源／1,777,913 bytes 與固定靜態目錄相同。

從明確 191 提交封存重新生成 bot harness、保留 Python source manifest、3 個 bot runtime bundles 與 2 個 browser API pins，均與原產物相符；runtime manifest 的 commit／tree、映像標籤及 Compose 身份一致。原映像配對為 web `sha256:9b56183c8dc3610a9bd6e0b9662b29d798f968a9816f84a917616eeb5a9d9fcd`、Python `sha256:325daeaf83e95831a1da35be1a88aab24df43688b7f8c12571e29b3a44366164`。

原 Python 的 55 個 blobs、71 次原 worker invocation、9 次 native consumer、314 個深連結，以及活動／結算／投票、恢復與交接結果核對通過。image 配對實際有 530 個 HTTP 呼叫；一般 browser 相容性報告有 532 個，包含 2 次限流延後。一般 browser runtime 回報 `development`、沒有內嵌 commit；actual image 回報明確 rehearsal commit／tree，兩者不混用。全部投遞為 synthetic，外部 transport 被拒絕；没有驗收線上 bot 實際版本、真實 QQ 或完整 B01–B15。原 192／193 CI 仍在執行，沒有取消或重跑。

證據：`time-poll-permissions-194/`；原完整 CI 證據保存在 `activity-permissions-191/`。本輪是部分領域權限驗證，`permissionBindingsComplete=false`、`releaseEligible=false`；166 capabilities 仍為 0 fully accepted。完整功能、資料來源世代、UX、bot 實際版本組合及切換／回退驗收繼續進行；依使用者要求，不部署。
