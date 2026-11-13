# QQ bot 縮寫查詢

功能發布範圍：`bot`。已與投票調整成套發布（`both`），版本與正式容器驗證見[發布紀錄](releases/2026-11-13-flexible-polls-abbreviations.md)。尚未完成真實 QQ 群聊驗收。

## 使用

在允許指令回覆的群 @ 機器人後發送：

```text
/缩写 yyds
/縮寫 nbnhhsh
/nbnhhsh yyds,nbnhhsh
```

支援空格、半形／全形逗號和頓號分隔；每次最多 5 個不同縮寫，每個限 2–32 位英文字母或數字。不接受整段聊天文字或網址；只傳送正規化的小寫縮寫，不傳送群組、成員、訊息 ID 或 QQ 憑證。不帶參數會顯示用法。結果以純文字列出，按 API 回傳順序顯示全部候選，不限制候選數量、不截斷單個釋義，也不合併重複候選；尚未確認的 `inputting` 結果會另加標示。候選資料來自社群，含義仍需配合語境判斷。

完整結果修正的發布範圍為 `bot`，目前尚未部署；上方發布紀錄對應的是原先限制候選數量與長度的版本。

完整結果修正已通過 247 項 bot 測試，涵蓋超過 5 個候選、超過 40 字的釋義、保留順序與重複候選、超過 64 KiB 的正常回應，以及完整結果傳入 QQ 發送介面；測試使用模擬投遞，尚未完成此修正的真實 QQ 驗收。

## API 依據

- [官方專案](https://github.com/itorr/nbnhhsh)
- [網站與使用者腳本](https://lab.magiconch.com/nbnhhsh/nbnhhsh.user.js)
- 端點：`POST https://lab.magiconch.com/api/nbnhhsh/guess`
- 標頭：`Content-Type: application/json`
- 本文：`{"text":"yyds,nbnhhsh"}`
- 回傳：JSON 陣列；`name` 為縮寫，`trans` 為釋義列表；沒有正式釋義時可能有 `inputting` 候選。

2026-11-13 實測未帶 API key、Cookie 或 QQ 授權的請求回傳 HTTP 200。這是網站實際使用的公開端點；官方 README 未提供服務等級承諾或明確額度，因此不把目前可呼叫視為長期相容性保證。不呼叫提交詞條的寫入端點。

## 運行與相容性

- 網路 I/O 透過背景執行緒執行，不持有 SQLite 連線、不阻塞 QQ 事件迴圈；網路逾時為 4 秒，完整讀取 API JSON 回應，不以固定回應大小拒絕正常查詢結果。
- 每個 bot 行程共用最多 256 筆、一小時有效的記憶體快取，成功的空結果也快取。每秒最多一次上游請求，同時最多一筆；失敗後暫緩 10 秒，不重試該請求。重啟後快取消失。
- 網路錯誤、429、無效 JSON 或資料結構會回覆暫時不可用；不把上游本文或例外文字送到群裡。詞條中的連結及 @ 提及不轉發。
- 沿用原有群組授權、全域指令回覆開關、模擬／實際發送設定。模擬模式仍執行縮寫查詢，但不向 QQ 投遞。
- 僅修改 `qgroup_bot/`、測試及文件；不變更 schema、outbox、共用設定、網頁入口或 web 運行程式。程式相容性判定為 `bot`；發布時仍須按部署政策核對線上 web 的來源與映像並驗證版本組合，真實 QQ 驗收另行記錄。

## 本機驗證

```sh
python3 -m unittest discover -s tests -p 'test_bot_abbreviations.py' -v
python3 -m unittest discover -s tests -p 'test_bot_*.py' -q
```

自動測試模擬上游與 QQ 投遞，不存取正式資料庫或真實群聊。

2026-11-13 驗證結果：新增 11 項測試、完整 bot 244 項測試皆通過；另將遠端 main 提交 `87a4149a64373b3183c45d1843b71775531c72e8` 匯出至乾淨暫存目錄，只疊加本功能的程式與測試，再執行 bot 244 項測試亦全部通過。使用實際 Python client 查詢 `yyds,nbnhhsh` 成功；此驗證沒有向 QQ 投遞，也未變更正式服務。
