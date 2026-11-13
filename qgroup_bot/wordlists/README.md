# 縮寫結果的社群敏感詞資料

發布範圍：`bot`。這是本機詞表遮蔽，涵蓋政治、色情、辱罵及其他上游風險詞；不是 QQ 官方規則，不保證 QQ 接受消息。資料沒有語境判斷，仍可能誤判或漏判。此資料與匹配改版尚未部署。

## 來源與授權

2026-11-13 下載並驗證以下固定快照；每份來源的完整 URL、commit SHA 與原始檔案 SHA-256 均記錄於 [sources.json](sources.json)。bot 運行時直接讀取已打包檔案，不下載詞庫，也不呼叫收費審核 API。

| 來源 | 匯入檔案 | 唯一非空詞條 | 授權 |
| --- | --- | ---: | --- |
| [houbb/sensitive-word-data](https://github.com/houbb/sensitive-word-data/tree/fe6fc2921836217b8c90619db81b24af8b22d80f) | `sensitive_word_dict.txt` | 64,419 | [Apache-2.0，保留原始完整授權](houbb-LICENSE.txt) |
| 同上 | `sensitive_word_allow.txt` | 12 | 同上 |
| [konsheng/Sensitive-lexicon](https://github.com/konsheng/Sensitive-lexicon/tree/68a595fb24d31bd9f882c081b4252443a69ac57b) | `Vocabulary/政治类型.txt` | 303 | [MIT，保留原始完整授權](konsheng-LICENSE.txt) |
| 同上 | `Vocabulary/反动词库.txt` | 551 | 同上 |

houbb 主詞庫最後檔案更新為 2025-07-19；konsheng 這兩份政治相關檔案分別為 2025-08-12、2024-02-26。倉庫有較新的其他檔案更新，不代表這些詞表也更新。不匯入輸入法字典、停用詞或名稱含 Tencent 的其他清單，也不將其宣稱為官方 QQ 詞庫。未直接匯入範圍較混雜的 GFW 補充表。houbb 的數字分類標籤是政治、毒品、色情、賭博、違法；本次使用其主詞庫，不把分類標籤檔額外列出的普通詞全部當成敏感詞。

## 衍生修改與維護

`qgroup_bot/sensitive_words.json` 是上述資料的衍生檔案：去除行首尾空白／空行、合併去重並排序，加入 [local.json](local.json) 的簡繁辱罵／色情基礎詞及可維護例外。目前共 **64,578** 條原始禁用詞、12 條允許表達；匹配正規化後為 64,568 條不同禁用詞。

明確排除 houbb 原始的 `b\u007f`、`q\u007f` 與 `柑\ue42f`：帶有控制或私用字元，正規化後只剩單一 `b`、`q` 或「柑」，會破壞 `nbnhhsh`、`QQ`、柑橘等普通文字。排除項目及原因保留在 `local.json` 的 `excluded_words`，沒有按長度或數量截斷其他詞條。

允許表達只保護完全落在該表達內的命中；例如允許「曹操」時，較長且本身在禁用表的詞仍會遮蔽。重疊的允許表達不會拼接成更大豁免。允許規則也適用於額外禁用詞檔案，變更時應一併檢查例外是否仍合適。重疊的禁用命中則合併成一個完整遮蔽範圍，避免留下已命中詞的後半段。

新增／修正本機詞條時修改 `local.json`；更新上游時審查新快照及授權、更新 `sources.json` 的完整 SHA 與原始檔雜湊，再重新產生：

```sh
python3 tools/build_sensitive_words.py
```

產生工具會先核對所有來源雜湊，全部通過後才寫入衍生檔及授權檔。正常查詢不會執行此工具。衍生資料沿用各原始來源授權；本目錄保留原始版權與授權聲明，本說明記錄本專案的修改。

匹配方式、效能與可重現量測見 [效能紀錄](../../docs/bot-sensitive-words-performance.md)。
