# 原生重置私人關係的來源邊界

日期：2026-11-21。變更範圍：`none`；僅離線驗證工具與測試。保留 Python bot，不合入 `main`，不部署。

詞條關係的核對仍不足以保護成分下的私人資料：舊 reset 的 tombstone 完全相同時，原修復仍接受後來新增的聯絡資料、歷史、認領證據或來源文件，並按舊 profile ID 清除。新增唯讀邊界，在 raw input、全站修復與獨立全站候選核對的首次 writer 之前，檢查實際會被私人 replay 刪除或覆寫的關係。

建立資料、舊成分投影、聯絡與欄位、各類私人歷史、認領、選擇、建立詞條關係、留言作者與留言，必須對應固定重置前副本中的原 primary key、rowid、欄位內容與 SQLite storage classes。舊 alias 下的 identity、profile／retirement 文件與 creator 來源也檢查原位置和 opaque bytes。新 alias、來源位置或關係拒絕，不用成分 tombstone 推斷世代。

原保存操作的 receipt 必須保留原 profile 綁定；把相同 user／request key 改指向後來成分不能避過核對。保存結果與原認領登入只接受重置前或已驗證完成副本的完整原 row；一般登入不納入刪除 scope。profile／identity mapping 保留原 provenance，只允許原狀態與已知 erasure 狀態。primary key 用精確 BigInt 編碼，identity mapping 使用原十進位 key，沒有 JavaScript 數值轉換；JSON scope 只以唯讀 SQLite 查詢辨識。

新增 **37 個案例**。修正 fixture 後，最後的舊邊界基線為 3 passed／34 failed，新邊界全部通過。最初 fixture 的原 rowid 佔用了後來資料的位置、history 的 INTEGER PRIMARY KEY 覆蓋了指定 rowid，以及缺少必填／使用錯誤欄位，均已修正；保留原失敗紀錄，不列為行為證據。既有完整投影另外新增原 tombstone 下的後來聯絡資料：舊 raw 基線為 1 failed／35 未選案例 skipped，新版在 writer 之前拒絕，保持輸入與 authority bytes 不變。

最終本機 **9 檔／235 個不同 unit／API 案例**全部通過，與固定清單及獨立 AST 展開一致，沒有 skips。完整建置、strict、built smoke、原 UI 產物檢查與 capability 規則檢查通過。相對第 163 號，177 個固定 runtime source inputs、2 個 compiled API hashes，以及完整 static／worker precache proof 相同；沒有新增介面文案或修改 bot 運行契約。本次完整 CI 固定預期為 **176 檔／2,873 unit、81 檔／843 browser**，仍須核對本次原 run。

第 160、161、162 號原完整 CI 均已獨立核對成功。第 162 號 run `44806465515` 為 174 檔／2,813 unit、81 檔／843 browser；原 artifact 的 run／commit、ZIP digest／CRC／解包 bytes、固定 inventories、terminal logs、55 個原 Python blobs／177 runtime inputs、實際雙映像與逐資源 precache bytes／keys 均通過。第 163 號 run `44810340136` 的實際雙映像與原 image artifact／log 已核對，unit／browser 在最後核對時仍執行中，沒有重啟原 jobs。

這是**目前會受 replay 影響之私人關係的保護邊界**，不是完整私人 candidate repair／latest-history oracle。原 `fullPrivateScopeIndependentlyVerified` 仍只代表所提供單次 reset 的 pre／completion transition。相同完整圖、rowid 與 bytes 的新世代、所有 reset ancestry、media／browser pending、停止 capture custody、完整 B01–B15 與實際版本組合／QQ、正式規模及 audited activation 仍未完成。`allResetGenerationsReconciled=false`、`stoppedCaptureCustodyVerified=false`、`releaseEligible=false`；166 capabilities 仍為 0 fully accepted。
