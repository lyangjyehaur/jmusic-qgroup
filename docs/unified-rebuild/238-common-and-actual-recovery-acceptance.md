# 共用功能與實際映像恢復讀取驗收

更新：2026-11-23。發布範圍：`none`，沒有運行程式修改。不合 main、不部署、不讀取正式憑證、不修改正式服務、不發送 QQ。沿用同一份已授權的私人隔離副本與第 237 批配對套件／authority。

## 共用父項

**O08–O11、O15 完整本機父項通過**。五項原條件的 36 個具體案例引用逐項核對，目前實作／測試的 62 個 pins 與固定候選來源 `1d672eb1b3a0e6519dc890a88e8a5bc855371774` 完全相同。相關 21 個測試檔共 **552 單元案例**通過；簡繁、舊入口及統計三個瀏覽器檔共 **38 案例**通過，零略過／重試／flaky。其他共用父項不因這批案例總數而自動通過。

| 父項 | 核對結果 |
| --- | --- |
| O08 簡繁與原文邊界 | 最高優先 Accept-Language 策略、同優先順序、系統顯示轉換、使用者原文／協議值／草稿／歷史及 translate=no 邊界均有直接案例。 |
| O09 手冊、隱私、聯絡與回調說明 | 原手冊章節／hash、公開頁與簡繁、ICP 原文、QQ 返回確認及私有 token 處理核對；瀏覽器操作既有入口通過。 |
| O10 統計白名單 | 僅正式 origin 啟用；重建白名單 payload，不包含輸入、姓名、金額、ID 或 token。阻擋、延遲、拋錯與表單驗證不阻操作。瀏覽器的正式 origin 為攔截 fixture，沒有向正式統計服務送事件。 |
| O11 HTTP／靜態服務 | br／gzip／identity、MIME、原 bytes、ETag／HEAD／range、私有 API no-store、安全標頭、同源／CSRF 與限流核對；另重新綁定第 236 批同一固定映像的完整靜態產物驗證。 |
| O15 健康、最小權限與隔離 | 實際 DB 健康與版本分開、代理 IP 限制、Compose 拒絕不安全／無界設定；固定網站及保存的 Python bot 映像執行均驗證 UID 994／GID 992、唯讀 rootfs、network none、512 MiB 且无額外 swap、1 CPU、128 PID、64 MiB tmpfs。 |

私人審核為 `recovery-image-238/acceptance-private.json`。原單元、瀏覽器與映像報告逐檔綁定，沒有以台帳或 metadata 替代功能斷言。

## 固定實際映像的恢復啟動

使用候選網站映像 `sha256:acbe1303656b48c7d1e4677aaaf63817b46573c4c13ffe901046858b28ddb159` 與保存的線上 Python bot 映像 `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720`，後者來源為 `07defc429d619a7558ab7218372886f531813ae3`。

全新私人 Linux volumes 複製第 237 批已啟用副本、原阻擋 checkpoint、啟用回執與獨立 authority，先核對 bytes／大小／奈秒時間。缺少 activation 配置時，實際網站入口按原規則拒絕啟動。提供固定回執後，實際入口完成**兩次啟動、各 70 次 HTTP、正常停止及重新啟動**：健康／版本、React shell、成分目錄與 13 場公開活動的合作方讀取、HEAD／OPTIONS／驗權／唯讀方法均通過。每次运行時 rival authority 鎖被拒，正常停止後鎖釋放；checkpoint、activation 與 rootfs 禁寫。排程配對備份成功，沒有備份或趨勢錯誤。

停止後，由保存的原 Python bot 映像直接讀取同一 volume 的原 checkpoint 與恢復庫，再由實際新映像核對原生回覆。兩個來源各 **1,441 組回覆、25 種候選查詢及 176 組解析**完全一致，52 個原 Python 來源 pins 核對。這是只讀 library 驗證；**沒有啟動 bot 投遞 worker，也沒有對 QQ 投遞**。

獨立 Python 在已正常停止、無 WAL／SHM 的封存副本核對 **97 張表**的 DDL、rowid、SQLite typeof、值及 metadata。95 張表完整不變，storage 只改恢復旗標；music_documents 的原內容不變，新增一筆按實際啟動時鐘採樣的趨勢，選擇次數逐條獨立核對。原 118 筆 outbox 保全：四筆 pending、107 筆 sent、七筆 skipped；七筆不確定投遞仍保留。四張原圖、wall manifest、啟用回執、checkpoint、authority 與六個 bot 外檔 bytes／奈秒時間保全，完整性及外鍵通過。

成功主報告為私人 `recovery-image-238/run5/`。先前失敗保留：bootstrap 缺少 chmod／目錄遍歷所需權限；helper 漏收 stderr；將正常 SQLite 暫存 sidecar 誤列為停止後不可缺失檔案。修正僅限私人 helper；bootstrap 的暫時 root 權限只用於複製／設定私有 volume，網站與 Python 驗證使用原非 root 身份及原資源限制。獨立讀回也保留普通唯讀 WAL 開啟失敗及 Docker 匯出時間精度失敗；最終使用正常停止後的 immutable snapshot，先保存實際 volume 的奈秒 metadata，再依該實測值保留本機匯出時間，不改來源或放寬 verifier。

本批完成**實際恢復網站啟動及保存 Python 映像的只讀相容性**，尚未完成恢復副本的投遞 worker 成套交接、固定原 web／music／bot 全部回退操作及完整往返。第 236 批其他資料庫上的 worker 組合驗證不代替這項剩餘工作。

累計 **156／166** 個既有功能父項通過，剩 **O01–O07、O12–O14 及 U01–U03**，另含上述成套恢復與回退收尾。`originalP6Complete=false`、`releaseEligible=false`。合成預覽已恢復，入口與操作見[本機測試指南](local-testing.md)。
