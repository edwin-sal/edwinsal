const { Redis } = require('@upstash/redis');

const ON_THIS_DAY_KEY = 'onthisday:fact';

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function getManilaMonthDay() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return { m, d };
}

const CATEGORIES = ['events', 'births', 'deaths', 'holidays', 'selected'];

async function fetchAndSeed(redis) {
  try {
    const { m, d } = getManilaMonthDay();
    const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/all/${m}/${d}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'edwinsal.vercel.app (personal site)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pool = CATEGORIES.flatMap((category) =>
      (data[category] || []).map((entry) => ({ category, entry }))
    );
    if (!pool.length) return null;
    const { category, entry } = pool[Math.floor(Math.random() * pool.length)];
    const payload = {
      category,
      year: entry.year,
      text: entry.text,
      savedAt: Date.now(),
    };
    await redis.set(ON_THIS_DAY_KEY, payload);
    return payload;
  } catch (_) {
    return null;
  }
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
    let fact = await redis.get(ON_THIS_DAY_KEY);

    if (!fact) {
      fact = await fetchAndSeed(redis);
    }

    if (!fact) {
      res.statusCode = 503;
      return res.json({ error: 'no fact available' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json(fact);
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
