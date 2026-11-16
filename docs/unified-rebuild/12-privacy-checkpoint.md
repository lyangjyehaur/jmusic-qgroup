# 第六批實作：帳號關閉、成分刪除與持久恢復

日期：2026-11-17（Asia/Taipei）。分支：`codex/unified-rebuild`。發布範圍 **`none`**。本批屬 P1／P2 的隱私與資料基礎，推進 I14／I15、O05／O06／O12；沒有部署或操作正式 bot、憑證、資料庫、群設定及待送工作。166 項能力仍未完整驗收，不具備正式切換資格。

## 範圍與入口

帳號頁新增 `/me/privacy`，明確選擇「只刪除成分」「只關閉帳號」或「關閉帳號並刪除成分」。送出前列出實際範圍，要求無法復原確認。具有未交接的有效活動或 open／closed 時間投票時阻擋關閉帳號；單獨刪除成分不受此限制。所有判斷在後端 immediate 交易內重新檢查，不能靠前端停用按鈕保護。

- `GET /api/v2/me/privacy`：目前成分、未交接活動／投票數；必須有效帳號及相同 scope。
- `POST /api/v2/me/privacy/erase`：指定範圍、目前成分 ID／版本、確認、UUID 操作編號及獨立收據證明；驗 Origin／CSRF／scope。每 IP 每分鐘最多 6 次。
- `POST /api/v2/privacy/receipt`：只憑 UUID 與隨機 256-bit 收據秘密查詢最小結果；不依賴已撤銷的登入。每 IP 每分鐘最多 20 次。秘密只放 JSON body，不放 URL、日誌或回應。資料庫與 ledger 只保存秘密的 SHA-256。

結果僅包含操作編號、範圍及 `completed`／`shared_review`，不帶姓名、身份資料、選擇或共享紀錄明細。秘密不符與無收據均回同一 404。相同操作與內容回原結果，不再刪除後來建立的新成分；同編號其他內容回 409。

## 帳號關閉

全新 TypeScript 實作對齊原 `qgroup_core/privacy.py`：撤銷全部本人 session／grant、QQ 身份／UnionID／頭像、登入與跨裝置意圖、隱私同意、私人收款碼、通知、舊 mutation 結果、人工帳號備註及活動 access；撤管理角色並追加角色歷史。原來正使用此帳號的裝置，其其他帳號 grant 依舊版登出語意一併撤銷；其他正在使用別帳號的裝置僅移除此帳號 grant。

移除本人時間投票票單／選擇，僅對 open／closed 投票增加 vote_revision。保留 user 墓碑與原 ID，稱呼為舊相容字串「已注销用户」，替換成不可登入的隨機 token hash；不破壞共享外鍵、逐人名冊、帳務、不可變歷史或 outbox。

只關閉帳號時，成分與成分歷史保留，ownership 改為未關聯。這不等於成分刪除，也不承諾之後自動找回或合併；後續受控管理關聯仍待實作。原共享紀錄檢查之外，新增帳號操作、管理角色及成分歷史也列入待審，不能因活動已清空就聲稱所有資料已刪除。後台待審清單／處理介面尚未重建，本批只產生真實的待審狀態。

## 成分刪除與保存防復活

刪除選擇與該成分的修改歷史，保留穩定 ID 墓碑並解除 ownership；保留帳號、活動、帳務與其他會員資料。正常成分稽核仍禁止 UPDATE／DELETE，只有 profile 已標記 erased 時才能移除其歷史。建立新成分生成全新隨機 ID，不能復用墓碑。

所有音樂保存回執有 profile 對照；刪除時將其內容改為最小 410 `PROFILE_ERASED`，保留原 key／signature，舊重試不能回傳已刪選擇或重建資料。只關閉帳號則撤銷整個帳號的回執。

`SaveProfile` 新增必填 `profileId` 與 `musicEpoch`，搭配 revision 檢查。epoch 每次有效成分刪除增加，即使刪除前的草稿尚未建立成分、或新舊 profile 都是版本 1，也不能用舊稿直接覆寫／重建。使用者須明確核對目前狀態，再保存保留的輸入。既有開發版草稿缺欄位時以 null／0 安全解讀，可能需要手動核對；不靜默補成目前 profile 或沿用舊去重簽章。

刪除成功會清除此瀏覽器該 scope 的成分草稿並通知其他分頁刷新；伺服器 epoch 是無法收到通知／其他裝置的最後防線。session、編輯器與查詢快取均識別 epoch，避免已清稿的新編輯器從舊查詢快取重新載入選擇。廣播不帶姓名、選擇、token 或原帳號 ID。

## 持久刪除與圖片

每筆刪除在修改資料庫前寫入 `{dbstem}.erasures.jsonl`，檔案權限 0600，以 append／完整 write loop／file fsync／directory fsync 保存。內容只有內部 ID、時間、操作範圍及不可逆的收據／操作雜湊。檔案不得隨滾動 DB 備份一起回退；恢復副本須帶上最新 ledger。記憶體 DB 的 journal 只供隔離測試，不宣稱跨程序持久。

啟動建立任何 HTTP route／socket 前重播；沿用舊看板 `{user_id,request_id,created_at}` 格式的 account-only 意圖，並接受新版版本化意圖。全部重播在交易內完成，以獨立 applied marker 去重。意圖持久化後交易失敗會在下一次請求前恢復；持續失敗時連讀取／健康檢查都回 503，不能繼續服務舊資料。寫入／fsync 狀態不明會鎖住此程序，必須重啟核對 ledger；不假定失敗代表沒有寫入。損壞、未換行完整結尾或 symbolic ledger 路徑會阻擋啟動，不跳過內容。

帳號關閉移除未引用 image_assets；**提交之後**才在另一個 immediate 鎖內清理相容的 `images/{digest-prefix}/{digest}.png`，避免資料庫回滾卻已刪除檔案。保留仍被他人收款碼、結算碼或憑證引用的圖片；不跟隨 symbolic 子目錄／檔案。圖片清理失敗時也不回報完成，後續恢復重新嘗試。每套隔離 DB／圖片目錄必須成套放在獨立資料目錄；本批沒有建立完整備份／媒體匯入器，也不支援多個 web 程序各自追加同一 ledger。

## schema 升級

`rebuild_schema` 由 1 升為 2，接受帶指定基線 marker 的開發庫；無 marker 的舊站庫與未知版本仍拒絕直接修改。只重建新站自己的 music_profiles 為可空 ownership／erased_at，保持原 ID、revision、選擇、歷史及子表 FK。新增音樂回執對照、隱私收據、applied marker 與帳號音樂 epoch，共 68 張使用者表；凍結的 59 張看板表與觸發器不改。

升級回填舊音樂回執對照，逐項外鍵檢查失敗就回滾 DDL、資料與 marker。這是開發庫的單向升級，不是正式回退匯出器；舊重構程式不能直接重新開啟 schema 2。正式切換仍須另做來源匯入、映射、完整備份與相容回退演練。

## 本機證據

- `npm run test:rebuild`：75 項通過，本批新增 13 項 API／刪除／恢復測試與 3 項版本升級測試。
- 測試覆蓋三種刪除範圍、活動／投票阻擋、權限／確認／版本、6 次限流、墓碑／epoch／新 ID、舊保存回執 410、交易失敗恢復／持續失敗封鎖、fsync 不確定封鎖、實際 file-backed ledger 權限／恢復舊 DB／重播兩次、舊格式 journal、損壞與 symbolic 路徑拒絕、私人圖片刪除與共享圖片保留、票單清除與投票版本。
- 合成 DB 對原 Python `privacy.erase` 做差分：活動、名冊、活動歷史、帳務、結算、bot 設定／outbox、外部身份／UnionID、session／grant、刪除請求、角色及角色歷史逐欄相同。Python 比較使用實際相容 `foreign_keys=ON`。隨機墓碑 token 不作跨實作相等判斷，稱呼與登入失效另測。
- `npm run test:e2e:rebuild`：原 28 條與新增 6 條 Chrome 案例通過。覆蓋跨分頁刪除／建立全新 ID、關閉後未知回應跨刷新查收據、未交接阻擋、儲存失敗不送出／損壞紀錄保全、待確認操作不改用其他帳號，以及明確同時刪除。360px 截圖已人工檢視，無水平溢出。
- strict TypeScript、React／API 建置、乾淨空庫 built smoke、舊 UI 檢查及能力台帳驗證通過。前端目前約 509 kB minified，仍有 Vite 單 bundle 大小提醒；領域延遲載入尚未完成，沒有提高警告門檻掩蓋。

## 尚未完成

I14／I15 保持 `in_progress`：後台隱私審核、舊成分認領／關聯解除後管理、舊 music QQ-key erasure 匯入、歷史快照下載濾除、完整媒體／備份恢復、回退匯出、多裝置／讀屏與正式 bot 版本組合尚待驗收。沒有把新增 schema、模擬或差分結果當成完整 B01–B15 的替代驗收。

完整目標仍為完成既定 P1–P6 實作與驗收、**先不部署**。後續繼續救援管理與角色、匯入與成分找回，再推進其餘活動、同好、分房、財務、後台及 TypeScript bot。
