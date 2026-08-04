// 抓 Google News RSS，只保留「對 Tesla Model 3 / Model Y 銷售有利」的新聞
// 在 GitHub Actions 的 Node 20+ 執行（使用內建 fetch，無外部相依）
//
// 涵蓋近 180 天：Google News RSS 單次查詢上限約 100 則，直接用 when:180d 會被截斷成
// 「最近 100 則」，因此改用 after:/before: 按 30 天切片查詢，再合併去重。
//
// 篩選邏輯刻意嚴格 —— 寧可漏掉，也不要讓負面／競品／無關新聞混進來：
//   否決①  非 Model 3 / Model Y 主題（Model S/X 專屬、Cybercab、機器人、股票、政論…）
//   否決②  命中任一負面詞
//   否決③  出現競品品牌，且優勢語意指向競品
//   分類④  命中角度就標上角度；三道否決都過但沒對到角度 → 歸入「其他」（不丟棄，
//           這類文章仍可能推動觀望中的客戶下單）

import { writeFile, mkdir } from 'node:fs/promises';

const DAYS = 180;
const SLICE = 30;
const SLICES = Math.ceil(DAYS / SLICE);
const DELAY_MS = 1200;         // 拉長間隔，避免 Google News 回 503
const RETRIES = 3;
const MAX_ITEMS = 1600;

const TOPICS = [
  { key: 'model3', label: 'Model 3', q: '"Tesla Model 3"' },
  { key: 'modely', label: 'Model Y', q: '"Model Y" 特斯拉' },
  { key: 'taiwan', label: '台灣市場', q: '特斯拉 台灣' },
  { key: 'brand', label: '品牌動態', q: 'Tesla 電動車' },
];

// ── 購車優勢角度（白名單，必須命中至少一個）──────────────────────────
const ANGLES = [
  {
    key: 'cost', label: '用車成本',
    words: ['省錢', '更省', '省油', '狂省', '划算', '養車', '保養費', '維修成本', '持有成本',
            '電費', '油錢', '關稅', '補助', '補貼', '折抵', '換購', '優惠', '降價', '調降',
            '免費', '殘值', '保值', '入手價', '性價比', 'CP值', '零利率', '分期'],
  },
  {
    key: 'product', label: '產品力',
    words: ['續航', '里程', '馬力', '扭力', '零百', '性能', '動力', '升級', '改款', '小改款',
            'OTA', '軟體更新', '夏季更新', '新功能', '進化', '強化', '座艙', '配備', '空間',
            '長軸', '六人座', '熱泵', '前馬達', '電池容量', '充電速度', '新色'],
  },
  {
    key: 'market', label: '市場肯定',
    words: ['冠軍', '奪冠', '銷量第一', '狂賣', '熱銷', '熱賣', '暢銷', '創新高', '破紀錄',
            '銷量排行', '銷售排行', '掛牌數', '最暢銷', '市佔', '車主讚', '好評', '獲獎'],
  },
  {
    key: 'charging', label: '充電網路',
    words: ['超級充電', '超充', '充電站', '充電樁', '充電網路', 'V4', 'Supercharger',
            '充電據點', '開放充電'],
  },
  {
    key: 'safety', label: '安全表現',
    words: ['五星', 'TNCAP', 'NCAP', '安全評鑑', '碰撞測試', '主動安全', '最安全'],
  },
];

// 沒對到上述任何角度、但通過三道否決的文章歸在這一類
const OTHER_KEY = 'other';
const OTHER_LABEL = '其他';

// ── 否決①：非 M3/MY 主題 ──────────────────────────────────────────────
const OFFTOPIC = [
  // 股票 / 財經
  'TSLA', '股價', '股票', '財報', '市值', '分析師', '評等', '目標價', '法說', '營收',
  '獲利', '每股', '持股', '基金', 'ETF', '爆料同學會', '投資人', '空頭', '多頭',
  // 非 M3/MY 產品線
  'Cybercab', 'Cybertruck', 'Robotaxi', '無人計程車', 'Optimus', '人形', '機器人',
  'Powerwall', '儲能', '太陽能', 'Roadster', 'Semi', '電動卡車', '平衡車', '腳踏車',
  // 集團 / 政治 / 節目
  'SpaceX', '星鏈', 'Starlink', 'xAI', '推特', '關鍵時刻', '政經', '新聞面對面',
  // 傳聞中的低價車（會讓客人延後下單）
  '平價版', '便宜版', '廉價版', '平價',
  // 供應鏈 / 半導體 / 週邊，與賣車無關
  '台積電', '晶片', '三星', '英特爾', '開箱', '抽獎', '行動電源', '配件',
];

// ── 否決②：負面詞 ─────────────────────────────────────────────────────
const NEGATIVE = [
  // 品質 / 安全事件
  '召回', '調查', '故障', '瑕疵', '缺陷', '出包', '起火', '燃燒', '事故', '車禍',
  '撞', '失控', '受傷', '死亡', '異音', '漏水', '維修', '當機', '停擺', '危險', '警告',
  // 法律 / 爭議
  '求償', '訴訟', '起訴', '控告', '遭控', '涉嫌', '違規', '開罰', '罰款', '爭議',
  '質疑', '抗議', '抵制', '醜聞', '隱瞞', '造假', '誤導', '踢爆', '黑幕', '誇大',
  // 市場 / 營運壞消息
  '暴跌', '大跌', '下滑', '腰斬', '衰退', '熄火', '虧損', '減產', '停產', '裁員',
  '流失', '退訂', '停售', '危機', '風波', '衝擊', '疲軟', '慘', '寒冬', '崩',
  // 負向語氣
  '輸了', '輸給', '不敵', '敗給', '仍輸', '落後', '不如', '縮水', '降規', '絕響',
  '延遲', '延後', '延宕', '卡關', '受阻', '阻礙', '無法', '不能', '禁', '取消',
  '怨', '抱怨', '不滿', '喊冤', '唱衰', '批', '轟', '憂', '恐', '掉',
  // 車主情緒 / 品質抱怨（實測漏網補充）
  '瘟疫', '氣炸', '抓狂', '傻眼', '崩潰', '苦主', '慘況', '致歉', '道歉',
  '疑慮', '隱憂', '詬病', '缺點', '不推', '別買', '慎入', '翻車', '打臉',
  // 規格倒退
  '降至', '衰減', '減配', '砍配備',
  // 市場逆風（「其他」分類實測漏網補充）
  '逆風', '倒退', '讓位', '關鍵轉折', '失守', '節節',
];

// ── 否決③：競品品牌 + 優勢指向競品 ────────────────────────────────────
const RIVALS = [
  'BYD', '比亞迪', 'Toyota', '豐田', 'BMW', '賓士', 'Mercedes', 'Benz', 'Audi', '奧迪',
  '福斯', 'Volkswagen', 'Hyundai', '現代', 'Kia', '起亞', 'Nissan', '日產', 'Honda',
  '本田', 'Lexus', 'Porsche', '保時捷', 'Volvo', 'Ford', '福特', '小米', 'Xiaomi',
  '蔚來', '理想', '小鵬', '鴻海', 'Foxtron', 'Bria', '納智捷', 'Luxgen', 'MG',
  'Polestar', '極星', 'Zeekr', '極氪', 'bZ4X', 'bZ7', 'iX1', 'Ioniq', '追覓',
];

// 這些字若與競品同時出現，代表優勢在競品那邊、或是勝負未定的比較文 → 一律不收
const RIVAL_EDGE = [
  // 競品占上風
  '超車', '超越', '擊敗', '打敗', '贏過', '力壓', '完勝', '狂勝', '反超', '搶下',
  '奪走', '取代', '稱冠', '更便宜', '更划算', '更省', '更快', '更強', '更大',
  '更豪華', '更優', '鎖定', '挑戰', '威脅', '壓境', '搶市', '勁敵', '大軍',
  '封王', '破頂', '登頂', '摘冠',
  // 勝負未定的對比文（放這裡而非全域負面詞，避免誤殺純 Tesla 的文章）
  '誰是贏家', '誰勝出', '誰才是', '誰更', '對決', '大對決', 'PK', '比一比',
  '哪個好', '怎麼選', '該選', '大車拼', '正面交鋒', '捉對',
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

const has = (t, w) => t.toLowerCase().includes(w.toLowerCase());

/** 回傳優勢角度陣列；不合格回傳 null（附帶被否決的原因供統計） */
function evaluate(title) {
  // 否決①：非 M3/MY 主題
  const off = OFFTOPIC.find((w) => has(title, w));
  if (off) return { reject: 'offtopic', by: off };

  // Model S / X 專屬新聞（標題沒同時提到 3 或 Y）
  const hasSX = /model\s?[sx]\b/i.test(title);
  const hasCore = /model\s?[3y]\b/i.test(title);
  if (hasSX && !hasCore) return { reject: 'offtopic', by: 'Model S/X' };

  // 否決②：負面詞
  const neg = NEGATIVE.find((w) => title.includes(w));
  if (neg) return { reject: 'negative', by: neg };

  // 否決③：競品 + 優勢指向競品
  const rival = RIVALS.find((r) => has(title, r));
  if (rival) {
    const edge = RIVAL_EDGE.find((w) => title.includes(w));
    if (edge) return { reject: 'rival', by: `${rival}/${edge}` };
  }

  // 分類④：對到角度就標角度；沒對到但三道否決都過 → 歸「其他」，保留不丟
  const angles = ANGLES
    .filter((a) => a.words.some((w) => has(title, w)))
    .map((a) => a.key);

  return { angles: angles.length ? angles : [OTHER_KEY] };
}

function isRelevant(title) {
  return RELEVANT.some((k) => has(title, k));
}

function normalize(title) {
  return title.replace(/[\s「」【】（）()！？，、。：；·|/\\+\-—–_"'’“”]/g, '').toLowerCase();
}

async function fetchSlice(topic, after, before) {
  const q = `${topic.q} after:${after} before:${before}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-aggregator/1.0)' },
      });
      if (res.status === 503 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      return parseRss(xml).map((it) => ({ ...it, topic: topic.label }));
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) {
        const backoff = attempt * 4000;   // 4s, 8s
        console.log(`    retry ${attempt}/${RETRIES - 1} after ${backoff}ms (${err.message})`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const now = new Date();
  const collected = [];
  const failed = [];
  let okSlices = 0;

  for (const topic of TOPICS) {
    let total = 0;
    for (let i = 0; i < SLICES; i++) {
      const before = new Date(now.getTime() - i * SLICE * 86400000);
      const after = new Date(now.getTime() - (i + 1) * SLICE * 86400000);
      try {
        const items = await fetchSlice(topic, ymd(after), ymd(before));
        collected.push(...items);
        total += items.length;
        okSlices++;
      } catch (err) {
        failed.push(`${topic.key}#${i}`);
        console.error(`[fail] ${topic.key}#${i}: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }
    console.log(`[ok] ${topic.key}: ${total} 則`);
  }

  if (okSlices === 0) {
    console.error('所有查詢皆失敗，中止並保留既有 news.json');
    process.exit(1);
  }

  const seen = new Set();
  const rejects = { offtopic: 0, negative: 0, rival: 0, irrelevant: 0 };
  let items = [];

  for (const it of collected) {
    if (!isRelevant(it.title)) { rejects.irrelevant++; continue; }
    const fp = normalize(it.title);
    if (seen.has(fp)) continue;
    seen.add(fp);

    const verdict = evaluate(it.title);
    if (verdict.reject) { rejects[verdict.reject]++; continue; }

    const ts = Date.parse(it.pubDate);
    items.push({
      title: it.title,
      link: it.link,
      source: it.source,
      topic: it.topic,
      date: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      angles: verdict.angles,
    });
  }

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);

  const angleCounts = {};
  for (const a of ANGLES) angleCounts[a.key] = items.filter((i) => i.angles.includes(a.key)).length;
  angleCounts[OTHER_KEY] = items.filter((i) => i.angles.includes(OTHER_KEY)).length;

  const payload = {
    updatedAt: new Date().toISOString(),
    coverageDays: DAYS,
    total: items.length,
    angleLabels: {
      ...Object.fromEntries(ANGLES.map((a) => [a.key, a.label])),
      [OTHER_KEY]: OTHER_LABEL,   // 「其他」固定排最後
    },
    angleCounts,
    failedSlices: failed,
    items,
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/news.json', JSON.stringify(payload), 'utf8');

  const oldest = items.length ? (items[items.length - 1].date || '').slice(0, 10) : '-';
  console.log(`\n保留 ${items.length} 則（最舊 ${oldest}）｜失敗切片 ${failed.length}/${TOPICS.length * SLICES}`);
  console.log(`剔除：無關 ${rejects.irrelevant}｜非M3MY主題 ${rejects.offtopic}｜負面 ${rejects.negative}｜競品占優 ${rejects.rival}`);
  for (const a of ANGLES) console.log(`  - ${a.label}: ${angleCounts[a.key]} 則`);
  console.log(`  - ${OTHER_LABEL}: ${angleCounts[OTHER_KEY]} 則`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
