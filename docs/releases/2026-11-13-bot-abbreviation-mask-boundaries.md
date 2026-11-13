# 縮寫欄位邊界誤遮蔽修正

2026-11-13 23:36（Asia/Taipei）完成 server2 bot 單邊部署。發布範圍：`bot`。原先過濾器將 `slg：水…` 去除標點後，誤把縮寫尾字母與釋義開頭連成 `g水`，導致 `g` 一起被遮蔽。現在縮寫名稱、候選標示、每個查詢的釋義欄位及固定文案分開檢查；同一欄位的全部候選仍合併審查。API 結果數量、順序、重複項目及長度均保持。

## 來源與實際版本

正式來源 `2d2c63be704b5f1abe41d561fea9b41b307d908c` 已整合並推送 main；乾淨工作目錄指定完整 SHA 執行 `deploy/check_release_source.py` 通過後，只封存該提交。Archive SHA-256 `d957dc283ff342ae7ffc6c72eeb5399893b87bdfc67d2bdb058a77e9a0568164`，乾淨建置目錄 `/opt/qgroup-releases/mask-boundaries-2d2c63b`。未上傳未提交工作目錄或正式資料庫，映像只建置一次。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 前後相同 | web | `8de72528e940a93f81b9b7f0117530b2913a64d1` | `qgroup:20261113-rolling1-8de7252` | `sha256:b4d12cb2d50f7020a708cac1c083cc55775763bd4dad9738cd3ccf3b5f7854f4` |
| 切換前 | bot | `6c2d349166916d86b30ee0d9e808a61a1409281b` | `qgroup:20261113-quoted-6c2d349` | `sha256:0e95cca65f1d99de3a0aeb41aca26dbd5f6ae17650d9a4b3cbc205db2a10f197` |
| 切換後 | bot | `2d2c63be704b5f1abe41d561fea9b41b307d908c` | `qgroup:20261113-mask-boundaries-2d2c63b` | `sha256:a2b851cd4cc1469dbcbff33867bd25fb1f46970638dc015174a3851c62c7f858` |

運行程式只變更 `qgroup_bot/abbreviations.py`、`abbreviation_delivery.py` 及新增的 `abbreviation_text.py`。共用核心、schema、outbox、設定語意、web 入口、Compose 與 Dockerfile 均相同。只更新 bot；web 的容器 ID、映像、啟動時間及 restart 次數保持原樣。正式 manifest 記錄每個服務各自來源及檔案摘要；Compose 共用 `QGROUP_TAG` 的限制仍存在，整組重建前須核對各服務版本。

## 過濾與續讀

欄位邊界由渲染器建立，候選中的冒號、換行或其他標點無法建立新欄位；同一釋義欄位仍忽略分隔字元並檢查跨候選命中。縮寫本身命中詞表仍會遮蔽。送出前重新檢查與續讀重檢都保留相同語意，不修改通用敏感詞匹配器或詞表。

新待讀檔的私有 JSON 保存已遮蔽文字的欄位位元組邊界，不增加原始候選、身份資料或共用資料庫內容。分段切在欄位中間、更新詞庫後文字長度改變或 bot 重啟，均沿用欄位邊界。舊待讀檔無邊界時沿用保守的全文過濾；不還原已遮蔽內容，需重新查詢才能取得修正結果。損壞的邊界資料拒絕續讀，不回傳未審查文字。

## 驗證

- 本機完整 Python 測試 646 項通過；新增 8 項回歸測試，涵蓋 `trans`／`inputting` 的 `slg` 誤判、跨查詢／固定文案邊界、候選標點不能建立欄位、送出前詞庫更新、長結果／重啟、多次重檢、游標切在 `g`、文字重寫、舊待讀檔及損壞邊界。
- 正式映像使用 UID:GID 994:992、唯讀根目錄、無網路、無正式憑證、隔離 SQLite，bot 開關關閉／開啟兩輪完整測試各 646 項通過（各 skipped=8）。
- 正式 SQLite／圖片配對備份副本完成遷移演練，schema 18 → 18，保留原表原欄位值及圖片，完整性與外鍵檢查通過。現有 web 與新版 bot 分別讀取演練後副本，初始化、設定、活動指令與投票契約正常。
- 用新版 bot 建立帶欄位資料的合成待讀檔，舊版 bot 可讀；舊版建立的待讀檔亦可由新版讀取。全部在隔離目錄執行，未觸碰正式待讀檔。
- 切換後 web／bot 均 running／healthy、restart 0，運行檔摘要符合各自來源；bot 有晚於啟動時間的 READY、ACK、poll，reconnect 0，啟動錯誤 0。外部 `/api/health` 正常，schema 與設定／worker revision 不變。
- 正式 bot 容器內以實際 client 查詢公開 API 的 `slg` 成功，經隔離資料庫、實際事件處理器與模擬 QQ 發送介面，送出前重檢仍保留完整 `slg` 標題。未向真實 QQ 群發送測試訊息；實際群聊驗收尚待正常使用確認。

## 保全與回退

演練配對備份 `/var/backups/qgroup/kanban-20261113-153218-946630.sqlite3`；切換前配對備份 `/var/backups/qgroup/kanban-20261113-153520-688826.sqlite3`。`/opt/qgroup-backups/mask-boundaries-2d2c63b`（0700）保留來源、環境、manifest、基線、建置／測試、演練、續讀相容性與運行報告。舊映像保留，正式資料庫及圖片未還原、未遷移。

回退組合為表列原 bot `6c2d349166916d86b30ee0d9e808a61a1409281b` 映像加不變的 web 映像。取得部署鎖並確認沒有後續發布，核對現有 schema／契約；只停止 bot，移除本次新增來源檔並還原來源、環境與 manifest，以明確舊 image ID 的 Compose override 只重建 bot。確認 web 不變及 bot 有新的 READY／ACK／poll。保留現有資料庫與圖片；回退會恢復舊版跨欄位誤判。舊版可忽略新增的私有邊界欄位；若舊版重寫待讀文字，再升級可能因邊界失效拒絕續讀，使用者須重新查詢，不能退回未過濾文字。

本發布紀錄及功能文件的後續狀態提交範圍為 `none`，不重新建置或重啟服務；正式 bot 來源維持表列 SHA。
