# 退出與候補遞補群通知發布

2026-11-11 16:15（Asia/Taipei）完成 server2 `/opt/qgroup` 成套切換，並啟用新通知。發布範圍：`both`，web 在審計事務產生 outbox，bot 投遞新種類，後台共用設定增加獨立開關。

## 行為及設定

- `registration_changed`（「退出／候补递补」）通知正式／候補實際退出（含管理者撤銷），同次退出與候補遞補合併一則，分列退出者與遞補者、當時正式／候補總人數、倒計時及活動入口；每類最多 10 名並提示其餘人數。
- 增加名額、恢復報名或拆分整組候補產生的實際遞補也會通知。退出申請待審或被拒不通知，批准後才發；取消待確認或未接受邀請不發，整場取消沿用活動取消通知。
- 只公開顯示稱呼，不帶退出原因、審批備註、聯絡、付款／退款或帳號資料。普通通知凍結入隊事實，業務回滾不留通知，HTTP 重複請求及相同 revision 掛鉤去重。不建立正式測試報名，不向真實群聊發測試通知。
- 新版 `bot_settings.save` 僅在現有 `broadcast_kinds` 增加新種類，設定版本 **4 → 5**，bot 已載入版本 5。其他設定及各場群同步選擇保留，主動通知和 Markdown 維持啟用、實際發送；設定操作補發歷史通知 **0**。

## 版本及來源

| 階段 | 服務 | 完整來源 commit | 映像引用 |
| --- | --- | --- | --- |
| 切換前 | web、bot | `ed72a204115b91a57748008581b873f8188ebc74` | `qgroup:20261111-signup1-ed72a20` |
| 切換後 | web、bot | `9ca7bb57ae33b5adc4d2f1a66f06d733e0edf7a4` | `qgroup:20261111-withdraw1-9ca7bb5` |

兩服務切換前實際 image ID 均為 `sha256:c2c1df60d177c222d67f4a486e4681a96e9d8376dedd09dd9981b350befb22b5`，切換後均為 `sha256:3dee5aa5df27f874b330ebfd7624febc290d1c4dcd4e592b5c1e63a0de217e76`。

功能分支 fast-forward 整合並推送遠端 `main`，乾淨工作目錄執行 `python3 deploy/check_release_source.py --commit 9ca7bb57ae33b5adc4d2f1a66f06d733e0edf7a4` 通過後只封存該提交。238 個來源檔逐檔摘要相符，archive SHA-256 為 `1161f03ed8cfebcd42dd828d6cddd4235326a4453263dda1c893c74267443f14`。在新目錄 `/opt/qgroup-releases/withdraw-9ca7bb5` 建置一次，映像帶完整來源 label；正式 manifest 記錄兩服務實際映像與來源。

## 驗證及資料保全

- 新增 14 項退出／遞補測試。本機完整 Python 測試在 bot 開關 `0`／`1` 各 513 項通過，Node 11 組通過，手冊與簡繁產物重建、語法及 diff 檢查通過。
- 正式映像以 UID:GID 994:992、唯讀根目錄、無網路且無正式資料／憑證掛載，在兩種 bot 開關下各跑 513 項通過（各 skipped=8）。
- 配對正式備份的隔離副本以 UID 994:992 完成兩次初始化；原表欄位與值、圖片、完整性及外鍵保留，schema 仍為 15，無需遷移。新 enum／模板 key 不被舊後台接受，採成套切換，不宣稱完成混合版本驗證。
- 部署鎖及來源漂移核對通過，先停 bot／web、再啟動新 web／bot，兩者皆 healthy、restart 0，來源及實際 image ID 正確，有新 READY／ACK／poll，啟動日誌無 ERROR／CRITICAL／Traceback。
- 程式切換前後業務與設定摘要完全一致（`business_and_policy_unchanged=true`），不可變財務列保留；之後僅刻意增加上述通知種類，未修改活動、報名或帳務。
- 外網簡繁 21 項資源皆 200 且摘要與核准來源相符，`/api/health` 正常。正式 bot 以唯讀連線組裝兩場活動的純文字／Markdown 通知，分組與內容安全檢查通過，設定版本與載入版本同為 5。
- QQ 投遞以模擬 API 驗證；正式探針只組裝、不發送。真實群聊投遞與畫面仍待後續實際退出或遞補觸發確認，健康及組裝結果不等於已實發。

## 備份及回退

- 演練配對備份：`/var/backups/qgroup/kanban-20261111-081446-097579.sqlite3` 及同名 `.images.tar.gz`。
- 切換前配對備份：`/var/backups/qgroup/kanban-20261111-081502-280262.sqlite3` 及同名 `.images.tar.gz`。
- `/opt/qgroup-backups/withdraw-9ca7bb5` 保存原來源、Compose 環境、manifest、建置／兩輪測試／演練／切換日誌、資料摘要、report、public-report、runtime-report、設定變更前快照及啟用報告，檔案權限 0600。舊映像保留。
- 回退時取得部署鎖並確認無後續發布，先停 bot，**在新版程式下**保存移除且僅移除 `registration_changed` 與其純文字／`@md` 模板，保留其餘最新設定。此操作作廢該類待送消息，避免舊後台未知 enum／模板 key。不可直接恢復整份舊設定。
- 再停 web，恢復上述切換前的來源、manifest、`QGROUP_TAG` 與實際映像組合，依序啟動並核對健康、來源與新心跳。schema 不變，保留現有 SQLite 與圖片，**不得覆蓋發布後資料庫**；已發送消息不能藉回退撤回。

本紀錄後續提交範圍為 `none`，不重新建置或重啟；正式運行來源仍為 `9ca7bb57ae33b5adc4d2f1a66f06d733e0edf7a4`。
