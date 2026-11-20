# 原生歷史重置的離線修復

日期：2026-11-21。變更範圍：`none`；僅修改離線恢復工具及驗證，不修改網站、bot 運行程式、schema、outbox、設定、網址或既有 v2 刪除契約。保留 Python bot，不合入 `main`，不部署。

第 157 號修正了沒有成分／詞條但仍有找搭子或趨勢時的重置操作。其 v2 intent 的成分／詞條陣列為空，既有已套用標記不能辨識被混合恢復副本帶回的匿名留言、趨勢與發布紀錄。本次接受一組明確固定的重置前／完成後 SQLite 與 journal bytes，驗證後只清理其中原有的全站歷史範圍。

`verifyNativeOrphanResetSource` 核對完整 journal 前綴、唯一新增的真實 v2 reset、空成分／詞條範圍、固定來源 hashes、完整 schema／metadata，以及每張表的 rowid、儲存類型和內容。完成副本只能有預期的歷史刪除、mapping 狀態變化，以及精確新增的管理審計、回執與已套用標記。此核對不呼叫重置 writer 來產生預期結果。

`projectNativeForwardErasures` 新增可選的 `nativeOrphanResetSources`，目前只接受一組、且屬於原 authority 的最新 orphan-only reset。缺少證據時不猜測其全站歷史範圍。工具只修改持有 FK transaction 的記憶體候選，先核對原 lineage、完成 journal 前綴、原 authority rows 及來源世代，再清理原留言、來源文件、發布紀錄和相關 mappings。獨立 oracle 逐表比較完整候選，驗證所有其他內容保持原值；回傳前也再次核對呼叫端的來源 bytes 沒有改變。輸出繼續標記 recovery-required。

後來新增的不同留言 ID、趨勢位置與作者紀錄保留。原 ID／slot／作者的內容或 mapping provenance 已改變、同留言 ID 在新位置出現來源 shadow、來源已有 rebase，或完成前綴後又有一次 reset，均停止修復。測試使用真正完成的後續 reset，再插入相同原 ID、相同原 body，驗證不會按相同 bytes 判成舊世代。

固定 bytes 與這個 row relation **不等於停止來源 capture、外部 custody 或完整 epoch／exact-key-reuse 的證明**。沒有記錄的相同內容重用仍須外部世代證據。此工具不能直接授權正式恢復、切換或部署；`stoppedCaptureCustodyVerified=false`、`allResetGenerationsReconciled=false`、`releaseEligible=false`。含成分／詞條的 native global reset、多次 reset 的世代 ancestry 及一般業務 forward merge 仍待完成。

本機驗證：**4 檔／101 個不同 unit／API 案例**通過，其中新檔 **30 個**與新增完整投影 **1 個**，與獨立 AST 展開的固定來源清單一致。涵蓋來源 pin／journal／scope／completion 錯誤、原匿名歷史修復、後續資料保全、同 key 世代衝突、完整 row corruption、FK／transaction、SQL rollback、重播與來源變動阻擋。Python 獨立程序直接讀取三份隔離序列化副本，逐表核對 rowid、SQLite 儲存類型與內容。完整投影保留 pending／sending／sent／failed／simulated bot 紀錄、原審計、財務及回執。最後兩個改動檔再核對 **65 個**案例通過，包含在上述 101 個內，不重複計數。探索性單一案例 run 的其他案例為 skipped；初次新檔有 26 passed／2 個測試設定失敗，原報告保留，未以這些 run 宣稱全量通過。

strict、完整建置、built smoke 及 capability 規則檢查通過。與第 157 號核對 **177 個 API runtime source inputs、2 個 compiled API bundles、9 個 compiled bot bundles**均相同；worker 與全部 **85 個 precache resources**的整份 proof 相同。此步沒有前台行為變更，未新增展示文案。完整固定預期為 **170 檔／2,726 unit、81 檔／843 browser**；仍須取得此提交自己的完整 CI 結果，不能用相關案例代替全量。

補齊前次證據：第 155 號原 run `44779742495` 已完整成功，固定 **168 檔／2,681 unit、80 檔／840 browser**與三個原終態 job logs 核對通過；原 browser precache 的 85 個唯一 request／cache keys 和所有逐資源原 bytes 相同，僅排序方式不同，peak requests 為 3。第 156 號原 run `44782162992` 也完整成功：**168 檔／2,682 unit、80 檔／840 browser**固定案例、三個原 ZIP metadata／digest／CRC／全部解包 bytes、三個原終態 logs 已核對；實際雙映像及原 Python 55 blobs 已驗證。原 unit ZIP SHA 為 `84434b931c414502f4608a89cd56706d2f90a376cb090a44a27d10f83668793c`，browser ZIP SHA 為 `60146eb24fcfc35257f5891a68e85fb9e018cbfe3770c7631e060743652eccb2`。

第 157 號原 run `44788292528` 的實際雙映像及原 image ZIP `9fb1dc46ee4c30d9f498aa4cffc54a633d0276a0d687074127ec7405343dd30b`已獨立核對，包括固定 Python 原 blobs、三種合成投遞模式、原 worker／dispatch、85 HTTP、52 deep links 與清理。其完整 unit／browser 尚待終態，不把 image 成功算成整個 run 成功。合成平台並非實際 QQ，也不代表線上 bot 版本已知。

166 capabilities 仍為 0 fully accepted。完整 bot B01–B15、實際候選版本組合、latest-erasure 私人歷史、media／browser pending、真正停止 capture、外部 ancestry／high-water／epochs、正式規模及 audited activation 繼續阻擋正式切換；整體重構目標未完成。
