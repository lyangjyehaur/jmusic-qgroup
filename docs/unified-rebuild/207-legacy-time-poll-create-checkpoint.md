# 原時間投票建立請求恢復

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；部署：`none`。保留 Python bot、資料庫 schema、outbox 格式、群政策與既有深連結。共用 contracts 的 bundle 已重新建置；以固定公開 Python bot 的隔離組合驗證，尚不代表正式環境實際 bot 版本的切換驗收。未合入 main，未部署。

## 恢復與去重

`/me/local-history` 新增原 `POST /api/time-polls` 的核對與恢復。完整原 method、path、body、requestKey、原 JavaScript body fingerprint 及 Python sorted JSON 簽名保留；不替換成新版 UUID 操作。保留原預設值、日期／精確模式、原時區、生效候選與順序、描述、費用、人數與群同步。日期模式原 `duration_hours` 保留在簽名內，按原規則不生效。時區不做會把無效原值改成有效值的 trim；原文字按 Python whitespace/codepoint 規則解讀，保留 Python 不會移除的 BOM。日期候選保持原字串驗證，不先 trim 為另一個有效日期。

原 React 草稿的 16 位十六進位識別與 UUID 均可保留到新版表單及建立識別查詢；新版新稿仍生成 UUID。原請求的其他可辨識 primitive intent 沿用原客戶端 truthiness 與字串轉換建立 canonical key；原本沒有 intent 的請求只使用原操作編號，不補造新識別。未支援、未知或不完整的格式保留為阻擋紀錄。

三種結果分開處理：

| 核對結果 | 處理 |
| --- | --- |
| 原 key／signature 有相符回執 | 核對目前投票發起者，只揭露投票位置；先於候選過期與截止檢查，不重送。已刪原結果仍須目前 owner。 |
| 同一 intent 已有原／新版投票，但原請求沒有相符回執 | 回傳 `existing`，不認定原請求已提交、不新增原回執、不重建。前端保存獨立的 `request-existing` 用途，重新載入亦不顯示「原請求已完成」。 |
| 沒有相符回執或既有 intent | 純讀取核對目前公開安排、候選、發起者及群政策；明確確認後以原編號重試。 |

非 alias 的原 key 被不同內容使用時拒絕；損壞、其他操作、無權或已刪 alias 均阻擋另一筆建立。原 key 與 canonical intent key 不同時，建立、原 201 回執及耐久 alias 同一 immediate transaction 寫入，不覆寫舊回執。並行不同原 key 的同一草稿也只建立一筆，其餘回傳 `existing`。

新版及原恢復共用純 prepare／execute 建立流程。核對不分配持久 ID，不建立試驗投票、活動或待送工作。群通知顯示實際目標與預覽，未來網址使用明示的「建立後的投票連結」占位，不補造原 proof。新核對 token 綁定原內容／識別、帳號、顯示資料、群政策及通知設定；變化後須重新核對。必要寫入失敗整筆回滾，含先成功的原回執及 optional jobs；可選 bot hook 的 savepoint 失敗保留投票與回執，不能宣稱通知已送。

## 本機原稿

修正原稿與建立請求的關聯：本機 sourceKey 後綴是 method／path／body fingerprint，與 intent 推導的操作編號分別驗證。轉換草稿只保存草稿的轉換用途；即使請求是相同 intent 或本機狀態標為 done，仍須逐筆查證 server 結果，不因帶入表單而解除請求限制。活動草稿的同一關聯修正也保留此限制。後續原請求可保存並識別，但原請求不重送、不中途標為已提交。

完成恢復後再核對已帶入表單的 canonical intent，可鎖定建立按鈕並開啟既有投票；使用者後續本機編輯不覆寫。查詢狀態綁定帳號 scope、intent 與原稿世代。既有 fingerprint、帳號／頁面／裝置世代、logout、來源 CAS、目的 mapping abort 及相同 pending／done 快照保護保留。未知、不同 fingerprint 或其他未核對原請求繼續阻擋。

## 驗證與限制

11 個 unit 檔案／174 個不同案例通過，其中新建立 adapter 22 個；既有原生投票、原 vote／manage 恢復、65 項投票角色矩陣、建立識別、本機稿、bot 群通知與 HTTP 契約案例保留並重跑。

5 個 browser 檔案／75 個不同案例通過，其中新建立恢復 14 個，既有 61 個。涵蓋原 date／exact payload／key、公開安排、原回執與 existing 的不同顯示、回應遺失、mapping abort、fingerprint／來源／帳號／世代、pending／done、登出、review 後別處已建立，以及 16-hex 原稿轉換後仍保持請求限制、恢復後原稿查詢不覆寫編輯。0 automatic retry／skip，360px 核對畫面無水平溢出。相同 pending／done 測試首次未等待 React 顯示第二筆便選取 controls，來源 CAS 正確拒絕舊快照；補上等待筆數與核對內容的步驟，新檔全數重跑，原 timeout／trace 保留。既有 authoring 測試的錯誤 sourceKey fixture 改用實際 fingerprint，並驗證原請求不再被草稿採用解除限制；沒有刪除案例或更改名稱。

strict TypeScript、建置、check:ui、built smoke 與能力 inventory 通過。203 個 HTTP operations／93 個 body、328 個 schemas、85 個權限來源 pins、162 個 contract inputs 均核對。13 份 runtime bundle 獨立逐 byte 重現；API／音樂來源 union 202 個、native union 138 個。

compiled API＋固定原 Python bot `8da877857f163853c449474e168534e2e493121b` 核對 55 個公開 blobs，新增原 date／exact 建立兩筆，原 reader 可讀 201 回執；另沿用原填答、群重送及兩種定案，產生兩場活動、兩份發起者報名／初始安排、兩則填答者通知。原 bot 的隔離 API 確認三則投票通知及兩則活動通知；共七份原回執、一份額外建立 alias、兩份 native 建立回執，重試 0 replay writes，沒有真實 QQ。

同一固定原 Python bot 的完整 compiled 隔離場景亦通過：71 次原 worker、9 次 native consumer、314 個深連結、532 次 HTTP 與 2 次限流延後，涵蓋投遞狀態保全、重試／不確定／模擬結果、交接與正常關閉。正式組合仍須另行驗收。

完整 inventory 為 209 個 unit 檔案／3,855 個預期展開案例、87 個 browser 檔案／931 個案例。Vitest list 的 1,772 個 declaration 並非完整展開案例數；browser 宣告使用 inventory-only 的 Umami 旗標包含既有條件案例，該 analytics 案例本輪未執行。

首輪 fixed Python 測試用了不存在的 schema module，改用隔離 synthetic DB backup；初次 build 的 dynamic uiText 違反既有靜態文字限制，改為各自的 literal；單元 whitespace 測試確認 JavaScript \s 會錯刪 BOM，已按 Python 字元集合修正。全部原失敗保留，未放寬正式校驗。

本輪相關 unit、browser、built API／舊 bot、來源與 runtime 驗證明細及原失敗報告放在 `/Users/danersaka/.codex/rebuild-verification/legacy-time-poll-create-207/`。完整功能驗收與發布 gates 保持 false；本輪沒有執行完整來源的全部單元／瀏覽器回歸。

原建立活動及其他尚未完成的舊命令 adapter、完整資料／權限對帳、正式規模、多副本、真實裝置／QQ WebView、切換後實際 bot 組合、P6／P7 仍需驗收。166 個功能能力與 U01–U03 不因此提升為完整通過。既有全部 917 個 browser 的 ID、名稱及行列 tuple 與 206 號宣告一致。獨立 verifier 已核對來源封存、contracts、runtime 與固定公開 Python blobs，提交後還會逐檔比對 Git blobs。CI 205 已完成通過；206 的 image 通過，unit／browser 在本輪最後核對時仍進行中，未取消或重啟。
