# 引用訊息與句子縮寫查詢

2026-11-13 21:35（Asia/Taipei）完成 server2 bot 切換，隨後完成運行驗證。發布範圍：`bot`。引用別人的話後只 @ 機器人，即提取其中的英文縮寫查詢；`/縮寫` 後接整段話也支援。只送提取的查詢詞，不送原文、身份或場景鑑權資料；沿用敏感詞遮蔽與完整結果續讀。

## 版本與來源

正式來源 `6c2d349166916d86b30ee0d9e808a61a1409281b` 已整合並推送 main。在乾淨工作目錄指定完整 SHA 執行 `deploy/check_release_source.py` 通過後，僅封存該提交，Archive SHA-256 `40703e9d2406524f91f6f279eefc855fe83212c2c772e957aed22bfedcb65ee2`。解開至乾淨建置目錄 `/opt/qgroup-releases/quoted-6c2d349`，建置一次；未上傳未提交工作目錄或正式資料庫。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 前後相同 | web | `8de72528e940a93f81b9b7f0117530b2913a64d1` | `qgroup:20261113-rolling1-8de7252` | `sha256:b4d12cb2d50f7020a708cac1c083cc55775763bd4dad9738cd3ccf3b5f7854f4` |
| 切換前 | bot | `8de72528e940a93f81b9b7f0117530b2913a64d1` | `qgroup:20261113-rolling1-8de7252` | `sha256:b4d12cb2d50f7020a708cac1c083cc55775763bd4dad9738cd3ccf3b5f7854f4` |
| 切換後 | bot | `6c2d349166916d86b30ee0d9e808a61a1409281b` | `qgroup:20261113-quoted-6c2d349` | `sha256:0e95cca65f1d99de3a0aeb41aca26dbd5f6ae17650d9a4b3cbc205db2a10f197` |

運行差異只有 bot 的輸入提取、路由、縮寫用法及幫助文案。共用核心、schema、outbox、設定語意、網頁入口、Compose 與 Dockerfile 均相同。只執行 `up -d --no-deps --no-build bot`；web 的容器 ID、映像、啟動時間與 restart 次數保持原樣。正式 manifest 記錄兩服務各自來源、映像及檔案摘要。Compose 仍共用 `QGROUP_TAG`，整組重建或主機恢復前須按 manifest 核對版本，尚未實作獨立版本鎖定。

## 驗證

- 本機完整 bot 303 項測試通過，新增 15 項引用／提取測試。涵蓋官方引用包裝、巢狀元素與索引選取、句子／多行提取、網址／Email／提及／數字排除、缺少引用內容、輸入過多不截取、明確指令優先、引用指令不執行、群組／回覆／模擬政策、雙事件去重與心跳繼續處理。
- 正式新映像以 UID:GID 994:992、唯讀根目錄、無網路、無正式憑證、隔離 SQLite，全域 bot 開關關閉／開啟兩輪完整 Python 測試各 638 項通過（各 skipped=8）。
- SQLite／圖片配對備份副本使用新映像執行兩次初始化演練，schema 18 → 18，保留所有原表原欄位值及圖片；完整性與外鍵檢查通過。
- 線上 web 的原映像與新版 bot 映像分別讀取同一份演練後副本，重複初始化不改資料，設定、活動指令及投票可分享判定正常。共用程式摘要一致，支持此混合版本及單邊 bot 回退。
- 切換後兩服務 running／healthy、restart 0；web 110 個、bot 111 個運行檔摘要符合各自來源。Bot 的 READY、ACK、poll 均晚於啟動，reconnect 0，啟動錯誤數 0；外部 `/api/health` 正常。
- 資料庫仍 schema 18，設定及 worker revision 均為 6；沒有正式資料遷移、資料庫還原或群組／通知／發送政策變更。
- 切換前以新映像、切換後在正式 bot 容器，公開 API 查詢 `yyds,nbnhhsh` 成功。用隔離資料庫與模擬 QQ 發送介面，讓實際事件處理器處理「引用句子後只 @bot」：只收到 `yyds,nbnhhsh` 查詢詞，回覆沿用公開查詢產物（313 字），回覆綁定當前訊息 ID。未向真實 QQ 群發送；引用功能的真實群聊驗收尚未完成。

## 保全與回退

演練備份 `/var/backups/qgroup/kanban-20261113-133224-708573.sqlite3`；切換前備份 `/var/backups/qgroup/kanban-20261113-133506-127139.sqlite3`，各有配對 `.images.tar.gz`。`/opt/qgroup-backups/quoted-6c2d349`（0700）保存原來源、環境、manifest、基線、建置／測試、演練、相容性及運行報告，舊映像保留。

回退目標為 web／bot 均使用表列原 `8de7252` 映像。取得部署鎖並確認沒有後續發布，核對現有 schema／契約相容；只停止 bot，移除本次新增來源檔，還原保存的來源、環境與 manifest，使用明確舊 image ID 的 Compose override 只重建 bot。確認 web 容器保持原樣，bot 有新的 READY／ACK／poll。保留當前資料庫與圖片，不以舊備份覆蓋新寫入；回退會停用引用與句子提取，但保留原敏感詞、續讀與持續投票程式。

本紀錄及功能狀態更新的後續提交範圍為 `none`，不重新建置或重啟；正式 bot 來源維持表列功能 SHA。
