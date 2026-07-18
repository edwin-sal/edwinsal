const { Redis } = require('@upstash/redis');

const WIKI_IMAGE_KEY = 'wiki:image';
const ATTEMPTS = 12;
const MIN_CAPTION_WORDS = 10;
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

async function fetchRandomStandardTitle() {
  const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary', {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.type !== 'standard' || !data.title) return null;
  return data.title;
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

async function pickFigureFromArticle() {
  const title = await fetchRandomStandardTitle();
  if (!title) return null;
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

// Try up to ATTEMPTS random articles until one yields a captioned figure.
async function pickImage() {
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const payload = await pickFigureFromArticle();
      if (payload) return payload;
    } catch (_) {}
  }
  return null;
}

module.exports = { WIKI_IMAGE_KEY, getRedis, pickImage };
