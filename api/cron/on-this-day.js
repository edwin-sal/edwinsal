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

async function pickFact() {
  const { m, d } = getManilaMonthDay();
  const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/all/${m}/${d}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'edwinsal.vercel.app (personal site)' },
  });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  const data = await res.json();
  const pool = CATEGORIES.flatMap((category) =>
    (data[category] || []).map((entry) => ({ category, entry }))
  );
  if (!pool.length) throw new Error('no facts in feed');
  return pool[Math.floor(Math.random() * pool.length)];
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
    const { category, entry } = await pickFact();
    const payload = {
      category,
      year: entry.year,
      text: entry.text,
      savedAt: Date.now(),
    };
    await redis.set(ON_THIS_DAY_KEY, payload);
    return res.json({ ok: true, fact: payload });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: e.message });
  }
};
