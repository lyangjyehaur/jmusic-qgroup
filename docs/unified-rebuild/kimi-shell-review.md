# Kimi 共用介面細節核對

日期：2026-11-26。變更範圍：`web`（`frontend`）；本機修改，未發布。

直接讀取並啟動 `/Users/danersaka/Projects/jmusic-design/kimi`，對照其 `Layout.tsx`、`UI.tsx`、`styles.css` 與實際畫面。新版使用 5086 的隔離正式資料副本；瀏覽器檢查不提交報名或成分，不操作使用者原有草稿頁。

本次核對範圍是全站共用 shell、導覽、頁籤、浮動操作、對話框，以及活動、音樂、同好、我的頁面中這些元件的實際使用。這不是所有業務頁面的逐像素驗收。

| 項目 | 發現 | 處理 |
| --- | --- | --- |
| Home indicator | HTML viewport 缺少 `viewport-fit=cover`，已有的安全區 CSS 無法在完整畫面中生效 | 啟用 viewport-fit，dock 高度、底部 padding、頁面留白共用安全區 token |
| dock 下拉位移 | adapter 把 visual viewport inset 作為 dock 的 bottom，彈性下拉和瀏覽器工具列變化都可能使它移動 | 固定 bottom 0；手機根捲動取消彈性回彈，保留正常捲動及對話框內捲動 |
| 鍵盤與保存欄 | 原先把導覽高度和鍵盤遮擋高度相加 | 只有輸入中且 viewport 縮小超過 150px 才避讓鍵盤；保存欄取導覽／鍵盤高度的較大值 |
| hover 下劃線 | retained 全站 `a:hover` 影響 dock、帳號入口和選單 | 移除全站 hover 下劃線，導覽／選單明確不加線；保留內容中明確設定的文字連結提示 |
| 頁籤選中下劃線 | Yahha ink Tabs 有下劃線，實際原型也保留了此標記 | 依使用者本次要求移除線，保留選中背景、文字顏色、ARIA 與鍵盤操作；重新平衡上下 padding |
| dock 外觀 | adapter 用不透明紙色覆蓋原型的 97% 紙面 | 恢復半透明紙面與 blur；沿用原型 dock 頂端的活動標記，非文字下劃線 |
| 手機頂欄 | adapter 的 64px token 覆蓋原型 56px；換成 Popover 後舊 selector 無法隱藏外觀文字 | 恢復 56px 加頂部安全區；外觀改為 40px 圖示入口，搜尋圖示恢復 19px |
| 側欄及快捷鍵 | 保留層與元件層的導覽過渡、kbd 排版不同 | 明確套用原型的背景／顏色過渡及快捷鍵內部排列 |
| 回頂按鈕 | Yahha Button 的 relative 覆蓋 retained 層的 fixed，按鈕實際隨文件移動 | 在共用 shell 層明確固定定位、尺寸和右側位置，按保存欄實際高度避讓 |
| 同好卡片 | 舊自繪展開箭頭與 Yahha Accordion 箭頭重複；長成分 ID 擠壓排名數字 | 只使用 Accordion 的箭頭；排名禁止縮小與換行 |
| 橫向安全區 | viewport-fit 啟用後，頁面與全螢幕對話框也可能靠近瀏海 | 頁面內容、對話框標題／正文／底部操作及關閉按鈕避讓左右安全區 |

既有已確認的功能整合繼續保留：手機頁名與主要操作同列、時間投票歸活動、音樂趨勢放音樂頁籤、音樂／活動共用概覽、真正 Yahha 控制項、固定保存提醒、完整名冊、網址與返回來源、前台主題色及明暗切換。這些與原型原始假資料或排版存在差別，依使用者已確認的行為執行。

實作集中在 `apps/web/src/kimi/shell.css`，避免共用固定元件再次被 retained 樣式層或元件庫預設定位覆蓋。沒有修改 API、schema、outbox、bot 入口或資料規則；正式 API／bot 不需因這次本機驗證重啟。

驗證：`npm run build:frontend` 通過；32 項不同的相關 E2E 在最終前端產物上通過（主批次 30 項，修正測試關閉按鈕名稱後重跑安全區 2 項）。範圍包含安全區、下拉／工具列變化、鍵盤、回頂、保存／恢復／衝突／丟失回應、選單、Yahha 控制項、頁籤返回、四種配色及明暗模式。另在瀏覽器實際查看手機四個主頁、桌面活動詳情及管理報名對話框，確認同好箭頭／排名與回頂按鈕位置。

限制：桌面 Chromium 不提供真實 iOS Home indicator 或 Safari 彈性捲動；測試使用 47px 頂部、34px 底部及橫向 44px 左右安全區 token，並模擬 visual viewport 變化。實機 Safari／PWA 的瀏覽器工具列及鍵盤動畫尚未驗證，不將模擬結果記為 iPhone 實測。
