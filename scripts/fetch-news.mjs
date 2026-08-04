// 從 Google News RSS 抓取 Tesla 相關新聞，做關鍵字分類後輸出 data/news.json
// 在 GitHub Actions 的 Node 20+ 執行（使用內建 fetch，無外部相依）

import { writeFile, mkdir } from 'node:fs/promises';

const WINDOW = 'when:30d';

const QUERIES = [
  { key: 'model3', label: 'Model 3', q: `"Tesla Model 3" ${WINDOW}` },
  { key: 'modely', label: 'Model Y', q: `"Model Y" 特斯拉 ${WINDOW}` },
  { key: 'taiwan', label: '台灣市場', q: `特斯拉 台灣 ${WINDOW}` },
  { key: 'brand', label: '品牌動態', q: `Tesla 電動車 ${WINDOW}` },
];

// 正面詞：產品力、市場表現、成本優勢
const POSITIVE = [
  '冠軍', '奪冠', '第一', '銷量', '熱銷', '熱賣', '暢銷', '突破', '創新高', '破紀錄',
  '成長', '回升', '領先', '升級', '進化', '改款', '新增', '強化', '上市', '推出',
  '續航', '更省', '省錢', '省油', '便宜', '降價', '優惠', '補助', '免費', '保固',
  '推薦', '好開', '實用', '耐用', '安全', '五星', '獲獎', '好評', '馬力', '加速',
];

// 負面詞：只要命中就不列入亮點（客戶可見，寧可保守）
const NEGATIVE = [
  '召回', '調查', '故障', '瑕疵', '缺陷', '出包', '起火', '燃燒', '事故', '車禍',
  '撞', '失控', '受傷', '死亡', '求償', '訴訟', '起訴', '控告', '違規', '開罰',
  '罰款', '爭議', '質疑', '抗議', '抵制', '危險', '警告', '暴跌', '大跌', '下滑',
  '腰斬', '衰退', '熄火', '虧損', '減產', '停產', '裁員', '延遲', '跳票', '輸了',
  '不如', '落後', '流失', '退訂', '停售', '當機', '維修', '異音', '漏',
];

// 標題必須提到這些才算相關
const RELEVANT = ['tesla', '特斯拉', 'model 3', 'model3', 'model y', 'modely'];

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
};

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
    // Google News 標題格式為「標題 - 媒體」，把尾巴的媒體名去掉
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

function countHits(text, words) {
  return words.filter((w) => text.includes(w)).length;
}

function classify(title) {
  const neg = countHits(title, NEGATIVE);
  const pos = countHits(title, POSITIVE);
  // 保守規則：命中任一負面詞就不進亮點區
  if (neg > 0) return { group: 'other', pos, neg };
  if (pos > 0) return { group: 'highlight', pos, neg };
  return { group: 'other', pos, neg };
}

function isRelevant(title) {
  const t = title.toLowerCase();
  return RELEVANT.some((k) => t.includes(k));
}

function normalize(title) {
  return title.replace(/[\s「」【】！？，、。：·|/\\-]/g, '').toLowerCase();
}

async function fetchQuery({ key, label, q }) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-aggregator/1.0)' },
  });
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml).map((it) => ({ ...it, topic: label, topicKey: key }));
}

async function main() {
  const collected = [];
  const failed = [];

  for (const query of QUERIES) {
    try {
      const items = await fetchQuery(query);
      collected.push(...items);
      console.log(`[ok] ${query.key}: ${items.length} 則`);
    } catch (err) {
      failed.push(query.key);
      console.error(`[fail] ${query.key}: ${err.message}`);
    }
  }

  if (collected.length === 0) {
    // 全部失敗就不要覆寫掉舊資料
    console.error('所有查詢皆失敗，中止並保留既有 news.json');
    process.exit(1);
  }

  const seen = new Set();
  const items = [];

  for (const it of collected) {
    if (!isRelevant(it.title)) continue;
    const fingerprint = normalize(it.title);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const { group, pos, neg } = classify(it.title);
    const ts = Date.parse(it.pubDate);
    items.push({
      title: it.title,
      link: it.link,
      source: it.source,
      topic: it.topic,
      date: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      group,
      score: pos - neg,
    });
  }

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const payload = {
    updatedAt: new Date().toISOString(),
    window: '近 30 天',
    total: items.length,
    highlights: items.filter((i) => i.group === 'highlight').length,
    failedQueries: failed,
    items,
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/news.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log(`寫入 data/news.json：共 ${items.length} 則，亮點 ${payload.highlights} 則`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
