const { Redis } = require('@upstash/redis');

const WIKI_IMAGE_KEY = 'wiki:image';
const ATTEMPTS = 10;
const MIN_CAPTION_WORDS = 10;
// Pull candidates from a random slice of featured articles rather than truly
// random pages: only ~4% of random articles have a figure with a 10+ word
// caption, vs ~40% of featured articles, which are curated and image-rich.
const CANDIDATE_CATEGORY = 'Category:Featured articles';
// Wikipedia throttles bursts from shared IPs (Vercel). Pause briefly between
// article parses to stay under the limit.
const THROTTLE_MS = 200;
const USER_AGENT = 'edwinsal.vercel.app (personal site)';
const MAX_SRC_BYTES = 1_000_000;
// Wikimedia rejects direct/hotlinked thumbnail requests for arbitrary widths;
// only these standard $wgThumbnailSteps sizes are served without a 400.
const FALLBACK_WIDTH = 960;

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function articleUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Fetch a shuffled batch of candidate article titles from a random sort-key
// slice of the featured-articles category. The random starting letter varies
// which articles surface across days; the shuffle avoids alphabetical bias.
async function fetchCandidateTitles() {
  const letter = String.fromCharCode(97 + Math.floor(Math.random() * 26)); // a-z
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers` +
    `&cmtitle=${encodeURIComponent(CANDIDATE_CATEGORY)}&cmtype=page&cmlimit=100` +
    `&cmstartsortkeyprefix=${letter}&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const data = await res.json();
  const titles = (data.query?.categorymembers || []).map((m) => m.title).filter(Boolean);
  return shuffle(titles);
}

async function fetchArticleHtml(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.parse?.text || null;
}

const THUMB_URL_RE = /^\/\/upload\.wikimedia\.org\/(.+)\/thumb\/(.+)\/\d+px-([^/]+)$/;

async function resolveImageSrc(thumbSrc) {
  const m = THUMB_URL_RE.exec(thumbSrc);
  if (!m) return thumbSrc.startsWith('//') ? `https:${thumbSrc}` : thumbSrc;
  const [, projectPath, hashAndFile, renderedFilename] = m;
  const originalUrl = `https://upload.wikimedia.org/${projectPath}/${hashAndFile}`;
  const fallbackUrl = `https://upload.wikimedia.org/${projectPath}/thumb/${hashAndFile}/${FALLBACK_WIDTH}px-${renderedFilename}`;

  try {
    const res = await fetch(originalUrl, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    const len = Number(res.headers.get('content-length'));
    if (res.ok && Number.isFinite(len) && len > 0 && len <= MAX_SRC_BYTES) {
      return originalUrl;
    }
  } catch (_) {}
  return fallbackUrl;
}

function captionWordCount(captionHtml) {
  const text = captionHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.split(' ').length : 0;
}

function extractFigures(html) {
  const figures = [];
  const figureRe = /<figure\b[^>]*typeof="mw:File\/Thumb"[^>]*>([\s\S]*?)<\/figure>/g;
  let match;
  while ((match = figureRe.exec(html))) {
    const block = match[1];
    const imgMatch = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(block);
    const fileLinkMatch = /<a\b[^>]*\bhref="(\/wiki\/File:[^"]*)"/i.exec(block);
    const captionMatch = /<figcaption>([\s\S]*?)<\/figcaption>/i.exec(block);
    if (!imgMatch || !fileLinkMatch || !captionMatch) continue;
    if (captionWordCount(captionMatch[1]) < MIN_CAPTION_WORDS) continue;
    figures.push({
      src: imgMatch[1],
      fileHref: fileLinkMatch[1],
      captionHtml: captionMatch[1],
    });
  }
  return figures;
}

async function pickFigureFromArticle(title) {
  const html = await fetchArticleHtml(title);
  if (!html) return null;
  const figures = extractFigures(html);
  if (!figures.length) return null;
  const figure = figures[Math.floor(Math.random() * figures.length)];

  const src = await resolveImageSrc(figure.src);
  const caption = figure.captionHtml.replace(
    /href="#(cite_note-[^"]*)"/g,
    (_, anchor) => `href="${articleUrl(title)}#${anchor}"`
  );
  const commonsUrl = `https://en.wikipedia.org${figure.fileHref}`;

  return {
    src,
    caption,
    title,
    commonsUrl,
    savedAt: Date.now(),
  };
}

// Fetch a batch of candidate titles, then parse them one at a time (throttled)
// until one yields a figure with a long-enough caption.
async function pickImage() {
  const titles = (await fetchCandidateTitles()).slice(0, ATTEMPTS);
  for (let i = 0; i < titles.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    try {
      const payload = await pickFigureFromArticle(titles[i]);
      if (payload) return payload;
    } catch (_) {}
  }
  return null;
}

module.exports = { WIKI_IMAGE_KEY, getRedis, pickImage };
