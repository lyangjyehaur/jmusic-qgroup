# P0–P6 完整本機驗收

更新：2026-11-23。發布範圍：`none`；本批只更新驗收文件及台帳檢查，沒有修改運行程式。**166／166 既有功能與 U01–U03 均完成本機父項驗收，原 P6 完成。** P7 正式切換不屬本次任務，尚未合併 main 或部署，`release_source_approved=false`、`release_eligible=false`。

驗證以已授權擷取的線上隔離副本及實際運行版本為基準：48 帳號、14 活動、87 參加者、68 份成分、152 詞條、682 選擇、三份詳細帳單、六版房間與原 118 outbox。原始資料、身份、消息、資料庫及失敗原回應只保存在本機私人驗證目錄，不納入 Git。

## 版本與證據

| 角色 | 完整來源 commit | 實際映像 ID |
| --- | --- | --- |
| 新版網站／TypeScript worker | `1d672eb1b3a0e6519dc890a88e8a5bc855371774` | `sha256:acbe1303656b48c7d1e4677aaaf63817b46573c4c13ffe901046858b28ddb159` |
| 保存的正式 Python bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

原看板 HTTP 使用 `83eb54ce94f935a4048aaf63a410206723f09bd8`，原成分 HTTP 使用 `be51e065bd0d64a2df3a783ca14672d92ba6d49a`。新版運行來源至本批之前只有文件差異，沒有把文件提交當成另一個已建置版本。

完整 Linux CI 的 `0059259f4b5382d54aedb79a769edfddd8d4dafb`：4,063 單元／1,047 瀏覽器取得成功終態，沒有略過、重試或 flaky。後續運行修正逐批使用當前來源、相關單元／瀏覽器、原 Python 對照與實際映像驗證，見[收斂清單](completion-status.md)及各父項文件；不將後續修正套用較早完整 CI 的結果。

## 最後三個父項

| 父項 | 原條件與本機完成證據 |
| --- | --- |
| O12 遷移／完整性 | 精確核對原列、schema、rowid／storage class、刪除後 high-water、完整性／外鍵、圖片引用、重複匯入及不以舊 registrations 重建新名冊。已成功的 552 單元報告中逐一核對五個原條款案例；隔離正式副本的重複匯入見第 219／225 批，連續回退／forward／重跑及恢復見下節。 |
| O13 成套備份／恢復 | JSON／身份／壁紙／最新刪除紀錄的配對、writer locks／來源 pins、私人套件獨立重開、恢復不啟動舊管理、bot 狀態及外檔時間均驗證。核對六個原條款案例；30 成分歷史、14 看板歷史、圖片、六 bot 外檔及非空不確定投遞均有副本證據。 |
| O14 發布來源／版本組合 | 核對五個原條款案例：完整 SHA、乾淨 archive、main 批准／未合入拒絕、獨立固定 web／bot 映像及拒絕可變標籤。另在乾淨倉庫實際執行候選來源檢查，因未合遠端 main 正確拒絕；未 archive、未部署。雙遠端分支同步逐次核對，發布必須另外核准來源。 |

本批 16 個精確原條款案例引用及 19 個來源／測試 pins 均對應固定新版 runtime；沿用成功的 552 個單元結果，沒有為湊案例重新擴大範圍。O14 本機行為通過不代表候選已批准發布。台帳檢查現同時要求完整本機驗收與獨立來源批准，不能因 169 個父項通過就誤設可發布。

## 連續回退與恢復

同一份[第 240 批](240-recovery-worker-handoff-acceptance.md)成功 worker 恢復結果，依序完成以下操作；沒有以另一個合成空庫替代。

1. 使用原帳號、原成分與完整來源副本，在新版建立三人名冊、兩人成分自動分房、人工加入無成分同行、採用正式房間及 900 分結算。244 HTTP／155 詞庫查詢通過；原資料列及當時 146 筆 outbox 保留。
2. 封存該副本並建立配對 authority，再投影至原站格式。實際原看板 HTTP 完成建立後丟失回應、原 key 查回／精確重試、修改、權限／舊版次／同 key 異內容拒絕，並讀取新帳單。實際原成分 HTTP 完成選擇、留言、喊話及 24 小時限制；偽造資料所有者、缺 proxy、空選擇與未知操作拒絕。原數字 QQ 更改仍按原規則拒絕，保存原號成功；使用原 OAuth context，沒有修改原身份。
3. 使用完整來源＋authority 的 account epoch，完成 business／proof／source rebase。普通重綁入口對已重綁來源正確拒絕；完整來源入口保留上一輪 pins、原始來源、三方合併及配對權威紀錄。三階段重跑各 97 表 rowid／storage class／值一致；全部原 59 看板表的新寫入帶回，bot 四表、原帳單及財務資料保留。輸出仍 `recovery_required=1`。
4. 重新產生並獨立讀回 224 檔 v2 套件，含 30 份成分歷史、14 組看板歷史、四張原圖片加一張新結算圖片及六個原 bot 外檔；bot restore／歷史 catalog 的 bytes 與奈秒 mtime 核對。產生新的 authority、review 和 activation，九筆不確定投遞保持審核狀態，原 blocked 來源不變。
5. 固定新版實際映像從新 activation 啟動、正常停止、重啟、再正常停止；11 HTTP 讀取通過，原帳號 scope、舊站新活動、新帳單及 146 outbox 保留。保存的實際 Python bot 映像的 25 指令回覆、完整三人房間與 900 分原生帳單 snapshot 與新版一致，52 個 Python 來源 pins 核對。
6. 停止後獨立 Python 對帳：97 表 schema／integrity／外鍵通過。相對 blocked checkpoint，只有恢復旗標改變；95 張非旗標／趨勢表 typed rows 全等，趨勢表亦全等，沒有新增樣本。原圖片、bot 外檔 bytes 及六檔奈秒 mtime 保全，來源 bytes 不變，測試容器與 volume 清理成功。

私人驗證目錄第 241 批成功輪為 `run4`、`final-package4`、`activation4`、`runtime5` 及 `roundtrip-bot7`，完整審核結果和底層報告 hash 保存在 `acceptance-private.json`。最後配對套件 manifest SHA256：`a2878382bd6ac9c3603da20fa9403ea8a3aad0646acf5c252d992bf83ea5c860`。

失敗 helper 與終態保留：OAuth context 缺欄位、錯誤預期原 QQ 更改、普通入口重綁已重綁 epoch、outbox 數量假設，以及 SQLite WAL-header 映像不能直接 deserialize。最後 bot 只讀比較使用獨立邏輯 backup／DELETE journal-mode 副本，先證明全部 97 表及 schema 全等；沒有修改恢復結果的業務資料或放寬產品 verifier。

## 本機交付與正式切換邊界

[本機測試指南](local-testing.md)提供預覽、合成登入／管理帳號與操作順序。預覽不載入私人正式副本，不啟動投遞 worker。

本次 P0–P6 實作及本機驗收完成；正式切換仍須另按[發布政策](../deployment-policy.md)合入及同步 main、取得當時成套停寫快照、執行完整 SHA 來源批准並按已驗證版本組合切換。保存的正式 Python bot 沒有新版排他鎖，更換 worker 要先停止舊 bot 再啟動新版。

線上唯讀擷取沒有停止服務，因此不證明正式停寫切換邊界；缺失的原看板刪除紀錄已記錄。真實 QQ 授權／真群投遞及實機 WebView 結果不在這次本機模擬中冒充通過，也不因此繼續增加本機實作範圍。本批沒有合併 main、部署或發送 QQ。
