# 重設會員範圍與缺失資料門檻

日期：2026-11-20。發布範圍：`none`；隔離遷移工具與測試，不發布服務。

## 已實作

身份會員恢復現在從完整、已核對的原 reset vault，逐次比較 persisted 與 loaded 會員鍵。persisted-only 會員必須仍在最新資料、能由原 Store 的 native payload 恢復，或已有原刪除 authority 紀錄；否則在 startup projection 與整組恢復候選入口明確拒絕，保留所有來源供會員對帳。不能僅由 prelink、聯絡 QQ、session 或 entry intent 推測並重建會員，也不能把 persisted scope 擴大當成 loaded 刪除 authority。

成功回執包含 `unloadedResetKeys` 與 `unloadedResetMembersCovered`，獨立驗證重新從 pinned vault 和唯讀身份 SQL 推導範圍及結果。省略範圍、重釘輸出或篡改回執不能跳過對帳。這些欄位只證明此步覆蓋已知會員鍵，不證明來源 ancestry、歷史保全或切換可行。

## 原站行為與驗證

真 Python 演練將既有數字會員 `10001` 只從 loaded members 移除，保留原 persisted JSON、prelink，並以原 Store 建立 session 與 entry intent，再執行兩次原 reset。結果為 JSON 會員消失、身份 rows 仍存在、會員不在刪除 ledger；在身份副本執行真正原 `Store.recover_profiles`，仍不能恢復該數字會員。新版現在明確阻擋這個範圍，沒有輸出可用候選或改寫原資料。

另驗证 loaded-only 數字會員及 persisted-only 後續真正刪除：只依實際 authority 清理，完整 business／proof／rebase 候選可驗證，bot outbox、設定及 runtime rows 保持原值，候選仍拒絕啟動。第 146 號可恢復的 native persisted-only 會員保持原恢復行為及 reset 後空選擇。

新增 **6／6** 案例通過；原會員／recovery／proof 三檔 **66／66** 通過。兩份原報告逐名核對上一版固定 inventory 與新檔，共 **4 檔／72 個不同案例通過**，零 failed／pending／遺漏；strict、台帳、diff 檢查通過。完整來源預期 **160 檔／2,587 unit**、**78 檔／833 browser**。

[第 146 號 Linux run](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44713734933) 固定 `8e181256f76e0b5cc9588d294aee91068fe323f3`，乾淨 archive、55 個原 Python blobs、bot harness 及 175 個 development runtime inputs 已準備／逐 blob 核對；全量 unit／browser 尚在執行。不能將先前 image job 成功或本機相關測試記成整組全量驗收。

## 尚未完成

沒有可恢復 payload 的 persisted-only 會員仍須完成實際資料處置、歷史保全與來源鏈對帳；本次只補齊明確辨識及阻擋，沒有宣告其恢復完成。其他未完成項目仍包括 native reset 後續世代／重複 epoch／exact key reuse、latest-erasure 私人歷史、外部 ancestry／custody／high-water、media／browser pending、真正停止來源 capture、完整 bot／實際候選版本組合／B01–B15／QQ／正式規模及 audited activation。

166 capabilities 維持 `in_progress`、0 accepted、`release_eligible=false`；保留 Python bot，不合入 `main`、不部署。
