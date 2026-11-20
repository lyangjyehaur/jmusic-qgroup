# 重設後會員失效與回退保全

日期：2026-11-20。發布範圍：`none`；本次修改新版 web 查詢與隔離遷移／回退工具，共用資料及 bot 依賴按 `both` 評估，尚不發布任何服務。

## 已實作

第 148 號的 `retained_history_only` 處置已接入 native 失效模型。使用既有 `music_documents.profile_retirement` 與 `migration_runs` 保存來源 pins、原 profile digest 及逐次 reset／completion 證據；schema 維持 15，不以 `erased_at` 假冒隱私刪除。原擁有者解除、會員 revision 和擁有者 music epoch 增加，原保存回應失效為 410；原欄位、選擇、來源、不可變歷史、認領 intent、回執及 bot 工作完整保留。另返回原 native image 與第 148 號全部私人來源，不改原檔。

處置前比對 checkpoint 與 native 的該會員完整 typed rows／rowid，包含直接 FK 表、原來源、身份、相關 entries、proof attempts、配對請求結果、epoch 及隱私請求。同一會員已有 native 新寫入時拒絕處置並保留兩個來源。時間不得早於記錄中的原 reset。獨立 verifier 不重跑 writer，從原來源推導允許的唯一差異，逐表核對全庫原 rows、storage classes、rowid、schema、FK、sequences、原 retained image、journal、marker 與回執。

有效會員查詢、匹配、詞條人數／名單、圈子、統計、趨勢、分房來源、欄位、認領與管理写操作排除失效會員。舊 epoch 不能保存；新空白成分使用獨立 ID，原別名仍保留。當前找搭子列表／detail 不再顯示失效作者的現行帖子；原帖子仍存在，歷史與管理 detail 可核對內容但不投影其聯絡／身份權限。歷史匯出保留原內容，依最新狀態清除 owner／PIN／contact。真正隱私刪除仍可處理失效資料，刪除退休 marker 並使用原 tombstone／journal／receipt 流程。

完整回退 assembly 已支援失效 keys，不輸出其 member、prelink、link、override 或 native recovery payload；聯絡別名作為 inactive orphan reservation 留在原 identity 投影，避免被其他 profile 使用。原 audit／history 與全份 native checkpoint 保留，失效本身不產生隱私 erasure ledger。原 Python Store 的實際恢復、contacts 及 admin_links projection 驗證沒有復活會員；bot 原工作保持相同。

## 驗證

新增 **17／17** 案例通過，包含真 persisted-only 原 reset、原 native／未知來源保全、新寫入衝突、epoch、完整回退、舊 Store 恢復、inactive 聯絡預留、歷史／當前帖子存取、後續真正隱私刪除及重新釘選的 fields／selection／history／bot／marker／owner 篡改。既有行為與恢復回歸 **326／326**；原報告逐名核對共 **22 檔／343 個不同案例**，沒有把重跑的同一案例重複計數。開發中測試錯誤及修正前報告另外保留，不宣稱每次嘗試均成功。

第 146、147、148 號完整 CI 均已 terminal success。其原 unit／browser ZIP 經 metadata digest／size、CRC、全部提取 bytes 及固定逐案 inventory 核對：分別為 **159／2,581**、**160／2,587**、**161／2,602** unit files／cases；三版均 **78／833** browser files／cases，零 skip／retry／flake。第 148 號固定 `6368c57c7787fdee2886642e1ca62e5448a8e965`、run `44720903382`，原 job logs 保存並釘選；unit ZIP `369d7a9c407dfe7ea43ffeedb7decbfc0b19df7128fb7528876055371a99e77a`，browser ZIP `ae030eab6ab4c12c3b37733b01d45878e375db0708a57aab8d9a1b76be368dfa`。第 148 號 image pair 與 compiled development Python 報告亦獨立核對 55 個原 blobs、175 個 runtime inputs、三模式 counters／dispatch 與 52 入口；此為隔離演練，實際 QQ／線上 bot 版本組合未驗收。

本批完整固定來源預期 **162 檔／2,619 unit**、**78 檔／833 browser**；本機相關回歸不能代替這一版的全量 CI 結果。strict、功能台帳、diff、完整建置及實際 built API／TS bot／隔離 SQLite／blocked recovery smoke 通過；compiled web 與固定原 Python 的三模式演練亦通過，176 個 runtime inputs 與產物另行釘選。

## 仍須完成

本次 native 失效與回退步驟已完成；`nativeDispositionApplied=true` 僅代表該步驟。**尚未接入整組 forward business／proof／source-rebase 恢復**。第 147 號整組 missing-member gate 繼續拒絕這一場景；不能用失效回執跳過它。完整恢復須先以原 checkpoint／native 独立檢查新寫入，再準備一致的失效 baseline 與 native fork，從私人派生 identity 移除 active recovery rows，保留原完整 image／contact reservations，並讓 rebase 保留退休來源與歷史。

来源鏈／high-water、重複 reset epochs、exact key reuse、latest-erasure 私人歷史、media／browser pending、停止來源 capture、正式規模、實際候選版本組合、B01–B15、QQ 及 activation 尚未完成。正常服務仍拒絕 `recovery_required=1` 候選；166 capabilities 維持 `in_progress`、0 accepted、`release_eligible=false`。保留 Python bot，不合入 `main`、不部署。
