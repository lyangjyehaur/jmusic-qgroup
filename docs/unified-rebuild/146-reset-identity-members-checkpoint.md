# 重設後的身份會員恢復

日期：2026-11-20。發布範圍：`none`；只產生隔離恢復候選，不部署或替換 Python bot。

## 會員與原站語意

第 145 號恢復流程現在先在身份映像副本執行原 Python `Store.recover_profiles`、聯絡 QQ 及管理員關聯投影，再接入世代編號、業務資料、身份證據與 source rebase。原音樂 JSON、身份 SQLite、checkpoint、原生分支與 reset vault 全部保留並綁定原 pins。

原站 reset 只用記憶體中的 loaded members 清理身份。實際建立後已存入磁碟、但未載入的 native profile，可能留在 `native_profiles`，重啟時恢復。真原 Store 演練包含 unlink 後重新建立會員、聯絡 QQ、session、entry intent、磁碟保存及連續兩次 reset；恢復保留會員、關聯、聯絡 QQ 與原身份 rows。該會員的成分選擇仍為空：reset 已清空 JSON，身份 payload 只有建立時的空選擇，不能恢復 reset 前已刪掉的選擇。已列入刪除 authority 的會員若仍在身份映像則拒絕，不能藉重啟復活。

獨立唯讀 Python SQL oracle 推導所有 JSON 欄位及順序，不重跑投影 writer；核對 scalar types、浮點與負零表示，保留未知原資料。完整候選另核對 startup 產物、report、來源與晚期突變；report 不能放行登入或切換。

## 並行新增身份 rows

新舊分支可能在空 baseline 的同一 rowid 各新增不同會員。新增明確 derivation 只處理 `native_profiles`、`prelinks`、`profile_contacts`：兩個 QQ 都不在共同 baseline、共同 slot 原本為空時，保留 native rowid，將 old rowid 配到三來源最高值之後。每筆記錄 table、QQ、原 rowid 與 derived rowid；共同 key、共同 slot 或同一新 key 的衝突仍由原 business reconciliation 拒絕。

原身份映像保留；独立 oracle 核對十張表所有值、storage classes、signed IDs、schema、pragmas 與 `sqlite_sequence`。完整恢復候選核對 derivation、bindings、reports 與 projected pins；不用改動正式身份或 bot 待送資料。

## 驗證與瀏覽器修正

會員恢復 **19／19**、身份 rows **18／18** 通過。完整相關六檔 **131／131** 通過；逐名與固定上一版 inventory 及兩份新檔報告核對，合計 **7 檔／154 個不同案例通過**，零 failed／pending／遺漏。strict、能力台帳與 diff 檢查通過。完整新版本預期 **159 檔／2,581 unit**、**78 檔／833 browser**；完整 Linux 結果仍須依本次固定提交核對。

原會員首跑 3 個失敗與 row oracle 首跑 10 個排序失敗保存；修正選擇預期、處理真 rowid collision，並讓 bindings 按固定 table／原 rowid 排序，沒有省略完整 row oracle。

[第 145 號 Linux run](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44708648066) 的 browser 完整 inventory 核對為 **832 passed／1 timeout**，零 skipped／flaky；不能記為全量成功。原 artifact `14617487273` ZIP SHA256 `247e6eb156ecebe0ef54017a734c57869ecc2f05551a8bc5f7451bc3e9a38969`，CRC／99 個解包檔及 trace 保存。trace 證實裝置測試在 IndexedDB 完成讀取前用 textbox count 判斷是否需撤銷舊連結；頁面原有 ready 門檻正確阻擋了產生操作。測試現在等撤銷按鈕可用才判斷，替換已保存的第一條連結也等待實際操作按鈕，不改 timeout 或重試次數；原六個裝置案例 **6／6 一次通過**。

第 145 號 image 組合已獨立核對：web `sha256:fed2575f9a73c11ca74d331d03a34a7aef936ccee85e8dacff03608bb307eec2`、固定原 Python `sha256:589283c7f43913e1bf023d2081cc6b25b3697dadf46f5e316429cf548fafad8e`；artifact `14615763242` 原 ZIP SHA256 `9ca2ad0cafa2cf69b5d94cbd260bb6a04b67664486bb135242fcc5312c4036d7`，55 個原 Python blobs、175 runtime inputs、三模式 dispatch／callback／counters、52 deep-link shells 核對。image 成功不能代替失敗的 browser 或本批修改，也不能代替線上 bot／QQ 驗收。

## 尚未驗收

166 capabilities 保持 `in_progress`、0 accepted、`release_eligible=false`。仍缺其他 loaded／persisted-only 數字會員與身份差異、native global reset 後續世代／重複 epoch／確切 key reuse 的來源鏈、latest-erasure 私人歷史、外部 ancestry／custody／high-water、media／browser pending、真正停止來源 capture、完整 TS bot／實際版本組合／B01–B15／QQ／正式規模與 audited activation。這批不解除任何切換門檻。
