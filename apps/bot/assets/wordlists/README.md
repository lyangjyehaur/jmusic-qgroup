# TypeScript bot 縮寫遮罩資料

發布範圍 `none`：新 runtime 尚未部署。這是社群詞庫與本機規則，不是 QQ 官方清單，也不保證平台接受消息。

`sensitive_words.json`、`traditional_to_simplified.json`、`local.json`、`sources.json` 與三份完整授權，從 `eb51b626de67f6511c8b6a9c4174bf8b74583ad3` 的舊 bot 資料原樣保全。相同測試逐檔核對 SHA-256；新 bundle 直接使用本目錄資料，不匯入 Python、讀取舊 bot 目錄或在執行時下載規則。

- `../sensitive_words.json`：64,578 條原始禁用詞與 12 條允許表達。只影響第三方縮寫結果，不刪改網站或群聊使用者內容。
- `traditional_to_simplified.json`：4,113 個單字元映射，只統一比對，不改正常文字的顯示。
- houbb/sensitive-word-data 的詞庫／允許表達沿用 [Apache-2.0](houbb-LICENSE.txt)；konsheng/Sensitive-lexicon 的兩份政治詞庫沿用 [MIT](konsheng-LICENSE.txt)；OpenCC 字形映射沿用 [Apache-2.0](opencc-LICENSE.txt)。完整來源 URL、固定 commit 與原始檔案雜湊見 [sources.json](sources.json)。

衍生修改包括去空白、去重排序、合併 [本機規則](local.json)，以及採用 OpenCC 每字第一個單字元簡體候選。已排除控制／私用字元正規化後只剩普通單字的三個來源項目，詳細原因保留於 `local.json`。本次移植不擴增或縮減詞庫。

將來更新應先審核來源、授權及例外，核對所有固定來源雜湊後一次產生詞庫與映射，再更新差分證據；不要只手改衍生 JSON。測試比較舊版資料是重構驗證，不是新程式的執行依賴。額外詞檔由呼叫者透過 `BotMaskLoader({extraFile})` 明確傳入，每次回覆檢查變更；設定缺失或損壞會拒絕回傳未遮罩內容。
