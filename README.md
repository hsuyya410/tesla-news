# Tesla 新聞彙整（Model 3 / Model Y）

自動彙整近半年 Tesla Model 3、Model Y 與台灣市場相關的公開中文新聞，
以 GitHub Pages 發佈成一個可分享的網頁。

## 運作方式

```
GitHub Actions（每 2 小時 + 可手動觸發）
  └─ node scripts/fetch-news.mjs
       ├─ 4 主題 × 6 個月切片 = 24 組 Google News RSS 查詢
       ├─ 去重、篩掉不相關標題
       ├─ 分類：命中負面詞 → 其他
       │        命中優勢角度（成本/產品力/市場肯定/充電/安全）→ 購車優勢
       │        僅一般正面詞 → 其他亮點
       └─ 寫入 data/news.json（同源檔案，前端不需 CORS proxy）

index.html
  └─ 讀 data/news.json；期間、主題、優勢角度、關鍵字皆為前端即時篩選
     「更新最新新聞」按鈕重新載入最新一份
```

### 為什麼按月切片查詢

Google News RSS 單次查詢上限約 100 則。直接用 `when:180d` 只會拿到「最近 100 則」，
半年前的新聞會被截斷。改用 `after:/before:` 每 30 天一片、共 6 片，才能真正涵蓋半年，
前端也才有足夠資料支援「使用者自選期間」。

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
