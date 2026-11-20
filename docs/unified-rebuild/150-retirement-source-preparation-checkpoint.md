# 會員失效的前向恢復來源準備

日期：2026-11-20。發布範圍：`none`；只新增隔離來源準備工具與測試，不修改正式服務、bot、原憑證或原待送工作。

## 已實作

新增 `prepareForwardResetRetirementSources` 與獨立 verifier。先在未經 global reset 投影的原 native image 執行第 149 號失效檢查，阻擋同一會員已產生 native 新寫入的情況；再從 authority 的真正 baseline unified journal 釘選原 checkpoint 的 journal，獨立準備 retired baseline。不能以目前 native image 或 native journal 充當共同 baseline，也不使用假設的空 journal。native journal 必須是該 authority 已記錄內容的前綴。

派生舊 identity image 移除 `retained_history_only` keys 的 sessions、entry intents、links、prelinks、overrides 與 native recovery payload。其餘原 rows、storage classes、rowid、schema、metadata 與 sequences 完整保留，包含 link audit、used OAuth 與限流歷史。原 contact reservation 不啟用身份；缺少原 contact row 的退休會員從 canonical native contact／數字會員的隱含號碼建立 inactive reservation，原 rowid 完整保留、新 rowid 採明確 high-water。與原 contact 不符時拒絕並保留兩個來源。

兩個退休分支各自返回原 native／checkpoint image、原完整 identity／JSON、逐次 persisted／loaded／completion bytes 與第 148 號處置；不改原檔、不把 raw sources 接到下載或登入入口。verifier 不重跑 writer，獨立核對兩個退休來源及完整原 identity rows，從原資料推導允許的刪除／新增 reservation，對原來源、authority files 與所有輸出持續加上邊界檢查。

## 驗證

新增 **8／8** 案例通過，原 Vitest 宣告與最終 JSON 逐名核對；涵蓋真正原 baseline journal、baseline 與 native additions 分離、實際 native 新寫入衝突、原資料／歷史／contact reservation 保全、重新釘選的復活／contact／audit／rowid 篡改、偽造 baseline journal／native 分支替換／activation 及晚期原來源／輸出修改。strict、功能台帳與 diff 檢查通過。schema 與實際 runtime 依賴未變更；本批完整來源預期 **163 檔／2,627 unit**、**78 檔／833 browser**，尚須核對本批固定提交的全量結果。

第 149 號固定 `c634264bbcc7c3847d8ccebbd150742c08c75a8f`、run `44730897901` 已 terminal success。原 ZIP 按 metadata digest／size、CRC、全部提取 bytes 及固定 inventory 獨立核對：**162 檔／2,619 unit** 與 **78 檔／833 browser** 全通過，零 skip／retry／flake。unit ZIP `a5d4697207c3892cae58ff35fe09bdf85f12f7608dfdac50c1fa41f12ce813a0`，browser ZIP `95c6cc38e621d6fb437edd4cbffd7f9ff7fdf90dfee15b5714ccefce4c026c08`；三個原 job logs 已保存並釘選。原 image ZIP `505703dab955dc136954bc236730635ae16b71ac222e792c6cc989b28118b39f` 亦完整核對，再獨立驗證 55 個原 Python blobs、manifest／harness、三模式、85 HTTP calls、10 次原 worker、52 入口與清理。compiled development Python 報告另核對 176 個 runtime inputs、原 blobs、三模式 counters／dispatch 與入口。這些是隔離測試；實際線上 bot 版本組合及 QQ 尚未驗收。

## 仍須完成

本次只完成退休 baseline／native fork 與私人派生 identity source，**尚未執行 global reset、business、proof 或 source rebase 的整組退休恢復**。回執明確保留 `globalResetProjected=false`、`businessProofAndRebasePrepared=false`、`recoveryRequired=true`、`releaseEligible=false`；第 147 號整組 gate 保留。下一步須將兩個退休分支先接原 erasure／global reset 投影，再準備 ForwardMusicInput；business／proof／rebase 對退休 mapping 必須保留 source／history、避免把缺少 current member 當成真正隱私 erasure 或刪除原來源。

完整来源鏈／high-water、重複 reset epochs、exact key reuse、latest-erasure 私人歷史、media／browser pending、停止來源 capture、正式規模、實際候選版本組合、B01–B15、QQ 與 activation 仍未完成。166 capabilities 維持 `in_progress`、0 accepted、`release_eligible=false`。保留 Python bot，不合入 `main`、不部署。
