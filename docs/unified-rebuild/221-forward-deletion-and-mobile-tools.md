# 刪除後完整 forward 與手機工具驗收

2026-11-23。變更範圍 **`web`**：補全站回頂部及手機保存列避讓；另補隔離驗收紀錄。沒有修改 schema、outbox、bot 指令、設定或深連結契約。實際發布 **`none`**；不合併 main、不部署、不發送 QQ 消息。

## 同一正式副本的完整回復

沿用第 219、220 批授權隔離副本，來源 manifest `591a7209bf5ef07b3a79569a4abd411899660acfcf25b24ee1fb9e38098bbd7c`。以第 220 批固定舊成分站實際管理 HTTP 刪除及恢復後的資料、身份庫和 authority sequence 1 作來源；沒有重新擷取或修改正式資料。

本批完整執行既有 `projectNativeForwardErasures`、`reconstructForwardBusiness`、`reconstructForwardProofs`、`rebaseForwardSources`，並執行各自獨立的 reconciliation。所有輸入分別固定雜湊，原 v2 套件與 retained authority 重新核對未變。

獨立 Python 使用原 authority record／suffix bytes、原刪除時間與 ID 綁定核對，結果如下：

| 判據 | 結果 |
| --- | --- |
| 刪除範圍 | 11 張成分表僅刪指定 profile 的列；72 張不受影響表的值、SQLite 型別及 rowid 完全相等 |
| 各階段保全 | 登入、帳號、身份、通知、bot outbox／設定／runtime、活動、凍結結算及財務列保持原值 |
| proof | 這份副本沒有待確認 claim 或 frozen audit mapping；不虛構非空案例。除新增 migration run 外，業務表保持相等 |
| source rebase | 重建來源及綁定的 pins 核對相符；其餘 93 張表與 proof 產物完全相等 |
| 重複回復 | 再執行 erasure replay、由相同業務輸入重建 proof／source rebase；三階段各 97 張表的值、型別及 rowid 均相等 |
| 最新刪除 | 重建後當前匯出與 30 份歷史均不含被刪會員、建立者引用或喊話；身份來源不復活 |
| 圖片與 bot 外部檔案 | 4 個圖片檔、原壁紙 manifest 與原 bot 檔案 bytes 保持相等；此副本壁紙數為 0 |
| 再次封存 | 新 v2 套件 224 檔全部獨立核對大小／雜湊；新 authority 可讀取且原 unified ledger 保留 |

新私人套件 manifest 為 `ca4803d50869b6951036feef29696caf56f1713ab1b304f9ac21b21c512eb327`；新 authority manifest 為 `b262138260a053f767f02588423f2de3f4652898fd16af774fb6135d78bea759`。這是本機封存的新 baseline，sequence 為 0，沒有聲稱完成外部 ancestry／high-water／custody 認證。

產物維持 `recovery_required=1`。配對備份仍拒絕一般恢復啟用；沒有手動解除標記或啟動投遞者。這批證明完整資料及來源鏈的本機重建；完整原 web／music／bot 操作組合與經審核的 recovery activation 尚待完成。原始資料、腳本與報告全部保留在 Git 外的私人驗證目錄。

## 回頂部與手機保存列

原 C07 清單中的回頂部先前缺少實作，現加入共用 React layout。捲離頁首後顯示單一可及性按鈕；啟動後聚焦主要內容並回到頁首，保存原稿與選擇保持原值，不產生 mutation。一般設定使用平滑捲動，減少動效設定直接回頂部。

手機保存列根據 `visualViewport` 的高度及 offset 留在可視區域內；回頂部按鈕依保存列實際高度避讓，可視區縮小时暫時隱藏。保存列出現、變高或移除時重新量測，內容底部也留足操作空間。共用四項導覽維持頁首入口。

本機 12 個不同 browser 案例通過，涵蓋桌面、360px、保存後工具移除、長名稱不溢出、主題及兩份未保存跨領域原稿、壁紙管理／輪播／壞圖退路、鍵盤可視區與草稿保全；另將 3 個新案例加入明確的捲動動效斷言後重跑通過。沒有 Playwright retry、skip 或 flaky。

第一次桌面案例揭露「以整屏高度才顯示按鈕」使較短頁面捲到底也無按鈕，已調整顯示門檻並保留失敗報告及 trace。鍵盤案例驗證瀏覽器可視區契約，**不是實機 QQ WebView／手機軟鍵盤結果**。兩次建置、typecheck、既有 UI 檢查及已建置產物 smoke 通過。

## 父項與完整 CI

- C05：按原「管理配置與個人停用分開；移植後可用」條件完成本機父項審核。固定候選 API／wallpaper 12 項單元證據涵蓋原圖片 bytes／類型／網址、管理權限、原子回滾與 bot 表保全；本機 browser 驗證個人開關、共享設定、解碼／輪播及失敗退路。正式副本原壁紙清單為空，精確 manifest 已保全。
- C07：回頂部、手機固定保存、鍵盤可視區避讓、長名稱及減少動效完成上述本機父項條件。實機平台驗收保持獨立紀錄。
- C04：本批相關主題／原稿案例再次通過，維持已完成本機父項審核。

其餘 163 個既有父項及 U01–U03 仍待完整審核，不以測試總數代替功能驗收。既有 228 條款／939 成功案例引用索引仍綁原 `4fb6bbb86f12e1ef3e3569f1b31ed91573f1eaa1`，本批補充證據分開列出。

`d5363bde9505b5cfb28417a36010ff3415808e30` 的 [CI 45049853048](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/45049853048) 已取得三項工作成功終態及原 artifacts：unit **4,063**、browser **1,043** 全部通過，browser 無略過／重試／flaky。包含前批說明頁兩句修正；不包含本批手機工具。

`03d364f89b647315f4b8728f7c264610398d076b` 的 [CI 45053293001](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/45053293001) 映像成功，原產物已核對：52 個固定 Python source pins、6 個 harness pins、314 深連結、532 次 HTTP 呼叫，以及自然時鐘恢复、循序消費者交接、正常停止和清理。它使用 observed-source 重建 bot 映像；真正匯出的線上 bot 映像證據仍以第 219 批獨立紀錄為準。完整 unit／browser 終態尚待取得，也不包含本批手機工具。

P0–P6 最終驗收尚未完成，`originalP6Complete=false`、`releaseEligible=false`。本機預覽可操作；正式切換、真實 QQ 投遞與外部平台結果沒有冒稱通過。
