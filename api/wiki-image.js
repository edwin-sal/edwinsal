const { Redis } = require('@upstash/redis');

const WIKI_IMAGE_KEY = 'wiki:image';
const DAYS_BACK = 730;

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function randomPastDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1 - Math.floor(Math.random() * DAYS_BACK));
  return d;
}

function pad(n) { return String(n).padStart(2, '0'); }

async function fetchAndSeed(redis, save = true) {
  for (let i = 0; i < 5; i++) {
    try {
      const date = randomPastDate();
      const y = date.getFullYear();
      const m = pad(date.getMonth() + 1);
      const d = pad(date.getDate());
      const url = `https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'edwinsal.vercel.app (personal site)' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.image) continue;
      const raw = data.image;
      const payload = {
        src: raw.thumbnail?.source || raw.image?.source,
        caption: raw.description?.html || raw.description?.text || '',
        title: raw.title || '',
        commonsUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(raw.title || '')}`,
        savedAt: Date.now(),
      };
      if (save) await redis.set(WIKI_IMAGE_KEY, payload);
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
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const fresh = qs.get('fresh') === '1';
    let image = fresh ? null : await redis.get(WIKI_IMAGE_KEY);

    if (!image) {
      image = await fetchAndSeed(redis, !fresh);
    }

    if (!image) {
      res.statusCode = 503;
      return res.json({ error: 'no image available' });
    }

    res.setHeader('Cache-Control', fresh ? 'no-store' : 'public, max-age=3600');
    return res.json(image);
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
