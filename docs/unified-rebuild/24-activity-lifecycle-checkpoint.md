# 第十八批實作：活動狀態管理

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：只做隔離實作、驗收及原始碼同步；未部署、未整合 main。活動狀態、通知與 outbox 屬跨服務契約，未來切換仍先按 **`both`** 驗證。

## 已實作

統一活動詳情依目前會員權限提供「管理活動狀態」，直接進入同一 React／TSX 表單。`GET／POST /api/v2/activities/:id/lifecycle` 及 `GET /api/v2/activities/lifecycle-results/:requestId` 使用 TypeScript API、帳號 scope、CSRF、原 revision、明確確認與原子去重收據。

- 暫停／恢復報名保持與實際生命週期分開。截止或排定開始後拒絕恢復；只有實際開放報名才執行原嚴格 FIFO／整組候補遞補。已有 settlement 阻擋切換報名開關。
- 發起者確認成團；低於最低人數必填原因，不自動取消。已確認不重複通知與版本。
- 明確記錄實際開始／結束時間，關閉報名並通知原報名管理人與協辦。排定時間到了不寫入實際開始／結束；已實際開始或結束的重複操作保留原時間。
- 取消必填原因，保留名單與帳務；允許依原規則取消未歸檔的已結束活動，不把已有結算擴大為所有狀態操作的禁令。
- 只有實際結束或取消的活動可歸檔／取消歸檔。歸檔後其餘操作先要求取消歸檔，保留原結算更正的獨立語意。
- 受限移除仍檢查 settlement／history／finance entries／reports、所有其他人的報名（含退出、訪客與代報）及協辦。只標 deleted、關閉報名及 bot 同步，取消各 channel 的 pending／sending；不刪名單、資金或凍結 payload。owner 可讀最小移除狀態及查回原結果，其餘活動入口與其他人仍 404。

發起者專屬：成團、取消、歸檔／取消歸檔、移除。日程協辦只可暫停／恢復／實際開始／結束。網站管理員協助修改安排不因此取得生命週期權限；邀請活動仍逐次驗存取，不用管理員或協辦身分繞過 access。收據回放及查詢重新驗目前權限，撤權後不能依舊 key 使用舊權限。

通知取有效名單（包括 invited，不含 withdrawn）的 distinct manager_id，加所有 event_roles 成員後去重；不額外推測每個 user_id 或發起者一定需要站內通知。

## 恢復與交易

原稿以帳號／活動分區保存。提交前同步保存原 revision、action、reason、完整 payload 與原 key；儲存失敗不發請求。結果未知鎖定表單，重新整理後重用相同 key／payload；完成移除也能查回，不以不存在的活動詳情作為結果判斷。

409 保留原操作與原因，需明確核對最新狀態再勾選確認；修改欄位／重讀均重設確認，確認不跨重整保存。損壞原稿先保全 recovery 副本。離頁保留原稿、跨帳號拒絕舊 scope、跨分頁登出清除原稿；延遲回應不能重建私人資料。

狀態、名單遞補、通知、audit、待送取消與收據同交易；必要寫入失敗全部回滾。optional bot hook 使用 savepoint，失敗只記錄錯誤，不留下部分提醒重排或破壞業務寫入。

## Bot 相容性與驗證

狀態 hook 維持原順序：檢查公開群同步、重排提醒、合併最終遞補名單，再按狀態建立 pause／resume／formation／started／finished／cancelled 卡片。歸檔不新增卡片；結束／取消作廢未送提醒；保留已發送、失敗及模擬工作，不重播已完成事實。

新增 **16 項後端案例**：三組完整原 Python 差分、恢復後遞補、分權與邀請隱私、revision／原因／狀態限制、通知對象、重試／撤權、受限移除、必要失敗回滾及 optional bot 隔離，另有六種通知各自交給保留 Python worker 的 plain／rich／dry-run 消費。所有輸入皆為合成資料及隔離備份，使用無網路 Mock transport，不讀正式憑證、不對真群投遞；二次 poll 不重送。

新增 **7 項 Chrome 案例**：從詳情管理全流程、未知結果原 key／payload 恢復、較新狀態核對、移除後恢復、儲存失敗及損壞原稿、帳號切換、跨分頁登出與延遲回應。已檢視 360px 截圖及橫向溢出。

全套後端／領域／資料庫 **231 項、32 檔**及 Chrome **119 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables；前端約 **632 kB**，既有 500 kB 警告仍待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 尚未完成

E06–E09、B04／B05 僅記 in_progress。全部活動操作歷史／通知收件匣、完整報名／退出／邀請／代管／認領與轉交、當地時區完整 UI、分房／結算／財務／投票／音樂剩餘功能、全部舊入口及 TypeScript worker 仍待完成。原 Python worker 的合成消費不等於真 QQ 或 B01–B15 驗收。正式副本遷移、切換／回退組合及完整讀屏／WebView 驗收仍待辦；台帳保持 **0 項完整通過、release_eligible=false**。
