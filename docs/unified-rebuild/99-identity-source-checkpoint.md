# 第九十三批實作：身份來源結構與高水位保全

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：離線身份資料遷移影響候選網站與 bot 的帳號、權限及原資料組合；實際發布 **`none`**。沒有 main 整合、正式資料擷取、服務／憑證／群設定／真實待送操作。

## 原始結構與資料列識別

前一批已保存身份資料列，但只有表名／欄位名檢查，未保存原 DDL、隱式索引、rowid 或自增序號。本批從 `music_site/identity_store.py` 凍結目前十張身份表的完整原 schema；未知索引、view、trigger、欄位型別、default、constraint 或部分索引條件皆要求明確審查，不自動忽略。原 Python web／bot 程式未修改。

離線匯入在既有 `music_documents` 新增私人 `identity_source` 記錄，schema 維持 **15／96 張表**。封存包含：

- 全部 `sqlite_master` 物件，含 `sqlite_sequence` 與 UNIQUE／PRIMARY KEY 的隱式索引；原 SQL 逐字保留。
- 每張表的 `table_xinfo`、欄位順序／型別／空值限制／default／主鍵／hidden 狀態。
- `user_version`、`application_id`、encoding；本來源只支援已凍結的 0／0／UTF-8 組合。
- 每列的原 signed rowid、原 ordinal 與每欄 `typeof`，連接既有 `music-identity` mapping 及 `music_legacy_identity.row_number`；刪除後 ordinal 的缺口不重新編號。
- 完整 `sqlite_sequence` 高水位，用十進位字串保存，不經 Number 捨入；序號可高於現存最大 audit ID，甚至原 audit 表已空，也不得倒退。

負 rowid、跳號及超過 JavaScript 安全整數的 rowid／序號均保全。這不放寬資料欄位的原表示限制：不支援的 BLOB／NULL／不安全數值仍按前一批規則拒絕。未知／重複／缺失正值 audit 序號、非 INTEGER、負數或低於現存 audit ID 的高水位亦拒絕；初始未建立序號與已刪空但保留高水位的狀態分別記錄。

此記錄只有結構、位置與儲存型別，不複製會員名稱、QQ、token、PIN、native payload 或其他身份原列內容。原列仍由既有私人 archive 和最新刪除模型保全；帳號／成分刪除清除相應原稿與 proof，保留非內容的來源位置和序號證據。這些資訊不成為認證、認領或復活的旁路，也不出現在管理 `exportMusic()` JSON。

## 獨立核對

`identity-reconciliation.ts` 重新讀取 readonly 原身份庫，直接查詢 schema／欄位／rowid／儲存型別／序號，不呼叫 importer、`captureIdentitySource()` 或從 mapping.status 推斷允許差異。它逐字核對唯一、position=0 的封存記錄；漏失、追加、欄位／DDL／型別／高水位被改都阻止候選發布。

獨立預期記錄亦加入既有 25 張成分表的完整對帳，不以排除新的 document kind 來通過。`report.musicReconciliation.identitySource` 只含版本、verified、表／schema／來源列／序號列數與 digest，不輸出原 rowid、高水位、私人列或原 SQL。驗證在匯入交易完成與目錄 rename 之前執行；失敗回滾並清除 staging，來源保持不變。

重跑仍保護新版已寫入資料，返回原初始 manifest。舊檢查點 manifest 不會因此取得新的身份核對證據；`already_imported` 不能當成本批新驗收或再次對帳。

## 隔離驗證

- 最終完整單工 **1,051 項／116 檔通過**，較前一批新增 **28 項**：原結構／型別／rowid／高水位、16 類來源結構拒絕、9 類獨立證據損壞拒絕、空 audit 表的 signed-64-bit 序號，以及初始未建立序號。
- 來源結構案例涵蓋部分 UNIQUE 索引消失或條件被改、追加索引／trigger／view、相同欄位名改 affinity／default、database version／application ID 變動、序號型別／負值／倒退／缺失／重複／未知名稱。逐例確認來源 digest 不變、目的不存在、staging 清除。
- 私人欄位保全案例驗證刪除 audit／session 原稿後保留原 rowid 與高水位，重複限流原列及計數不合併，剩餘身份列與 mapping ordinal 不位移，封存與公開匯出無原 credential／被刪內容。
- 初次針對性 **99 項／2 檔通過**；其後新增三項亦由最終全套涵蓋。Strict TypeScript、production React／API／bot build、compiled smoke 通過。mock bot 含本機 HTTP／WebSocket／ACK／Resume／不確定投遞／模擬／CLI／SIGTERM；API 包含隔離 SQLite／sharp、配對備份／歷史匯出、恢復啟動阻擋及分房 worker。

記錄：`/tmp/qgroup-identity-source-targeted.log`、`/tmp/qgroup-identity-source-typecheck.log`、`/tmp/qgroup-identity-source-native-final.log`、`/tmp/qgroup-identity-source-build-final.log`、`/tmp/qgroup-identity-source-smoke-final.log`。全套測試中的未合 main 來源拒絕訊息是合成拒絕案例，完整測試 exit 0。

本批只有離線遷移工具與測試／文件變動，沒有新 TSX 或運行服務變更，因此未重跑瀏覽器或重建 Docker 映像。主 JS 仍 **1,482.05 kB／gzip 432.87 kB**，效能拆包仍待處理。前一批映像證據仍只適用其固定來源，不當作本批工具的映像驗收。沒有真 QQ、實機或正式 bot 版本組合驗收。

## 後續門檻

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。本批完成受支援身份來源的邏輯結構與原列位置保全；不是完整原檔重建、正式來源一致擷取或新寫入回退匯出器。尚須完成歷史配對備份／最新刪除處理、跨服務停寫鎖、正式規模／資源演練、候選啟用與最新新寫入回退，以及 B01–B15／候選 web＋實際 bot 組合、效能、實機與 QQ WebView 驗收。依使用者要求先不部署。
