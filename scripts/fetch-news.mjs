// 從 Google News RSS 抓取 Tesla 相關新聞，做關鍵字分類後輸出 data/news.json
// 在 GitHub Actions 的 Node 20+ 執行（使用內建 fetch，無外部相依）
//
// 涵蓋近 180 天：Google News RSS 單次查詢上限約 100 則，直接用 when:180d 會被截斷成
// 「最近 100 則」，因此改用 after:/before: 按 30 天切片查詢，再合併去重。

import { writeFile, mkdir } from 'node:fs/promises';

const DAYS = 180;              // 資料涵蓋天數（前端可在此範圍內自由選期間）
const SLICE = 30;              // 每片天數
const SLICES = Math.ceil(DAYS / SLICE);
const DELAY_MS = 250;          // 每次請求間隔，避免觸發速率限制
// 輸出上限。注意：截斷是砍最舊的，設太低會讓「近半年」實際只涵蓋到一部分。
// 900 實測只涵蓋到 148 天，故提高到 1600 以確保 180 天完整。
// GitHub Pages 會 gzip，中文 JSON 壓縮率高，實際傳輸量遠小於原始大小。
const MAX_ITEMS = 1600;

const TOPICS = [
  { key: 'model3', label: 'Model 3', q: '"Tesla Model 3"' },
  { key: 'modely', label: 'Model Y', q: '"Model Y" 特斯拉' },
  { key: 'taiwan', label: '台灣市場', q: '特斯拉 台灣' },
  { key: 'brand', label: '品牌動態', q: 'Tesla 電動車' },
];

// ── 銷售優勢角度：命中即歸入「購車優勢」並標上角度標籤 ──────────────────
const ANGLES = [
  {
    key: 'cost', label: '用車成本',
    words: ['省錢', '更省', '省油', '划算', '養車', '保養費', '維修成本', '持有成本', '總成本',
            '電費', '油錢', '稅', '補助', '折抵', '優惠', '降價', '調降', '免費', '便宜',
            '殘值', '保值', '低價', '入手價', '性價比', 'CP值'],
  },
  {
    key: 'product', label: '產品力',
    words: ['續航', '里程', '馬力', '加速', '性能', '動力', '升級', '更新', '新功能', '軟體更新',
            'OTA', '進化', '改款', '新增', '強化', '空間', '座艙', '配備', '智慧', '輔助駕駛',
            'FSD', 'Autopilot', '自動輔助', '長軸', '六人座', '熱泵', '快充'],
  },
  {
    key: 'market', label: '市場肯定',
    words: ['冠軍', '奪冠', '第一', '銷量', '熱銷', '熱賣', '暢銷', '突破', '創新高', '破紀錄',
            '領先', '成長', '回升', '獲獎', '好評', '推薦', '車主讚', '最暢銷', '市佔', '奪下'],
  },
  {
    key: 'charging', label: '充電網路',
    words: ['超級充電', '超充', '充電站', '充電樁', '充電網路', 'V4', 'Supercharger', '開放充電',
            '充電據點', '充電速度'],
  },
  {
    key: 'safety', label: '安全表現',
    words: ['五星', '安全評鑑', 'NCAP', '碰撞測試', '主動安全', '安全性', '最安全', '安全配備'],
  },
];

// 一般正面詞（沒對到具體優勢角度，但語氣正面）
const POSITIVE = [
  '上市', '推出', '登場', '開賣', '交車', '導入', '擴大', '啟用', '亮相', '好開',
  '實用', '耐用', '滿意', '受歡迎', '話題', '期待',
];

// 負面詞：只要命中就不進「購車優勢」或「其他亮點」（客戶可見，寧可保守）
const NEGATIVE = [
  '召回', '調查', '故障', '瑕疵', '缺陷', '出包', '起火', '燃燒', '事故', '車禍',
  '撞', '失控', '受傷', '死亡', '求償', '訴訟', '起訴', '控告', '違規', '開罰',
  '罰款', '爭議', '質疑', '抗議', '抵制', '危險', '警告', '暴跌', '大跌', '下滑',
  '腰斬', '衰退', '熄火', '虧損', '減產', '停產', '裁員', '延遲', '跳票', '輸了',
  '不如', '落後', '流失', '退訂', '停售', '當機', '異音', '漏水', '維修', '停擺',
  '延後', '取消', '難產', '危機', '風波', '重摔', '慘', '衝擊', '停止', '拒絕',
];

const RELEVANT = ['tesla', '特斯拉', 'model 3', 'model3', 'model y', 'modely'];

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = pick(block, 'title');
    const source = pick(block, 'source');
    const title = source && rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3)).trim()
      : rawTitle;
    const link = pick(block, 'link');
    const pubDate = pick(block, 'pubDate');
    if (!title || !link) continue;
    items.push({ title, link, source: source || '未署名', pubDate });
  }
  return items;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function classify(title) {
  const neg = NEGATIVE.filter((w) => title.includes(w)).length;
  const angles = ANGLES
    .filter((a) => a.words.some((w) => title.toLowerCase().includes(w.toLowerCase())))
    .map((a) => a.key);
  const pos = POSITIVE.filter((w) => title.includes(w)).length;

  // 保守規則：命中任一負面詞 → 一律歸「其他」
  if (neg > 0) return { group: 'other', angles: [] };
  if (angles.length > 0) return { group: 'advantage', angles };
  if (pos > 0) return { group: 'highlight', angles: [] };
  return { group: 'other', angles: [] };
}

function isRelevant(title) {
  const t = title.toLowerCase();
  return RELEVANT.some((k) => t.includes(k));
}

function normalize(title) {
  return title.replace(/[\s「」【】（）()！？，、。：；·|/\\+\-—–_"'’“”]/g, '').toLowerCase();
}

async function fetchSlice(topic, after, before) {
  const q = `${topic.q} after:${after} before:${before}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-aggregator/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml).map((it) => ({ ...it, topic: topic.label, topicKey: topic.key }));
}

async function main() {
  const now = new Date();
  const collected = [];
  const failed = [];
  let okCount = 0;

  for (const topic of TOPICS) {
    let topicTotal = 0;
    for (let i = 0; i < SLICES; i++) {
      const before = new Date(now.getTime() - i * SLICE * 86400000);
      const after = new Date(now.getTime() - (i + 1) * SLICE * 86400000);
      const tag = `${topic.key}#${i}`;
      try {
        const items = await fetchSlice(topic, ymd(after), ymd(before));
        collected.push(...items);
        topicTotal += items.length;
        okCount++;
      } catch (err) {
        failed.push(tag);
        console.error(`[fail] ${tag}: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }
    console.log(`[ok] ${topic.key}: ${topicTotal} 則（${SLICES} 個時間切片）`);
  }

  if (okCount === 0) {
    console.error('所有查詢皆失敗，中止並保留既有 news.json');
    process.exit(1);
  }

  const seen = new Set();
  let items = [];

  for (const it of collected) {
    if (!isRelevant(it.title)) continue;
    const fingerprint = normalize(it.title);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const { group, angles } = classify(it.title);
    const ts = Date.parse(it.pubDate);
    items.push({
      title: it.title,
      link: it.link,
      source: it.source,
      topic: it.topic,
      date: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      group,
      angles,
    });
  }

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);

  const byAngle = {};
  for (const a of ANGLES) {
    byAngle[a.key] = items.filter((i) => i.angles.includes(a.key)).length;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    coverageDays: DAYS,
    total: items.length,
    advantage: items.filter((i) => i.group === 'advantage').length,
    highlight: items.filter((i) => i.group === 'highlight').length,
    angleLabels: Object.fromEntries(ANGLES.map((a) => [a.key, a.label])),
    angleCounts: byAngle,
    failedSlices: failed,
    items,
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/news.json', JSON.stringify(payload), 'utf8');
  console.log(
    `寫入 data/news.json：共 ${items.length} 則｜購車優勢 ${payload.advantage}｜` +
    `其他亮點 ${payload.highlight}｜失敗切片 ${failed.length}/${TOPICS.length * SLICES}`
  );
  for (const a of ANGLES) console.log(`  - ${a.label}: ${byAngle[a.key]} 則`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
