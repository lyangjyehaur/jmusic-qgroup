# OpenAPI 驗證 schema

`openapi-3.1.json` 取自 OpenAPI Initiative 的 [OpenAPI 3.1 schema（2022-10-07）](https://spec.openapis.org/oas/3.1/schema/2022-10-07)，保留原始位元組。SHA-256：`da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0`。

授權為 Apache-2.0；[原授權來源](https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/LICENSE)的完整內容保存於 `LICENSE.openapi.txt`。此檔只用於建置／測試的文件格式驗證，不代表業務授權或正式發布門檻已完成。

`http-access-review.json` 是人工核對的身份邊界及來源 SHA-256，涵蓋全部 194 個 v2 操作。來源檔案、handler 或中央 guard 改動後須重新核對描述再更新 pins；生成器拒絕過期 pins、缺少、增加但未核對的操作或移動的 handler。身份邊界覆蓋完整，不代表完整 ownership／roles／state 或 bot 驗收已完成。

104 個含參數的 v2 操作透過來源內的實際呼叫綁定 19 個共用路徑契約。API 與前端使用同一份 Zod 驗證；前端保留原字串後編碼，不把版本號的解析結果寫回網址。數字版本在網路上仍是字串，schema 的 `x-qgroup-number-coercion` 與 `x-qgroup-parsed-schema` 記錄原本的 Number 轉型與整數範圍；bot 投遞編號的 BigInt 上限等 refinement 仍須執行 Zod。路徑契約綁定完整不代表 domain authorization 或正式切換已通過。
