# Tesla 新聞彙整（Model 3 / Model Y）

自動彙整近 30 天 Tesla Model 3、Model Y 與台灣市場相關的公開中文新聞，
以 GitHub Pages 發佈成一個可分享的網頁。

## 運作方式

```
GitHub Actions（每 2 小時 + 可手動觸發）
  └─ node scripts/fetch-news.mjs
       ├─ 抓 4 組 Google News RSS（Model 3 / Model Y / 台灣市場 / 品牌動態）
       ├─ 去重、篩掉不相關標題
       ├─ 關鍵字分類：命中負面詞 → 其他；只命中正面詞 → 亮點
       └─ 寫入 data/news.json（同源檔案，前端不需 CORS proxy）

index.html
  └─ 讀 data/news.json；「更新最新新聞」按鈕重新載入最新一份
```

之所以不在前端直接抓 RSS：Google News RSS 不回 CORS 標頭，
而免費 CORS proxy 在公司網路實測全部不通（522 / 403 / 500）。
改由 Actions 在雲端抓、產生同源 JSON，任何網路環境的訪客都能正常載入。

## 檔案

| 路徑 | 用途 |
|---|---|
| `index.html` | 前端頁面（單檔、無相依套件） |
| `scripts/fetch-news.mjs` | 抓取 + 分類腳本（Node 20+，無外部套件） |
| `data/news.json` | Actions 產生的資料，前端讀這支 |
| `.github/workflows/update-news.yml` | 定時更新排程 |

## 本機手動更新資料

```bash
node scripts/fetch-news.mjs   # 需要 Node 20+
```

## 調整分類關鍵字

編輯 `scripts/fetch-news.mjs` 最上方的 `POSITIVE` / `NEGATIVE` / `QUERIES` 陣列即可。
分類規則刻意保守：**只要標題命中任一負面詞，就不會被放進「亮點報導」**。

## 聲明

本頁為新聞聚合頁面，非 Tesla 官方網站，不代表 Tesla 之立場或聲明。
標題與連結均指向原媒體，著作權屬各原媒體所有。
