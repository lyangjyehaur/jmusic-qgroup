# 2026-11-25 bot 回覆消息 ID 修復

發布範圍：`bot`。台北時間 22:24 啟動正式修正版，22:30–22:31 觀測到使用者重新發送的活動與縮寫指令成功回覆。

正式日誌在 19:01 與 19:04 顯示兩個群的消息已識別直接 @bot，卻被 `invalid_message_id` 擋在指令解析之前。新版把群／路徑 ID 的 128 字元、字母數字底線連字號限制套到消息 ID；舊 Python bot 原樣使用平台消息 ID，沒有這個限制。

修正將 JSON 回覆用的消息／外層事件 ID 分開驗證，接受包含標點及較長的可列印 ASCII token，保留原值，不截斷或替換；仍拒絕空值、超過 4096 字元及控制字元。群 ID 和 interaction ACK 的 URL 路徑驗證維持原限制。直接 @ 判定、@全體忽略、群權限、乾跑設定、去重及投遞狀態語意不變。拒絕消息時補上 ID 型別與長度，不記原始 ID 或正文。

| 產物 | 來源 commit | 實際映像 ID |
| --- | --- | --- |
| 更新前 bot／回退目標 | `54107b8a3c07444b1a3bd31188824bcfadaad4a8` | `sha256:2a7f4e9d9a9e1ed6cef6edc011ff366f0310f04509121c318d0abe891564c137` |
| 更新後 bot | `515ec4c4938f5111b9bd61f046f7d9106d453104` | `sha256:7ce6a3bfcf55e54813f757c6a3bb390bfd96894acf1aa27a9c4503d777b5789b` |
| 保持運行的 API | `b65e93b05eb8558f8c15d60eb15b2d0cc6cce4cc` | `sha256:c81f4ce7c90224314e0b6e1e9faeec370dd04a083a1306f690cf1985401bcf27` |

獨立前端維持 `a381756ecea733e8c41537f52606ec392bb03350`，build ID 為 `8b6004ac0e5dccdc7cb05da2347d558695c1f714d340a2ff72157e1fd33b2df5`，manifest SHA256 為 `2eef9e8e04e7b9611d7e663f65d32cd7d4efdc2ea65a3aa38b285141bddeba9d`。API 容器 ID、啟動時間、映像與 restart count 均未變，前端版本亦未變。

修復提交先合入 main，git.dan.tw 與 GitHub 的 main SHA 核對一致；完整 SHA 通過 `deploy/check_release_source.py` 後以乾淨 archive 本機建置 linux/amd64 映像。Docker registry 的外部 Dockerfile frontend 連線失敗，改用 BuildKit 內建 frontend，僅移除建置輸入首行的外部 syntax directive，保留 archive 原文及相同 Dockerfile ignore 規則，兩份摘要與差異另行保留；應用來源和建置步驟不變。

驗證結果：

- TypeScript 型別檢查與 132 項 bot 測試通過。首次縮寫 Python 比對受 5 秒測試期限影響，該檔以 15 秒期限重新通過，未修改比對斷言。
- 完整 runtime 的模擬 HTTP／WebSocket 測試確認長且含標點的消息／事件 ID 原樣進入發送 JSON，重複事件僅回覆一次；非法 token、群路徑、@全體與權限限制仍有效。
- 實際候選映像與線上 API 映像的 database、outbox、公開回覆及維護 bundle 逐位元組一致。使用線上 API 的 database bundle 建立隔離資料庫，執行候選映像的原生 bot smoke：回覆 token、ACK、去重、恢復阻擋、投遞不確定／模擬狀態、ownership 及 SIGTERM 均通過。本機 amd64 模擬採 2 CPU、1 GiB、無額外 swap、無外部網路，沒有真實 QQ 投遞。
- 切換前確認沒有 `sending` 通知，沿用原資料／憑證／群設定，只更新 `QGROUP_BOT_IMAGE` 並重建 bot。schema 維持 15，沒有遷移或重播既有工作。
- 首次切換在第一個心跳回應前提前驗收並自動回退；修正操作腳本，要求本次啟動後的新心跳及 poll，再重試同一映像成功。bot 健康、連線、policy resolved 正常，restart count 為 0。
- 使用者重新 @bot：22:30 的活動指令完成 `command_parsed`、`reply_prepared`、`reply_sent`；22:31 縮寫指令亦完成解析及回覆。兩次 QQ 發送 API 均為 HTTP 200、`ok=true` 且取得發出消息引用；這是平台接受回覆的實際驗收，未推定已讀。
- 切換前後 `qgroup-backup.service` 成功，backup timer 維持 active。

發布資料在 `/opt/qgroup-releases/bot-reply-fix-20261125-515ec4c`；目前 Compose、frontend override 和 runtime.env 路徑沿用 README。實際版本組合寫入 `/opt/qgroup/release-manifest.json`。私人驗證證據在 `artifacts/private/bot-reply-fix-20261125/`，不納入公開倉庫。

回退僅將 bot 映像改回表中已保存的版本，以相同 Compose 和 override 執行 `up -d --no-deps --no-build bot`，保留 API／前端，重新核对實際來源、健康與新心跳並更新 manifest。資料與 outbox 契約相容；不得覆蓋資料庫、重播已送工作或啟動第二個 bot。回退目標仍帶有本次消息 ID 問題，只供恢復啟動等運行故障，不能視為指令功能已恢復。
