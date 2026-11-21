# OpenAPI 驗證 schema

`openapi-3.1.json` 取自 OpenAPI Initiative 的 [OpenAPI 3.1 schema（2022-10-07）](https://spec.openapis.org/oas/3.1/schema/2022-10-07)，保留原始位元組。SHA-256：`da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0`。

授權為 Apache-2.0；[原授權來源](https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/LICENSE)的完整內容保存於 `LICENSE.openapi.txt`。此檔只用於建置／測試的文件格式驗證，不代表業務授權或正式發布門檻已完成。

`http-access-review.json` 是人工核對的身份邊界及來源 SHA-256，涵蓋初批 36 個操作。來源檔案、handler 或中央 guard 改動後須重新核對描述再更新 pins；生成器拒絕過期 pins、缺少操作或移動的 handler。這不是從函式名稱推論的授權策略，亦不代表完整 ownership／roles／state、路徑或 bot 驗收已完成。
