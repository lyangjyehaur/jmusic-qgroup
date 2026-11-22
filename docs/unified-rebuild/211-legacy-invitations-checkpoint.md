# 邀請與管理交接的原請求恢復

2026-11-22。變更範圍 `web`，部署 `none`。本次沒有修改 schema、Python bot、正式資料、憑證或群設定，不合併 main。

## 完成的操作

`/me/local-history` 支援下列原操作；新版入口與原請求恢復共用準備／執行流程：

| 原方法與路徑 | 保留行為 |
| --- | --- |
| POST `/api/events/:id/roster/invitations` | 1–20 人、原稱呼／備註／原因；受邀者付款、不佔正式名額 |
| POST `/api/events/:id/invitations/:token/accept` | 單次接受、本人不可重複、原備註、安排回覆、明確接受候補 |
| POST `/api/events/:id/management/invitations` | 協辦／轉交、指定本人帳號、scope、原因、7 天有效期 |
| POST `/api/events/:id/management/invitations/:token/accept` | 原責任勾選、受邀帳號、結算人替換與職責保全、發起者交接 |
| DELETE `/api/events/:id/management/invitations/:itemId` | 按穩定 ID 撤銷待接受邀請及原原因 |
| DELETE `/api/events/:id/management/roles/:itemId` | 撤銷全部協辦職責；本人報名及活動查看權保留 |

沿用原 method、path、payload、key 和 Python JSON 簽名，必須具有原活動版本。舊邀請表單同時送出的 queue_mode／intent 保留在簽名中，像原程式一樣不影響邀請。保留 Python 空白清理（BOM 不被刪除）和原 payer 驗證。補報名接受只在原規則要求時驗證原安排版本，不能補造候補同意或管理責任勾選。

關閉報名仍可接受邀請，依空位填入，不提前提升既有候補。管理邀請有效時仍可在歸檔活動接受，保留原生命週期規則。結算人僅一位，替換保留他人的其他職責；接受包含 settlement 時才合併接受者原職責，否則替換。交接撤銷舊發起者全部待接受邀請，保留名冊、帳務及本人責任。

## 回執、權限與恢復

會員 scope、Origin、CSRF 及當前 roster／owner 權限先核對。私人活動可經有效受邀 token 核對接受；指定帳號限制先於預覽內容。精確原回執確認前重驗目前活動存取；補報名接受使用原序列化 `my_registration` 的人員 ID 和身份標記，並確認該人仍由目前帳號持有，不能以另一筆目前報名證明原 token 已接受。管理接受確認該 token 的 accepted_by 與目前帳號相符。相符回執不再檢查過期原版本、已消耗 token 或已刪除撤銷目標，也不再次寫入。

無回執的檢查只讀。重試重新核對活動、完整名冊、角色、邀請、稱呼及 bot 政策；必要業務、同意、通知、稽核、原 200 回執在同一交易，失敗全部回滾；可選 bot 掛鉤失敗保留必要業務。token 不出現在核對文案、回應 command 或恢復 mapping；接受預覽不顯示其他私人協辦。TSX 恢復保留來源 fingerprint、scope、装置世代、來源 CAS、離頁、登出及 mapping abort 保護。

## 本機驗證

證據目錄：`/Users/danersaka/.codex/rebuild-verification/legacy-invitations-211/`。全部使用隔離合成資料與模擬投遞。

- 9 檔／157 項單元測試通過；新增原邀請恢復 30 項。含 13 組固定原 Python `8da877857f163853c449474e168534e2e493121b` 的資料對照；僅標準化隨機 ID／token 和稽核陣列順序。
- 5 檔／66 項瀏覽器测试通過；其中新增 16 項。涵蓋全部 6 種原操作、轉交、回應遺失、改版、切帳號、離頁、登出、來源變更、裝置清除、mapping 交易中止及 360px 手機核對。`invitation-mobile.png` 已目視核對。
- 嚴格型別、建置及已建置 smoke 通過；HTTP 契約為 211 operations／101 bodies／346 named schemas／487 OpenAPI component schemas；166 個功能 ID 與 U01–U03 保留。
- 已建置原邀請 smoke：9 個原操作、5 則原 worker 模擬確認通知、3 個深連結；原請求重播新增寫入 0。
- 同一已建置 API 配合目前已核對的 Python bot 來源 `07defc429d619a7558ab7218372886f531813ae3`：532 次 HTTP、71 次原 worker、9 次新版 worker、314 個深連結，含勿擾、限流、重試、不確定投遞與依序交接，正常關閉。兩組驗證的 52 個原來源檔案及 API 運行產物雜湊一致。

初始測試的 fixture 欄位／稱呼預期、網路錯誤文案、延遲 route 的解除時機與裝置世代 fixture 失敗報告保留，已修正測試並完成上述回歸，沒有放寬服務限制。CI 已加入本次已建置邀請／交接與原 bot smoke；CI 的最終結果另記錄，不把本機報告當作 CI 成功。

這批屬本機驗收，並非真 QQ 或正式映像組合驗收。後續範圍見[本機交付收斂清單](completion-status.md)：身份／管理原操作收尾、跨功能與目前資料量驗收、最後全套回歸及可啟動的本機交付。正式部署不在本次任務內。
