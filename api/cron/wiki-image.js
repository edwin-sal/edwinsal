const { Redis } = require('@upstash/redis');

const WIKI_IMAGE_KEY = 'wiki:image';
// Wikipedia's featured-feed REST API has no data before this date.
const FEED_START_DATE = new Date('2016-01-01T00:00:00Z');

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function randomPastDate() {
  const daysBack = Math.floor((Date.now() - FEED_START_DATE.getTime()) / 86400000);
  const d = new Date();
  d.setDate(d.getDate() - 1 - Math.floor(Math.random() * daysBack));
  return d;
}

function pad(n) { return String(n).padStart(2, '0'); }

async function fetchWikiImage(date) {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const url = `https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'edwinsal.vercel.app (personal site)' },
  });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  const data = await res.json();
  if (!data.image) throw new Error('no image in feed');
  return data.image;
}

async function pickImage() {
  for (let i = 0; i < 5; i++) {
    try {
      return await fetchWikiImage(randomPastDate());
    } catch (_) {}
  }
  throw new Error('could not fetch image after 5 attempts');
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.json({ error: 'unauthorized' });
  }

  const redis = getRedis();
  if (!redis) {
    res.statusCode = 500;
    return res.json({ error: 'redis not configured' });
  }

  try {
    const raw = await pickImage();
    const payload = {
      src: raw.thumbnail?.source || raw.image?.source,
      caption: raw.description?.html || raw.description?.text || '',
      title: raw.title || '',
      commonsUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(raw.title || '')}`,
      savedAt: Date.now(),
    };
    await redis.set(WIKI_IMAGE_KEY, payload);
    return res.json({ ok: true, image: payload });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: e.message });
  }
};
