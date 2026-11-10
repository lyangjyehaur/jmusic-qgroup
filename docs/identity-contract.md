# 身分、QQ 登入與報名認領（20261109-auth1）

QQ OAuth 登入、回調、get_user_info 暱稱讀取及既有帳號綁定已實作；應用仍待官方審核，真實授權尚待本人驗證。不以稱呼證明 QQ 身分，不合併兩個帳號的資料。

## 訪客、註冊與管理後台

- `GET /api/me` 僅建立 24 小時訪客 session，不新增 users。公開活動可瀏覽，發起、報名及成員寫接口須已登入。
- 預設 `allow_name_registration=false`：新帳號須完成 QQ 官方身分驗證，返回並明確確認後才建立；單純 callback 不建立帳號。稱呼可另外修改，不作身分依據。
- `external_identities` 以 `(provider, client_id, subject)` 唯一對應站內 user；不同平台或應用的 OpenID 不混用。同一帳號可另行明確綁定不同平台。微信只預留資料結構，尚未實作 adapter 或入口。
- 管理後台 `/admin` 支援明確授予的帳號管理員權限；一般帳號、稱呼及活動協辦角色不授予後台權限。管理員登入站內帳號後可直接進入後台。首次授權及恢復仍可使用長隨機管理憑證登入；伺服器 `/etc/qgroup/admin.env` 僅保存 SHA256 摘要 `KANBAN_ADMIN_KEY_HASH`（root 0600），原始憑證僅交付管理員私下保存。輪替摘要會立即撤銷舊憑證管理 session。
- 憑證管理 Cookie 為 HttpOnly、Secure、SameSite=Strict，有效一小時；帳號方式沿用站內登入 session，每次請求重新檢查當前帳號及管理員權限。寫入須同源、管理權限、CSRF 和對應設定版本；帳號 CSRF 綁定 session、帳號 ID 與授權版本，切換帳號、撤銷及重新授權後舊頁面的寫入失效。
- 「用戶管理」以稱呼、完整站內帳號 ID、第三方綁定暱稱及註冊時間辨識帳號；可搜尋並分頁，每頁 20 筆，不傳回 OpenID、UnionID、Cookie 或憑證摘要。`GET /api/admin/users` 讀取列表，`POST /api/admin/users` 以 `user_id`、`is_admin` 和 `base_revision` 修改角色。
- 用戶列表顯示每個 QQ 身份是否取得 UnionID，並支援已取得／待補齊／未綁 QQ 篩選。狀態依完整 `(provider, client_id, subject)` 關聯，僅回傳布林值；多個 QQ 身份中任一缺少 UnionID 即列入待補齊。此狀態不代表群成員資格或已完成 bot 身份綁定。
- 管理員可授權其他帳號及撤銷其權限；不能撤銷當前以帳號登入的自身權限，須由其他管理員或獨立憑證操作。角色及追加式 `admin_role_history` 同事務提交，註銷帳號會撤銷角色並保留審計；已註銷帳號不列入用戶列表且不能重新授權。
- 帳號方式退出管理後台會同時登出當前瀏覽器帳號、清除獨立管理登入；其他裝置保留。憑證方式退出僅清除獨立管理登入。Migration 14 新增角色及歷史表，預設不授權任何既有帳號，重複遷移保全原資料。註冊政策及追加式管理紀錄在同一事務提交。
- 只有管理員開啟開關後，`POST /api/register` 才接受稱呼與明確確認。直接呼叫 API 不能繞過關閉設定；再次關閉不刪除既有帳號，也不禁止它們修改稱呼。
- Migration 8 新增訪客、通用外部身分、登入請求、設定及管理紀錄，複製舊 QQ 綁定，保留所有舊資料。正式公開前的測試庫及配對圖片另外封存，再由既有服務建立空白正式庫；此清理不是 schema migration 的一部分。

## 帳號與裝置

稱呼設定頁的「帳號與裝置」可產生 10 分鐘、一次性的裝置連結。產生與接受均須明確勾選，只應在自己的裝置間使用；持連結者將能存取此帳號的活動與帳務。接受僅向目前瀏覽器 session 授權，不改變當前帳號、不搬移資料。原帳號與新授權帳號列出稱呼及識別尾碼，由使用者明確切換。重新產生連結會撤銷舊的待用連結。

切換保留目前帳號授權，更新 session 指向；Cookie 仍為 HttpOnly，後端只存其摘要。舊分頁的 `X-Kanban-Identity` 與新身分不符，寫入與結果查詢拒絕，須刷新；各帳號草稿與未確認操作保持隔離。表單開啟或稱呼未儲存時不允許從介面切換。切換回應不確定時，先查 `/api/me` 再決定刷新。

帳號可查看已授權裝置並撤銷其他裝置。撤銷會移除此帳號在該 session 的授權；若該裝置正在此帳號，切回其保留的其他帳號，無其他帳號才移除該 session。其他帳號、活動與款項保留；同時撤銷此帳號尚未使用的連結。不可在此撤銷當前裝置。產生、接受、切換、撤銷均有追加式操作紀錄。

這是「保留一台已授權裝置」的找回方式。所有 Cookie／授權裝置都遺失時，不能只靠稱呼找回；不提供不安全的人工帳號接管。

| 接口 | 行為 |
| --- | --- |
| `GET /api/account` | 當前 session 可切換帳號、當前帳號裝置與最近操作紀錄 |
| `POST /api/account/link` | `authorize_device:true`，產生限時連結 |
| `GET /api/account-links/{token}` | 有效連結的稱呼與到期時間；不含帳務 |
| `POST /api/account/accept` | token、`accept_access:true`；一次性授權目前 session |
| `POST /api/account/switch` | 已授權帳號的 scope；不接受任意帳號 ID |
| `POST /api/account/revoke` | 目前帳號列表中的其他裝置 ID |

## 代報認領

原管理人或具報名權限的發起人／協辦，從該參加者的「管理」發出七天認領連結，先由對方申請，再由管理人透過群內溝通核對並同意。邀請、申請、同意／拒絕／撤銷均保存活動紀錄；申請與決定產生站內通知和動態待辦。連結可以查看並手動複製。

僅未綁帳號、有效的正式／個別候補／個別待確認可認領。整組候補／待確認須先由管理人協調轉正式，或在可用操作中改成分開排隊，再認領，避免混合管理權導致越權確認其他成員。歸檔後須先取消歸檔。重發會撤銷先前待用／待核對邀請；原邀請人失去當前管理權後，該邀請不能再提交申請。

持 token 只能預覽活動標題、這位參加者、原付款責任與期限。尚未核對通過，不會獲得私有活動、完整名單、歷史、帳務或圖片權限。同名不同帳號不互認。認領成功後，原連結僅對該申請人顯示完成狀態及本人報名入口。

申請與同意時均檢查是否已有有效本人報名。如果有，先明確處理重複項：核對後取消多餘的本人報名（逾期由管理人處理），再回到原連結申請；不自動合併位置、不自動移款。既有預收款仍留原付款帳號，結算時明確分配／更正，保留沖銷或調整紀錄。若已發布帳單或有需協調的費用，不允許藉認領靜默抹除原責任。

同意只更新原 attendee 的 user_id、manager_id、updated_at。ID、名額、party、入隊順序、狀態、已接受的約定均保留；認領不重跑排隊、不重算帳單、不改已存帳單快照、收款、退款或憑證。

認領前報名的預設付款 ID、付款人名稱與原付款帳號追加凍結；已有帳單若另設多人合付或自訂付款人，以該帳單版本為準，認領不改其分配。預設歸屬如下：原代報者統一付款，仍由原帳號負責；原參加者自己付款，仍使用 `person:{attendee_id}`，改由認領本人管理與申報。原管理人不再能管理被認領的報名或申報其本人付款，但自己原有的代付責任保留。其後要改付款歸屬，須核對並保存新的結算版本，不覆寫凍結來源。原付款人不再代管任何參加者時，仍可查看自己的款項、收到通知，並在「我參與的」找到有本人餘額的活動。

| 接口 | 行為 |
| --- | --- |
| `POST /api/events/{id}/claims` | attendee_id、原因與 base_revision，管理人發出邀請 |
| `GET /api/events/{id}/claims/{token}` | 限定預覽；成功後僅本人可讀完成入口 |
| `POST /api/events/{id}/claims/{token}/request` | base_revision、`confirm_identity:true`、`keep_payment:true`，須有稱呼 |
| `POST /api/events/{id}/claims/{claim_id}` | base_revision、decision、原因；同意另須 `confirm_person:true` |

所有新寫入要求請求去重鍵，在同一事務內保存業務、歷史、通知及結果；版本競態、雙重申請、過期／撤銷、失權、審計失敗均不留下半筆認領。

## 遷移

Migration 5 僅新增 browser_accounts、device_links、account_audit、attendee_claims、attendee_payment_origins。原資料逐欄逐值保全，不重算舊結算。account_audit 與付款來源表有 UPDATE／DELETE 禁止觸發器；完整 SQLite 備份包含授權、認領、所有帳單版本、圖片與金流。


## QQ 登入與綁定

- 只申請 `get_user_info`，使用 `(provider=qq, App ID, OpenID)` 辨識帳號，不取得 QQ 號碼、群名片或群資格。2026-11-10 起 QQ 互聯應用已開通 UnionID 介面權限，`/oauth2.0/me?unionid=1` 回傳值會寫入 `external_unionids`（schema 12），供日後與機器人 `author.union_openid` 比對；**站內帳號辨識仍以 OpenID 為準**，UnionID 只做跨應用核對，不自動合併帳號，且機器人側需等 Union_openid 綁定核准並實機驗證兩邊數值是否相等。
- 首頁活動列表上方的官方「QQ 登录」按鈕直接進入登入頁，個人資料的「登录与账号绑定」保留同一入口：已有活動請用「绑定到当前账号」；「使用 QQ 登录账号」進入該 QQ 綁定的帳號，首次使用會建立獨立帳號。
- `POST /api/auth/qq/start`：`mode=bind|login`、`confirm=true` 與同源首頁 `return_path`（可帶原活動／邀請查詢參數），遵循既有同源、身分與請求去重檢查。state 為隨機一次性值，庫內只存摘要，綁定發起 session、帳號（訪客可為空）、provider、App ID 及 10 分鐘期限；同裝置新授權使舊授權失效。
- `GET /auth/qq/callback`：無參數時顯示說明，不建立帳號；合法回調須原瀏覽器 Cookie、原帳號與 state 一致，先消耗 state，再由後端交換 token、核對 App ID／OpenID 並讀取暱稱。失敗或取消不綁定、不切換。HEAD 不消耗授權。
- `GET /api/auth/qq/status`：僅回傳當前 session／帳號的授權狀態和確認所需暱稱；不回傳 OpenID、token 或 App Key。
- `POST /api/auth/qq/finish`：須 `attempt_id` 與 `confirm=true`。使用者核對後才綁定或登入；已綁別的帳號或當前帳號已有其他 QQ 時，拒絕替換及合併。
- 完成後輪替 HttpOnly session，撤銷舊 Cookie，保留該裝置原有各帳號授權。活動、名額、付款人、帳單與帳務不改動，QQ 暱稱不覆蓋既有群內稱呼。新帳號才以 QQ 暱稱建立初始稱呼，然後回到原活動／邀請網址。舊 `/api/account/qq/*` 路徑保留相容。
- 已登入且已綁當前 QQ 應用、但缺少 UnionID 的舊帳號，進站時顯示更新登入資料引導；已有表單、邀請、活動或回調確認視窗時延後顯示。主按鈕直接以 `mode=bind` 重新授權原 QQ，不先登出、不自動切換帳號，並保留原活動／邀請返回地址。使用另一個 QQ 仍受既有衝突檢查阻擋。
- 引導說明缺少 UnionID 會影響 bot 對應站內帳號及需識別個人帳號的功能，公開活動查詢與網站功能仍可使用；不承諾已開放尚未完成的 bot 功能。允許稍後處理，以瀏覽器本機的帳號 scope 記錄 24 小時提醒間隔；「帳號與裝置」始終保留手動更新入口。未綁 QQ、訪客、已有 UnionID 或 QQ 未配置時不提示。
- 完成 QQ 授權後若仍未取得 UnionID，顯示未取得的結果並暫停自動提醒，保留原登入與重試入口；有取得才顯示更新成功。不把介面權限開啟視為每次回應必定帶值。UnionID 仍只在伺服器保存，前端只讀 `unionid_bound`／`needs_reauth` 布林狀態。
- 綁定／登入、session 輪替、一次性授權使用與帳號審計同交易；審計失敗全部回滾。登入後舊分頁寫入須刷新。沒有任何可用 Cookie 時，只有已綁 QQ 且能完成官方授權才可找回該帳號。
- App Key 僅由主機 `/etc/qgroup/qq.env`（root 0600）讀取。token 只在後端短暫使用，不保存、不傳給瀏覽器；回調 code／state 不寫日誌。官方 HTTPS 請求限時、限回應大小且不跟隨重新導向。
- Migration 7 僅新增 `qq_accounts`、`qq_attempts` 和索引，原資料逐欄逐值保全。

官方文件：[get_user_info](https://wiki.connect.qq.com/get_user_info)、[OAuth 授權流程](https://wiki.connect.qq.com/使用authorization_code获取access_token)、[網站審核規範](https://wiki.connect.qq.com/网站审核规范)。接口「已获取」不代表應用已上線；未通過審核時是否允許測試授權，以平台實際回應為準。正式放行、真實 QQ／手機回調及跨裝置找回需實際驗證。

最近真實授權返回 100008「該網站尚未開通 QQ 帳號登入」；自動化測試使用模擬官方回應，只證明程式流程，不能視為真實 QQ 授權成功。
