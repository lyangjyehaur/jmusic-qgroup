# 原逐人結算請求恢復

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；實際部署：`none`。沒有修改 Python bot、TypeScript bot 業務、schema、outbox 或既有深連結。共用 contracts 新增匯出會影響多個生成 bundle，已重新建置並驗證固定原 Python bot 的隔離組合；切換時實際 bot 版本的驗收仍未完成。

## 恢復流程

`/me/local-history` 支援原 `PUT /api/events/:id/settlement/detailed`。檢查保留原 method、path、完整 JSON、requestKey、base_revision、base_version 及 preview_token。已有相符原回執時，只檢查目前存取權與結算權限並確認完成，不返回凍結的私人資料，也不重發帳單、款項或通知。新回執使用舊 reader 可按目前權限刷新活動的 `{id,starts_at}` marker。

未提交的原請求必須通過原 Python 預覽算法。原憑證以帶空白的 sorted JSON 計算，與新版包含 event_id 的 compact JSON 憑證不同；禁止替換憑證或改成新版請求。帳本序號保持精確整數；原約定 JSON 的整數／浮點類型保留，例如 `2` 與 `2.0`。原約定與新版核對內容不同時拒絕恢復，不補造原證據。

原 editor 複製的已知顯示欄位留在簽名中；只按原規則取有效欄位。例如 shares 不採固定付款 amount，unpaid 不採 paid_amount，碼庫 ID 優先於同物件的 image／version。省略收款碼時只繼承同發布人的原版圖片；另一發布人不繼承。單張原 QR 的省略、null 清除、多碼衝突及原 PNG bytes 均保留。未知欄位及無法完整對應的憑證繼續阻擋，不能略過。

核對介面顯示逐人金額、付款歸屬、原附圖、隨單店家付款與群通知。使用者明確確認後，才沿原編號重試。新的 recovery_token 綁定本次核對、帳號、完整原簽名及目前顯示內容，不能取代原 preview_token；活動名稱或核對內容改變後須重新檢查。過期的原 revision／version 不自動更新。

新舊入口共用 settlement-command：不可變帳單與圖片、穩定 finance ID、稽核、通知與 bot hook 延續。原回執與全部必要業務寫入在同一 immediate transaction 完成；回執失敗全數回滾。相同內容 no-op 不增加帳單版本，並行與回應遺失不重複入帳。可選 bot hook 失敗仍按既有規則隔離，不能宣稱該通知已投遞。

前端保存原來源與 pending／done 快照，精確核對的來源才一起標記完成。切帳號、登出、來源 fingerprint 改變、世代改變、離頁及 IndexedDB abort 不會被記為恢復成功；未知請求維持原阻擋。

## 驗證

10 個 unit 檔案／133 個案例通過。新 adapter 16 個案例包含原 Python 五種分攤與憑證差分、原排序、原簽名、已知無效 operand、圖片與省略選擇、原碼庫優先順序、浮點約定及超過 2^53 的帳本序號、paid／unpaid 包間、隨單墊付、no-op、並行去重、native 憑證拒絕、過期版本、確認及身份限制、私密／損壞回執與全交易回滾。另重跑既有結算、碼庫、bot 通知、原款項與包間恢復及 HTTP 契約。

6 個 browser 檔案／87 個案例通過，0 重試／跳過；其中新 13 個；既有 74 個案例的 ID、名稱及行列位置與固定 CI 200／第 204 號原報告一致。涵蓋兩種原 body、完整原圖與群通知確認、正確帳本入口、相同原 pending／done 快照、回應遺失、映射 abort、過期版本、fingerprint／來源／帳號／世代限制、登出與 hash 期間離頁。360px 核對畫面及無水平溢出檢查通過。

strict TypeScript、建置、check:ui、built smoke 通過。199 個 HTTP 操作與成功回應、321 個 schemas、76 個權限來源 pins 完整核對；13 份 compiled runtime 可獨立逐 byte 重現，API／音樂 inputs 197 個，擴充 native input union 136 個。完整 domain authorization 與發布 gates 維持 false。

專用 compiled 驗證使用固定舊提交 `8da877857f163853c449474e168534e2e493121b` 的 55 個確切公開 blobs 產生真正原預覽憑證，經最終新版恢復入口保存原請求，再由該版本的原 bot 消費：一版帳單、一筆店家付款、一份原回執、4 則通知經隔離 API 確認與 3 張原收款圖；重試未增加帳務或 outbox。這項驗證已加入 CI。

最終 compiled API 與同一固定原 Python bot 的既有完整隔離場景亦通過：71 次原 worker、9 次 compiled native consumer、314 深連結、532 HTTP 及 2 次限流延後，含投遞恢復、模擬／不確定狀態與順序交接。兩項均禁止網路投遞，不是真實 QQ 或正式運行版本組合驗收。

宣告完整 inventory 為 207 個 unit 檔案／3,811 個案例、85 個 browser 檔案／895 個案例；只執行上述相關回歸，未宣稱這份來源的完整回歸已通過。166 個既有能力與 U01–U03 的完整驗收狀態不提升。

## 修正與限制

原失敗報告保留。首輪比較了 Python set 的通知流水號順序與 JSON 空白格式；改為逐收件人及解析後完整 payload 核對。合成約定／finance party／碼庫請求曾缺必要欄位，均修正測試資料，沒有放寬正式驗證。首次 browser 載入了包含 server imports 的 PNG fixture，改用同 bytes 的固定合成 PNG。錯誤文案生成器要求固定 constructor，已使用明確 DomainError，沒有更改生成器規則。

HTTP 新增操作後更新精確 inventory 斷言。亦修正上一份來源 OpenAPI 測試仍停在 195 操作／85 body／445 components 的舊數字；完整保留原失敗。專用 compiled fixture 首次 Git blob buffer 太小、其次暫存來源名稱不符隔離規則，修正工具容量與 fixture 名稱後通過。

證據目錄：`/Users/danersaka/.codex/rebuild-verification/legacy-detailed-settlement-205/`。原 CI 203 已全部通過。原 CI 204 的 image 通過，unit 3,793 passed／2 failed／0 skip，browser 在本輪核對時仍進行中；沒有取消或重啟原 run。兩個原失敗均為 HTTP 盤點斷言仍停在 195，而該份固定來源已有 197 操作：OpenAPI 與前端路徑解析。原報告及雜湊保留，已更新到本輪 199 操作；這兩份原失敗檔案共 37 個案例通過，原測試名稱與功能案例均保留。

其他原命令 adapters、完整來源與資料對帳、正式規模、多副本、實際裝置／QQ WebView、切換後實際 bot 版本組合與 P6／P7 仍待完成。沒有合入 main，也沒有正式部署。
