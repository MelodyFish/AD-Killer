const whitelist = new Set(
  (window.PUMP_WHITELIST || []).map(x => String(x).toLowerCase())
);

const blacklist = new Set(
  (window.PUMP_BLACKLIST || []).map(x => String(x).toLowerCase())
);
console.log("blacklist", blacklist)

console.log("🔥 广告杀手 V1 已启动");

/************************
 * Guard: only run on /search?q=
 ************************/
function isSearchPage() {
  try {
    return location.pathname === "/search" && new URLSearchParams(location.search).has("q");
  } catch {
    return false;
  }
}

/************************
 * Thresholds
 ************************/
const THRESH_HIDE = 7;       // >=7 hide
const THRESH_COLLAPSE = 4;   // 4-6 collapse


let filteredCount = 0;
let scheduled = false;

/************************
 * CA detection
 ************************/
function containsCA(text) {
  const sol = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
  const eth = /\b0x[a-fA-F0-9]{40}\b/;
  return sol.test(text) || eth.test(text);
}

function stripCA(text) {
  return (text || "")
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, " ")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, " ")
    .replace(/(^|\s)ca\s*[:：]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/************************
 * Text extraction (A-mode: tweetText only, but robust)
 ************************/
function getTweetTextOnly(article) {
  const n = article.querySelector('[data-testid="tweetText"]');
  const t1 = n ? (n.innerText || "").trim() : "";
  if (t1) return t1;

  const spans = article.querySelectorAll('[data-testid="tweetText"] span');
  const t2 = Array.from(spans).map(s => (s.innerText || "").trim()).filter(Boolean).join(" ").trim();
  return t2;
}

function getAuthorHandle(article) {
  // Prefer profile link "/username"
  const links = article.querySelectorAll('a[href^="/"]');
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (href.includes("/status/")) continue;
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (m) return ("@" + m[1]).toLowerCase();
  }
  // Fallback from User-Name block text
  const header = article.querySelector('[data-testid="User-Name"]');
  const ht = header ? (header.innerText || "") : "";
  const m2 = ht.match(/@\w{1,20}/);
  return m2 ? m2[0].toLowerCase() : null;
}

/************************
 * Media detection (robust)
 ************************/
function countMedia(article) {
  const videoTags = article.querySelectorAll("video").length;
  const videoPlayers =
    article.querySelectorAll('[data-testid="videoPlayer"]').length +
    article.querySelectorAll('[data-testid="videoComponent"]').length +
    article.querySelectorAll('[data-testid="videoPreview"]').length;
  const playButtons = article.querySelectorAll('[data-testid="playButton"]').length;

  const videos = Math.min(videoTags + videoPlayers + playButtons, 3);

  let images = article.querySelectorAll('[data-testid="tweetPhoto"] img').length;
  if (images === 0) images = article.querySelectorAll('a[href*="/photo/"] img').length;

  if (images === 0) {
    const header = article.querySelector('[data-testid="User-Name"]');
    const all = Array.from(article.querySelectorAll('img[src*="media"]'));
    images = all.filter(img => !(header && header.contains(img))).length;
  }

  images = Math.min(images, 6);

  return { videos, images, total: videos + images };
}

/************************
 * Emoji detection (text + img alt inside tweetText)
 ************************/
function extractEmojiFromString(s) {
  if (!s) return [];
  try { return s.match(/\p{Extended_Pictographic}/gu) || []; }
  catch { return s.match(/[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/gu) || []; }
}

function analyzeEmojis(text, article) {
  const fromText = extractEmojiFromString(text);
  const fromAlt = [];
  const imgs = article.querySelectorAll('[data-testid="tweetText"] img[alt]');
  imgs.forEach(img => fromAlt.push(...extractEmojiFromString(img.getAttribute("alt") || "")));

  const all = [...fromText, ...fromAlt];
  const freq = new Map();
  for (const e of all) freq.set(e, (freq.get(e) || 0) + 1);

  let maxRepeat = 0;
  for (const n of freq.values()) maxRepeat = Math.max(maxRepeat, n);

  return { distinct: freq.size, maxRepeat };
}

/************************
 * Feature detectors
 ************************/
const RX = {
  vip: /\bvip\b/i,
  funnel: /(telegram|t\.me\/|tg\b|link in bio|ref=|join\b|dm me|follow( me)?\b|私群|加入|机器人)/i,
  profit: /(\b2x\b|\bx2\b|\b10x\b|\b100x\b|mc\s*[:：]?\s*\d|\$\s*\d+.*(→|->|to|\+|%))|(profit|收益|盈利|翻倍|倍数|暴涨|完美捕获|ath)/i,
  system: /(signal|momentum|premium|high-accuracy|detected|scanner|call\b|top call|命中|动量|高精度|信号|系统|算法|模型|ai\b|tracker)/i,
  cta: /(don'?t miss|next (banger|100x)|buy now|ape in|send it|lfg|马上|冲|开冲)/i,
  broadcast: /(^|\s)(ca|time|detected|signal)\s*[:：]/i,
  safety: /(scam|risk|audit|careful|rug|dump\?|looks (shady|sus)|是不是骗局|风险|审计|小心|出货|割)/i,
  externalLink: /(https?:\/\/|www\.)/i
};

/************************
 * Scoring
 ************************/
function scoreTweet(text, article) {
  let score = 0;
  const hits = [];

  const nonCA = stripCA(text);
  const media = countMedia(article);

  // Rule: only CA => +10
  if (text && nonCA.length === 0) {
    score += 10; hits.push("仅CA(+10)");
  }

  // Rule: media total == 3 => +10
  if (media.total === 3) {
    score += 10; hits.push("媒体=3(+10)");
  }

  // Rule: only video => +4 (has video and no images), regardless of text
  if (media.videos > 0 && media.images === 0) {
    score += 4; hits.push("仅视频(+4)");
  }

  // Rule: VIP => +4
  if (RX.vip.test(text)) { score += 4; hits.push("VIP(+4)"); }

  // Rule: any external link => +4
  if (RX.externalLink.test(text)) { score += 4; hits.push("外链(+4)"); }

  // Other promo rules
  if (RX.funnel.test(text)) { score += 4; hits.push("导流(+4)"); }
  if (RX.profit.test(text)) { score += 3; hits.push("收益(+3)"); }
  if (RX.system.test(text)) { score += 3; hits.push("系统/信号(+3)"); }
  if (RX.cta.test(text))    { score += 2; hits.push("CTA(+2)"); }
  if (RX.broadcast.test(text)) { score += 2; hits.push("广播(+2)"); }

  // Emoji rule
  const emo = analyzeEmojis(text, article);
  if (emo.distinct > 2) { score += 4; hits.push("多表情(+4)"); }
  else if (emo.maxRepeat > 3) { score += 4; hits.push("重复表情(+4)"); }

  // Safety reductions
  if (RX.safety.test(text)) { score -= 3; hits.push("风险(-3)"); }
  if (text.length >= 180 && !RX.funnel.test(text) && !RX.profit.test(text)) {
    score -= 2; hits.push("长文本(-2)");
  }

  return { score, hits, media };
}

/************************
 * UI
 ************************/
function ensureCounter() {
  let el = document.getElementById("pump-cleaner-counter");
  if (!el) {
    el = document.createElement("div");
    el.id = "pump-cleaner-counter";
    el.style.cssText = `
      position: fixed; bottom: 16px; right: 16px;
      background: #000; color: #fff;
      padding: 16px; font-size: 14px; border-radius: 12px; font-weight: bold;
      z-index: 99999; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      border: 1px solid #000; backdrop-filter: blur(6px);
      max-width: 260px;
    `;
    document.body.appendChild(el);
  }
  el.textContent = `已为您过滤: ${filteredCount}条垃圾推文`;
}

function makeCollapsedCard(meta) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
    margin: 10px 0; padding: 10px 12px; border-radius: 12px;
    border: 1px dashed rgba(255,255,255,0.25);
    background: rgba(17,17,17,0.92); color: rgba(255,255,255,0.82);
    font-size: 13px; line-height: 1.35;
  `;

  const reasons = meta.hits.length ? meta.hits.join("，") : "无";
  const author = meta.author ? `作者：${meta.author}` : "作者：未知";

  wrapper.innerHTML = `
    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
      <div style="min-width:0;">
        <div><strong style="color:#ff5555;">⛔ 疑似垃圾推文已自动折叠</strong></div>
        <div style="margin-top:4px; opacity:0.9; word-break:break-word;">
          Score: <strong>${meta.score}</strong> ｜ 命中：${reasons}
        </div>
        <div style="margin-top:2px; opacity:0.75;">
          ${author} ｜ media(v:${meta.media.videos}, i:${meta.media.images}, t:${meta.media.total})
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; white-space:nowrap;">
        <button data-action="show-once" style="
          cursor:pointer; padding:6px 10px; border-radius:10px;
          border:1px solid rgba(29,155,240,0.45); background: rgba(29,155,240,0.12);
          color: #9fd3ff; font-size:12px;
        ">显示一次</button>
      </div>
    </div>
  `;

  return wrapper;
}

/************************
 * Actions
 ************************/
function hideDirect(article) {
  if (article.dataset.pumpV46Done) return;
  article.dataset.pumpV46Done = "1";
  article.style.display = "none";
  filteredCount++;
  ensureCounter();
}

function applyAction(article, type, meta) {
  if (article.dataset.pumpV46Done) return;
  article.dataset.pumpV46Done = "1";

  if (type === "hide") {
    article.style.display = "none";
    filteredCount++; ensureCounter();
    return;
  }

  const card = makeCollapsedCard(meta);
  const showBtn = card.querySelector('button[data-action="show-once"]');

  showBtn.addEventListener("click", () => {
    article.style.display = "";
    card.remove();
  });

  article.style.display = "none";
  article.parentNode.insertBefore(card, article);

  filteredCount++;
  ensureCounter();
}

/************************
 * Core processing with hard short-circuit
 ************************/
function processArticle(article) {
  if (!isSearchPage()) return;
  if (article.dataset.pumpV46Checked) return;
  article.dataset.pumpV46Checked = "1";

  const text = getTweetTextOnly(article);
  if (!text) return;

  // CA gating only
  if (!containsCA(text)) return;

  const author = getAuthorHandle(article);

  // HARD SHORT-CIRCUIT (requested)
  if (author && whitelist.has(author)) {
    // Completely pass; no scoring, no card, no counter
    return;
  }
  console.log("author", author)
  if (author && blacklist.has(author)) {
    // Immediately hide; no scoring, no card
    hideDirect(article);
    return;
  }

  const { score, hits, media } = scoreTweet(text, article);

  if (score >= THRESH_HIDE) {
    applyAction(article, "hide", { score, hits, author, media });
  } else if (score >= THRESH_COLLAPSE) {
    applyAction(article, "collapse", { score, hits, author, media });
  }
}

function scanOnce() {
  scheduled = false;
  document.querySelectorAll("article").forEach(processArticle);
}

const observer = new MutationObserver(() => {
  if (!isSearchPage()) return;
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(scanOnce);
  }
});

observer.observe(document.body, { childList: true, subtree: true });

if (isSearchPage()) scanOnce();
