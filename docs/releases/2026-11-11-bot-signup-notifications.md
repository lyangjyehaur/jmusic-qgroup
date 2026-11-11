# 報名成功群通知發布

後續於 2026-11-11 16:15（Asia/Taipei）部署[退出與候補遞補通知](2026-11-11-bot-withdrawal-notifications.md)，正式來源改為 `9ca7bb57ae33b5adc4d2f1a66f06d733e0edf7a4`。以下保留本次切換當時紀錄。

2026-11-11 15:58（Asia/Taipei）完成 server2 `/opt/qgroup` 成套切換及新通知開關啟用。發布範圍：`both`，web 在報名審計同一事務寫 outbox，bot 依新種類投遞，後台顯示獨立開關。

## 行為及設定

- `registration_added`（「有人报名」）通知一般成功報名、待確認轉正式／候補，以及接受補報邀請；一次操作一則，分列本次新增正式／候補稱呼、當時總人數、開始倒計時及活動頁。每類最多 10 名，超出顯示其餘人數。
- 發起者自動報名併入活動發布通知，不額外發第二則。純待確認、生成邀請、編輯資料與既有候補遞補不當成新報名。預覽、失敗或回滾不留通知；HTTP 重複提交及重複掛鉤去重。
- 保留原通知設定及各活動群同步選擇。依使用者要求，發布後透過新版 `bot_settings.save` 只在 `broadcast_kinds` 增加新種類，配置版本 **3 → 4**，歷史留存；其他設定完全相同，bot 已回報載入版本 4。主動通知及 Markdown 均維持啟用、實際發送；沒有補發歷史報名（設定操作產生的歷史報名通知為 0）。

## 版本組合及來源

| 階段 | 服務 | 完整來源 commit | 映像引用 |
| --- | --- | --- | --- |
| 切換前 | web、bot | `4db6d0fb4479dbf087910ac3546aa41c2e7b6056` | `qgroup:20261111-botroster1-4db6d0f` |
| 切換後 | web、bot | `ed72a204115b91a57748008581b873f8188ebc74` | `qgroup:20261111-signup1-ed72a20` |

兩個服務切換前實際 image ID 均為 `sha256:41767c5f724dc65ea4f2e6ecf88a5e021ad1357c4a4d32bcb59dd63624aca490`，切換後均為 `sha256:c2c1df60d177c222d67f4a486e4681a96e9d8376dedd09dd9981b350befb22b5`。

功能分支 fast-forward 整合並推送遠端 `main`，乾淨工作目錄執行 `python3 deploy/check_release_source.py --commit ed72a204115b91a57748008581b873f8188ebc74` 通過後，只封存該提交。235 檔逐檔摘要核對相符，來源 archive SHA-256 `12b44bbc9ead65b1ad22b3c2d91b39c19cdff85806aad5115d1089f5378d1bd4`。在新的乾淨目錄 `/opt/qgroup-releases/signup-ed72a20` 建置一次，映像附完整來源 revision label；正式 manifest 記錄兩服務實際來源及映像。

## 驗證及保全

- 本機完整 Python 測試在 bot 開關 `0`／`1` 各 499 項通過（含新增 11 項）；Node 11 項通過，手冊與簡繁產物重建、diff 檢查通過。
- 新映像以 UID:GID 994:992、唯讀根目錄、無網路、無正式憑證／資料掛載，在兩種 bot 開關下各跑 499 項通過（各 skipped=8）。
- 配對正式備份的隔離副本以 UID 994:992 完成兩次初始化，原表欄位／值、圖片、完整性及外鍵均通過；schema 維持 15。沒有新增資料表或設定欄位，但新 enum 不被舊後台驗證器接受，故成套切換，不宣稱已完成混合版本驗證。
- 取得部署鎖，核對原來源及版本組合後先停 bot／web，再依序啟動新 web／bot。兩服務皆 `healthy`、restart 0、來源 label 正確；有新的 READY／ACK／poll，啟動後日誌無 ERROR／Traceback。
- 程式切換前後使用者、報名、隊列、安排、活動、角色、設定及財務摘要一致，`business_and_policy_unchanged=true`，不可變財務列保留。後續只有上述刻意的通知設定版本變更，不修改活動、報名或帳務。
- 外網簡繁 21 項資源皆 200 且 SHA-256 與來源相符，`/api/health` 正常。正式 bot 以唯讀連線組裝兩場活動的新通知，純文字／Markdown 的新參加者分組及 URL 檢查通過，並確認設定版本與已載入版本皆為 4。
- 測試投遞採模擬 QQ API；正式探針只組裝，不向真實群聊發測試消息，不建立正式測試報名。真實群聊投遞及畫面待之後實際報名觸發驗收，不能把健康／組裝結果當成已實發。

## 備份與回退

- 演練配對備份：`/var/backups/qgroup/kanban-20261111-075658-154435.sqlite3` 與同名 `.images.tar.gz`。
- 切換前配對備份：`/var/backups/qgroup/kanban-20261111-075732-890863.sqlite3` 與同名 `.images.tar.gz`。
- 回退目錄 `/opt/qgroup-backups/signup-ed72a20` 保存原來源、Compose 環境、manifest、建置／兩輪測試／演練／切換紀錄、資料摘要、report、public-report，以及 `settings-before-signup.json`、`settings-enable-report.json`（0600）。舊映像保留。
- 回退前取得部署鎖，確認沒有後續發布，先停 bot；**在新版程式下**透過版本化設定保存移除 `registration_added` 及對應純文字／`@md` 模板，保留其他最新設定。這會按既有規則作廢該類待送消息，避免舊後台遇到未知 enum／模板 key。不能直接還原整份舊設定而覆蓋後續調整。
- 再停 web，恢復切換前來源、manifest、`QGROUP_TAG` 及上述舊 web／bot 映像組合，依序啟動並核對 image ID、健康及新心跳。schema 不變，保留目前 SQLite 與圖片，**不得覆蓋發布後資料庫**；已送出的群消息不能藉回退撤回。

本紀錄的後續提交範圍為 `none`，不重新建置或重啟服務；正式運行來源仍為 `ed72a204115b91a57748008581b873f8188ebc74`。
