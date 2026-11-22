# 第 219 批：最新副本、完整回歸與回退封存

日期：2026-11-23（Asia/Taipei）。發布範圍 `web`：僅修正 React 使用說明的兩句操作指引；本批其他變更為驗收文件，範圍 `none`。沒有合併 main、部署、讀取 `.env` 或正式憑證、改動正式群設定、重啟正式服務或發送 QQ 消息。

## 固定候選與完整回歸

已驗證候選為 `4fb6bbb86f12e1ef3e3569f1b31ed91573f1eaa1`。[完整 CI 45041562137](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/45041562137) 的 unit、image、browser 三個 job 均成功；下載原始產物後逐項核對：

- 單元測試 4,063 項通過，失敗／待執行 0。
- 瀏覽器測試 1,043 項通過，失敗／略過／flaky 0；每項只有一次執行，retry 為 0。
- Linux 建置、編譯後原 Python 恢復 adapters、映像 runtime／來源／版本清單及觀測來源的 Python 組合均通過。

另已完成「本機候選映像＋實際只讀匯出的正式 bot 映像」驗證，與 CI 重建的觀測來源映像分開記錄：

| 服務 | 來源 | 實際本機映像 |
| --- | --- | --- |
| 新網站候選 | `4fb6bbb86f12e1ef3e3569f1b31ed91573f1eaa1` | `sha256:e331f5a8fa060095cb96b1919ec91569c5fd73edb3ecd3544d4b9020841ef205` |
| 匯出的線上 Python bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

52 個原 bot 來源檔案與實際 `/app` import 路徑獨立相符。組合演練包含 54 個別名、314 個深連結、531 次 HTTP、71 次原 worker 與 9 次新 worker 操作；涵蓋活動、名冊、生命週期、投票、結算原圖、政策變更、恢復、勿擾／節流及雙向交接。原 UUID 回執、confirmed／uncertain／simulation 狀態沒有重播或轉真送。程序正常結束，容器／volume 清理已核對。

上述組合使用合成資料、受控 QQ 與自然時鐘，沒有修改 due／retry／claim 時鐘。限制為 network none、唯讀 rootfs、uid 994／gid 992、512 MiB 且沒有額外 swap、1 CPU、128 PID、64 MiB tmpfs；額外新 worker fixture 在獨立同限額容器執行。這不是正式 QQ 或全部 B01–B15 的外部平台驗收。

## 最新授權只讀副本

沿用使用者「允許只讀擷取隔離副本」授權，從當時運行服務取得同一批輸入。第一輪傳輸逾 180 秒而中止，第二輪因來源正常更新而拒絕；失敗紀錄保留，不用於演練。第三輪以串流壓縮完成，並保留雜湊、檔案時間及來源變動檢查。

192 個來源檔案共 85,926,654 bytes。獨立 Python 驗證逐檔 checksum、私有權限、兩個 SQLite 的所有欄位／型別／rowid／schema、完整性及外鍵；來源服務生命週期與版本未變。當時兩庫 data_version 均穩定，普通檔案與目錄清單重新核對。

- 看板：48 個帳號、14 場活動、87 筆參加者、4 個時間投票、6 個預分房版本、3 個結算版本；118 筆 outbox，含 4 pending／107 sent／7 skipped。
- 成分：68 份來源會員、152 個詞條、682 筆選擇。
- 外部 bot：6 個日誌檔；原 Python 固定來源的縮寫續讀路徑已核對，擷取時該目錄不存在。自訂敏感詞檔路徑未配置，沒有讀取完整 environment。
- 主機看板歷史：14 組 SQLite／圖片 archive；另 28 個孤立舊 `-wal`／`-shm` 保留為私人原始證據，沒有冒充可還原的資料庫。14 組資料庫的完整性、外鍵、圖片引用、大小與 digest 另由獨立 Python 檢查通過。

看板刪除紀錄檔仍不存在，absence 明確記錄；空檔僅供隔離 importer 使用。來源沒有停止寫入；此副本不證明跨服務停寫切換，不能用它替代 P7 維護窗快照。原始資料、身份、圖片與日誌均留在 Git 外的私人驗證目錄。

## 最新副本上的回退演練

同批副本已完成首次匯入、另一個空目錄的重複匯入及 exact 再匯入。59 張看板／25 張成分來源表對帳通過；97 張新庫表的型別、rowid 及原列一致，僅獨立新庫的 storage lineage 不同；重跑回傳 `already_imported`。新庫 schema 為 15。

隔離新增兩個合成帳號，使用原詞庫執行成分→同好／搜尋→活動→三人名冊→試算→正式包間→開始／結束→900 分结算。無成分同行及原付款責任保留，未授權採用拒絕；同 UUID 再發布不新增寫入。固定原 Python 核心可讀當前分房、名冊人數及凍結帳單。回退投影與 forward business round trip 保留新選擇、帳單及原 bot outbox／設定；另以隔離 SQLite／JSON 修改演練回退後繼續寫入再前進，標題／選擇變更保留，凍結帳單、審計與 outbox 不變。這個後續修改沒有冒稱為原 HTTP handler 驗收。

私人 v2 回退套件 224 檔重新讀取並對帳通過，包含最新外部 bot 狀態、30 份成分歷史及 14 組看板歷史。成分歷史先套最新擷取刪除紀錄；看板歷史使用當前可得帳號關閉 journal。6 個 bot 檔案恢復後，獨立 Python 確認 bytes 和奈秒級 mtime 完全一致，沒有更新 TTL 或啟動待送工作。第一輪私人 JS helper 使用 JSON Number 讀取奈秒造成精度損失，已改用由原 manifest 雜湊綁定的 Python 十進位字串；原擷取時間與產品的字串協議未變。

另以真正本機 Docker 的候選 web／匯出 bot 映像建立兩個不啟動的隔離容器，執行 v3 回退封存。12 次窄欄位 inspect 核對映像、來源、created／Pid 0、原庫與日誌／歷史 bind。封存期間獨立 Python 嘗試取得業務庫及 bot owner 鎖，兩者均拒絕；227 檔套件可重新驗證，原業務／outbox／bot 外部 bytes 與 mtime 不變，兩容器已移除。這證明本機副本的離線來源與鎖邊界；容器沒有執行過，不能冒稱正式服務停寫或新增映像組合執行證據。

| 私人產物 | Manifest SHA-256 |
| --- | --- |
| 最新只讀副本 | `591a7209bf5ef07b3a79569a4abd411899660acfcf25b24ee1fb9e38098bbd7c` |
| v2 回退套件 | `f22cfe4716ed6a4a58586297e7c9da64bd81a567b7912c9cc04a3bea75ed675b` |
| v3 離線回退套件 | `acd75bf63421febce1bd49316b0ba4f8fb54a2259adf98fe0336e591592979c4` |

離線全套校驗在本機執行，v2 peak RSS 1,329,360 KiB、v3 1,228,256 KiB；不能將前述 web／bot 容器的 512 MiB 限額套用到這個私人恢復工具。套件仍回報 `rollbackEligible=false`，不修改固定門檻以求通過。

## 台帳收斂與操作說明

13 份家族／整合語意審核合計覆蓋 166 个既有 ID 與 U01–U03 的 228 個具體條款。939 個測試引用已逐個對回本次候選的成功 unit／browser cases；這是引用數，不是新增或不同測試數。329 個來源路徑對回固定 Git blob；六個與前次審核不同的投票來源已另核對第 218 批 14 個來源摘要、109 個當前單元案例與新填答 fencing 語意。原 baseline 審核不覆寫。

語意條款通過不等同父項全部驗收通過。公開收斂索引見 [local-acceptance-status.json](local-acceptance-status.json)；原功能與整合台帳保持未通過，`originalP6Complete=false`、`releaseEligible=false`。剩餘完整父項審核、原 web／music／bot 的回退後成套操作及錯誤恢復證據不能由測試總數、唯讀投影或不啟動容器取代。正式 origin、憑證與群設定的 custody、真正停寫快照、真 QQ／WebView 與發布後驗收仍按各自條件記錄，P7 不在本輪範圍。

使用說明刪除了分享頁可複製名冊的錯誤承諾，改成實際提供的連結／活動資訊／目前安排；正式採用分房的操作者改為發起者。只保留具體操作提示。這兩句修改在完整 CI 候選之後，已另通過 TypeScript／全站 bundle 建置、編譯後隔離 smoke 與既有說明頁瀏覽器 5 項（簡繁、手機、匿名故障、原入口／bot 指令），無略過或重試。API／bot bundle bytes 在修改前後完全相同；不聲稱前述完整 CI 或實際映像包含這兩句修改。本機預覽已以更新後產物重新啟動。
