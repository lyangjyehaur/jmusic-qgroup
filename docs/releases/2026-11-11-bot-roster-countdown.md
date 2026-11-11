# Bot 倒計時、報名名單與 Markdown 修正發布

2026-11-11 15:38（Asia/Taipei）完成 server2 `/opt/qgroup` 成套切換。發布範圍：`both`，web 產生 outbox／後台預覽，bot 消費相同快照及處理查詢。

## 行為

- 活動相關查詢與通知加入距開始倒計時，按組裝／投遞當時時間計算；已送出的 QQ 訊息不會自動更新。
- 單場 `/活动`、`/报名`、`/名额` 及報名前期通知分列正式／候補顯示名稱，每類最多 10 人，保留總人數及完整活動頁入口；不附 QQ 帳號、備註或付款資訊。普通通知保留入隊名單，截止提醒發送前重建。新活動通知延至發起者自動報名完成後入隊，審計順序不變。
- Markdown 明確拒絕停止重試、結算明細只列一次、舊模板 context 補預設值，並統一 Markdown／純文字／按鈕的 URL 白名單檢查。

## 正式來源與版本組合

| 服務 | 切換前來源／映像 | 切換後來源／映像 |
| --- | --- | --- |
| web | `f5739889eaf76b06b6650720725a501e8a8979a6`／`qgroup:20261111-markdown4-f573988` | `4db6d0fb4479dbf087910ac3546aa41c2e7b6056`／`qgroup:20261111-botroster1-4db6d0f` |
| bot | `f5739889eaf76b06b6650720725a501e8a8979a6`／`qgroup:20261111-markdown4-f573988` | `4db6d0fb4479dbf087910ac3546aa41c2e7b6056`／`qgroup:20261111-botroster1-4db6d0f` |

兩個服務切換前的實際 image ID 均為 `sha256:030f53ae32dcb6fdd26e413243269cb50b9037d0ab4f60240424b9291e44f636`，切換後均為 `sha256:41767c5f724dc65ea4f2e6ecf88a5e021ad1357c4a4d32bcb59dd63624aca490`。

功能分支以 fast-forward 整合並推送遠端 `main` 後，`python3 deploy/check_release_source.py --commit 4db6d0fb4479dbf087910ac3546aa41c2e7b6056` 通過。只封存該提交，232 檔逐檔摘要相符，archive SHA-256 為 `acd6a2f831c2dc5e96245154102a3c51cb79f5825b34f95f22788d34b68071d8`。於新的乾淨目錄 `/opt/qgroup-releases/botroster-4db6d0f` 建置一次，映像附完整來源 revision label，正式 manifest 記錄兩服務實際版本。

## 驗證及資料保全

- 本機 Python 在 bot 開關 `0`／`1` 下各通過 488 項；Node 11 項通過，手冊與簡繁產物重建、編譯及 diff 檢查通過。
- 新映像以 UID:GID `994:992`、唯讀根目錄、無網路、無正式憑證／資料掛載，兩種 bot 開關各跑 488 項通過（各 skipped=8）。
- 配對正式備份隔離副本以 UID 994:992 完成兩次初始化；schema 維持 15，原有各表欄位／值、圖片、完整性及外鍵檢查通過。無 schema 遷移或設定變更；新增可選 `_countdown_event`／`_roster_lines` metadata，舊 context 可讀。採成套發布，未宣稱線上混合版本驗證已完成。
- 取得部署鎖並核對來源／版本組合後，先停 bot、web，再依序啟動 web、bot；兩邊 `healthy`、restart 0、來源 label 正確。新 READY／ACK／poll 均確認，生效發送模式仍為實際發送，Markdown 開關保持啟用。
- 切換前後使用者、報名、隊列、安排版本、活動、管理角色、bot 設定、結算及財務摘要一致，`business_and_policy_unchanged=true`；不可變財務列完整保留。
- 外網簡繁 21 項頁面／資源皆 200 且 SHA-256 與來源相符，`/api/health` 正常。新服務啟動後日誌無 ERROR／Traceback。
- 正式 bot 內以唯讀 DB 對兩場公開活動、三種指令（`活动`／`报名`／`名额`）檢查純文字與 Markdown，共六組回覆的倒計時、正式／候補人數及白名單均正確。此探針只組裝、不投遞；未主動發送測試訊息、未建立正式測試資料。QQ 用戶端最終畫面由使用者在群內 @ bot 查看。

## 備份與回退

- 演練配對備份：`/var/backups/qgroup/kanban-20261111-073707-011214.sqlite3` 與同名 `.images.tar.gz`。
- 切換前配對備份：`/var/backups/qgroup/kanban-20261111-073751-878838.sqlite3` 與同名 `.images.tar.gz`。
- 回退保存目錄：`/opt/qgroup-backups/botroster-4db6d0f`，含舊來源、Compose 環境、manifest、建置／兩輪測試／演練／切換紀錄、資料摘要、report 及 public-report；舊映像保留。
- 本次不變更 schema 或既有設定語意，舊程式可忽略新增 metadata，回退時恢復兩服務為上述切換前版本組合。取得部署鎖，確認沒有後續發布，再停 bot／web、恢復對應來源／manifest／`QGROUP_TAG`，依序啟動並核對 image ID、健康及新心跳。舊 bot 不保證顯示新名單／倒計時，且會恢復原 Markdown 問題。
- 回退保留現有 SQLite 與圖片，**不得用舊備份覆蓋發布後資料庫**。已發群訊息不能藉回退撤回。

本紀錄的後續提交範圍為 `none`，不重新建置或重啟服務；實際運行來源仍為 `4db6d0fb4479dbf087910ac3546aa41c2e7b6056`。
