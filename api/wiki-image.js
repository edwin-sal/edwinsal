const { Redis } = require('@upstash/redis');

const WIKI_IMAGE_KEY = 'wiki:image';
const ATTEMPTS = 6;
const USER_AGENT = 'edwinsal.vercel.app (personal site)';

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

function extractFigures(html) {
  const figures = [];
  const figureRe = /<figure\b[^>]*typeof="mw:File\/Thumb"[^>]*>([\s\S]*?)<\/figure>/g;
  let match;
  while ((match = figureRe.exec(html))) {
    const block = match[1];
    const imgMatch = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(block);
    const fileLinkMatch = /<a\b[^>]*\bhref="(\/wiki\/File:[^"]*)"/i.exec(block);
    const captionMatch = /<figcaption>([\s\S]*?)<\/figcaption>/i.exec(block);
    if (!imgMatch || !fileLinkMatch || !captionMatch || !captionMatch[1].trim()) continue;
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

  const src = figure.src.startsWith('//') ? `https:${figure.src}` : figure.src;
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

async function fetchAndSeed(redis) {
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const payload = await pickFigureFromArticle();
      if (!payload) continue;
      await redis.set(WIKI_IMAGE_KEY, payload);
      return payload;
    } catch (_) {}
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  }

  const redis = getRedis();
  if (!redis) {
    res.statusCode = 500;
    return res.json({ error: 'server not configured' });
  }

  try {
    let image = await redis.get(WIKI_IMAGE_KEY);

    if (!image) {
      image = await fetchAndSeed(redis);
    }

    if (!image) {
      res.statusCode = 503;
      return res.json({ error: 'no image available' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json(image);
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
