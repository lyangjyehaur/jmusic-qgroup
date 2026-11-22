# 本機測試指南

本指南使用隔離資料及合成 QQ 登入。執行測試不會部署；目前線上網站與 bot 繼續使用原版本。

## 啟動可操作預覽

需要 Node 22.22.3 以上、npm 10.9.8 以上及 Python 3。於專案目錄執行：

```sh
npm ci --no-audit --no-fund
npm run build:rebuild
REBUILD_TEST_MUSIC_TREND=1 REBUILD_TEST_MUSIC_ROOMS=1 REBUILD_TEST_POLLS=1 REBUILD_TEST_FILE_STORAGE=1 node_modules/.bin/tsx apps/api/testsupport/preview.ts
```

開啟 <http://127.0.0.1:5082>。這組合提供合成會員、詞條、成分／趨勢、活動名冊及時間投票，並啟用暫存檔案庫以測試圖片上傳；預覽資料在停止程序後清除。不要將此程序連到正式資料庫。不要任意組合其他 `REBUILD_TEST_*` 參數：部分 fixture 使用相同會員、名冊或歷史版號。

一般登入直接按網站的 QQ 登入，會經本機模擬授權建立測試帳號，不需要真實 QQ。登入後可建立自己的成分、活動和投票。原成分找回可測合成編號 `10001`／PIN `123456`；這是測試資料。

若要操作樣本活動的發起者，於這個預覽頁的瀏覽器開發者工具 Console 執行以下測試 cookie，再重新整理：

```js
document.cookie = 'kanban_session=fixture-alice; Path=/; SameSite=Lax';
location.reload();
```

`fixture-bob` 是第二個合成帳號，可測不同帳號的參加、認領、權限拒絕與草稿隔離。`fixture-registration-admin` 可測帳號管理權限。此方式只適用上述本機測試 adapter，不用於正式登入。可用不同瀏覽器設定檔或無痕視窗分開兩個帳號。

## 建議操作順序

1. 匿名瀏覽活動；登入後開啟「我的成分」，搜尋及保存領域／細分選擇，確認未保存離頁和重新整理恢復。再從同好、詞條、圈子及全站搜尋往返，確認使用同一份選擇和帳號。
2. 建立活動並發布；第二個帳號報名，發起者代報沒有成分的同行。核對名冊、認領、候補、出席及安排更新；另測時間投票與定案活動。
3. 從活動進入成分分房工具，計算有成分者並人工安排其他同行；確認後採用正式房間。第二個帳號應無法代發起者採用。
4. 活動開始／結束後依實際名冊結算，核對逐人／付款人金額、圖片及歷史版次；再測帳本申報、確認、退款、收件匣及待辦。
5. 在「本機紀錄」檢查草稿／待確認操作；測離線、刷新、丟失回應、切帳號及精確重試，確認原稿可保全且已提交操作不重送。管理入口另外測詞庫、身份限制及 bot 設定；本機預覽沒有投遞程序。

`/tools/room-lab` 的活動分房建議與正式分房是兩個確認步驟；沒有成分者保留在完整名冊，可人工安排，不參加自動音樂計算。收款碼／帳務只用合成圖片和金額。

## 開發與自動驗證

要修改程式可執行 `npm run dev:rebuild`；前端 <http://127.0.0.1:5080>、API <http://127.0.0.1:5081>，使用獨立 `.rebuild-data` 開發庫，不載入上述預覽 fixture 或合成 QQ adapter。

```sh
npm run check:capabilities
npm run build:rebuild
npm run test:build:rebuild
npm run test:rebuild -- --maxWorkers=1 --testTimeout=30000
npm run test:e2e:rebuild -- --forbid-only
REBUILD_RETAINED_PYTHON_COMMIT=07defc429d619a7558ab7218372886f531813ae3 npm run test:retained-python:rebuild
```

單元完整回歸會啟動 Python 原行為讀取器；建議單一 worker。瀏覽器回歸自行管理 5082 端口，執行前先停止手動預覽，且先建置。macOS 有 Chrome 時預設使用 Chrome；其他環境先執行 `npx playwright install chromium`。bot 測試使用固定線上來源和受控投遞，不需要正式憑證。

最新固定候選 `4fb6bbb86f12e1ef3e3569f1b31ed91573f1eaa1` 的 Linux unit 4,063 項、browser 1,043 項與映像驗證均通過，沒有略過或重試；另與實際匯出的線上 Python bot 映像完成隔離組合。最新授權副本的重複匯入、新寫入回退／forward、成分與看板歷史、原 bot 外部 bytes／mtime 恢復及離線封存見[第 219 批](219-current-copy-and-acceptance-checkpoint.md)。使用說明兩句後續修正另做相關建置／瀏覽器驗證；原完整 CI 不冒稱包含該修改。P6 尚須完成父項台帳審核及原 web／music／bot 的回退後成套操作與錯誤恢復，不由本機合成預覽代替。真實 QQ／WebView 的平台驗收另行記錄；P7 正式切換不在本輪範圍。

第 220 批已補固定舊版 HTTP 操作及新寫入 forward、30 份封存歷史的最新刪除／恢復／新程序重啟驗證；C04 的深淺主題與未保存跨領域草稿保全完成本機父項審核。其餘完整台帳仍未通過，詳見[驗收記錄](220-legacy-http-and-parent-acceptance.md)。
