const { Redis } = require('@upstash/redis');

const WIKI_IMAGE_KEY = 'wiki:image';
const MIN_CAPTION_WORDS = 10;
// Only ~3% of truly random articles have a figure with a 10+ word caption, so
// we scan a sizeable pool per run and stop at the first hit. If none of the
// pool qualifies (~15% of runs at this size) the caller keeps the previously
// stored image, so the page always shows something.
const POOL_SIZE = 80;
// Parse this many articles concurrently. Kept modest so a single run's request
// burst stays under Wikipedia's rate limit on Vercel's shared IPs, while still
// scanning the whole pool well within the function timeout.
const CONCURRENCY = 4;
// list=random caps each request; fetch the pool in batches of this size.
const RANDOM_BATCH = 40;
// Wikimedia asks for a descriptive User-Agent with a contact URL; a good one
// gets more lenient rate limits, which matters on Vercel's shared IPs.
const USER_AGENT = 'edwinsal-image-of-the-day/1.0 (https://edwinsal.vercel.app/)';
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

// Fetch a pool of truly random article titles (namespace 0), batching because
// list=random caps how many titles one request returns.
async function fetchRandomTitles(count) {
  const titles = [];
  while (titles.length < count) {
    const limit = Math.min(RANDOM_BATCH, count - titles.length);
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&list=random` +
      `&rnnamespace=0&rnlimit=${limit}&format=json&formatversion=2`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) break;
    const data = await res.json();
    const batch = (data.query?.random || []).map((r) => r.title).filter(Boolean);
    if (!batch.length) break;
    titles.push(...batch);
  }
  return titles;
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

// Scan a pool of random articles in small concurrent waves, returning as soon
// as one yields a figure with a long-enough caption. Returns null if the whole
// pool comes up empty (caller then keeps the previously stored image).
async function pickImage() {
  const titles = await fetchRandomTitles(POOL_SIZE);
  for (let i = 0; i < titles.length; i += CONCURRENCY) {
    const wave = titles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      wave.map(async (title) => {
        try {
          return await pickFigureFromArticle(title);
        } catch (_) {
          return null;
        }
      })
    );
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

module.exports = { WIKI_IMAGE_KEY, getRedis, pickImage };
