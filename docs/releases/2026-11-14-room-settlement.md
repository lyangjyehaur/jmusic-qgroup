# 包間分配與逐間 AA 結算

2026-11-14 19:10（Asia/Taipei）完成 server2 成套部署，發布範圍：`both`。發起人可預分自訂包間、分配報名人員並指定各房付款人；同一付款人可負責多間。結算按實際包間分攤費用、登記墊付與收退款，各房獨立對帳。參加者可直接看到完整包間卡片、成員、付款人及本人包間。

## 來源與實際版本

功能來源 `07defc429d619a7558ab7218372886f531813ae3` 已整合並推送遠端 main，乾淨工作目錄指定完整 SHA 執行 `deploy/check_release_source.py` 通過後，只封存該提交。Archive SHA-256：`b24bfe20cb5933a8579a99a7fc83b163f8f4cd74ffb16b002984e1f248f859ca`。乾淨建置目錄 `/opt/qgroup-releases/rooms-07defc4`，映像建置一次。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 切換前 | web | `8de72528e940a93f81b9b7f0117530b2913a64d1` | `qgroup:20261113-rolling1-8de7252` | `sha256:b4d12cb2d50f7020a708cac1c083cc55775763bd4dad9738cd3ccf3b5f7854f4` |
| 切換前 | bot | `2d2c63be704b5f1abe41d561fea9b41b307d908c` | `qgroup:20261113-mask-boundaries-2d2c63b` | `sha256:a2b851cd4cc1469dbcbff33867bd25fb1f46970638dc015174a3851c62c7f858` |
| 切換後 | web、bot | `07defc429d619a7558ab7218372886f531813ae3` | `qgroup:20261114-rooms-07defc4` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

正式 `/opt/qgroup/release-manifest.json` 已記錄兩個服務實際來源、映像及檔案摘要。Compose 共用標籤設為本次固定標籤；舊映像保留。

## 驗證與資料升級

- 本機原生完整 Python 測試 668 項及全部 JavaScript 測試通過；手冊及簡繁產物已重新生成。涵蓋單人跨房付款、各房付款、AA 份數／補分、權限、並發、原子交易、歷史快照、各房資金隔離、舊客戶端保護及普通結算回歸。另修正關閉包間模式後隱藏必填欄位仍阻擋表單的問題。
- 同一份候選映像匯出到本機 OrbStack，載入後 image ID 一致，使用 linux/amd64 執行。bot 開關兩種設定依序完成各 668 項測試（各 skipped=8），耗時約 288／286 秒。測試無正式憑證、無外部網路、隔離 SQLite、UID:GID 994:992、唯讀根目錄，限制記憶體 1 GiB、禁止額外 swap、CPU 2、PID 256、單輪 360 秒；退出碼皆 0，OOMKilled 皆 false。
- 瀏覽器驗證使用本機隔離活動：一般參加者能直接看到各房成員、付款人、未分配名單及本人包間，沒有編輯權限。未對正式活動做財務測試寫入，未向真實 QQ 群發送測試訊息；真實多人使用及群聊顯示待正常使用確認。
- 使用重啟後正式 SQLite／圖片配對備份演練 schema 18 → 19；保留所有原表原欄位值、驗證圖片、完整性、外鍵及重複初始化。演練與原版本回退讀取探測依序執行，容器限制 192 MiB、禁止額外 swap、CPU 0.5、PID 64、單次 90 秒。
- 切換先停 bot、再停 web，新增配對備份後，以 UID:GID 994:992 遷移正式資料庫。遷移前後除遷移版本紀錄增加外，原表全部原值雜湊及列數相同。正式 schema 為 19，新增空的 append-only `event_room_plans`；未還原舊資料庫或圖片。先啟新版 web、再啟新版 bot。
- 切換後兩服務 running／healthy、restart 0、OOMKilled false，兩邊各 180 個映像內檔案摘要符合核准來源。bot 有晚於啟動時間的 READY、ACK、poll，reconnect 0，啟動錯誤標記 0。外部 `/api/health` 正常，簡繁首頁、rooms／app／settlements／finance JS 與 CSS 摘要符合本版。
- 19:11 驗收時主機可用記憶體約 658 MiB、swap 使用量 0；此為當時觀察，並非自動資源保障。

## 準備階段事故與恢復

第一次準備時，在正式主機同時啟動兩個完整測試容器，未先確認資源餘裕，亦未設 CPU／記憶體等限額。其後 SSH banner 及網站連線逾時，使用者亦確認網站無法開啟。當時尚未執行停服、正式 schema 遷移、來源覆蓋或版本切換。中止本機 SSH 驗證連線後，仍無法連入主機停止容器。

使用者強制重啟主機後，約 18:54 恢復存取。確認主機總記憶體約 1.6 GiB，候選測試容器已退出，原版本 web／bot 自動恢復且 healthy；原資料庫仍為 schema 18，完整性／外鍵檢查通過，bot 有新的 READY／ACK／poll。保留的前一開機 kernel journal 未找到 OOM、killed process 或 hung task 記錄，無法據此證明確切失聯原因。並行且無限額的正式機測試安排不當；資料／網路隔離未涵蓋主機資源隔離。

恢復後將同一映像移到本機限額、依序測試，正式機只做限額的隔離遷移及輕量驗收。README 已移除正式機無限額完整測試範例，發布政策補上資源及時間上限要求。這些是操作規則，並非自動化發布閘門。

## 保全、相容性與回退

初次配對備份 `/var/backups/qgroup/kanban-20261114-103439-096617.sqlite3`；重啟後演練配對備份 `/var/backups/qgroup/kanban-20261114-105836-475977.sqlite3`；切換前配對備份 `/var/backups/qgroup/kanban-20261114-110955-889714.sqlite3`。同前綴 `.images.tar.gz` 須配對保留。`/opt/qgroup-backups/rooms-07defc4`（0700）保存舊來源、環境、manifest、基線、建置、事故恢復、映像測試、演練、切換及運行報告。

本次共用帳本 payload 新增 room_id／凍結 room_name、結算凍結 rooms／room_balances，bot 消費新結算通知；新 bot 沿用原普通結算通知處理，升級前待送消息可繼續消費。未驗證舊程式處理新包間寫入，故按 `both` 成套切換，不允許新舊財務寫入並行。

回退目標為表列原 web／bot 的明確 image ID 組合。已在遷移後且不含包間資料的備份副本驗證原兩個映像初始化、活動結算 context 與財務投影可讀。恢復指令保存為 `rollback-compose.json`，不追隨共用標籤。

回退前先取得部署鎖、核對無後續發布並保存新備份。只有完全沒有包間安排、包間帳單、帶 room_id 的款項或申報時，才可停止兩服務，還原舊來源／環境／manifest，以保存的 image ID override 恢復原組合，保留現有 schema／資料並重新驗證健康。任何包間資料產生後，不能直接退回舊寫入程式，優先向前修復；不能覆蓋成舊資料庫。回退 schema 可讀不代表包間業務相容。

本版每人一間、每間一筆總費用；不附統一收款碼，按各房收款人實際渠道轉帳。既有未指定包間的有效款項，須先核對並沖銷、按正確包間重登後才可轉包間結算。詳見 [功能契約](../room-settlement-contract.md)。

本發布紀錄、README、政策及功能文件的後續狀態提交範圍為 `none`，不重新建置或重啟服務；正式程式來源維持表列 SHA。
