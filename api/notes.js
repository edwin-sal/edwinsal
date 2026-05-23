const { Redis } = require('@upstash/redis');

const ALLOWED_ORIGINS = [
  'https://edwinsal.vercel.app',
];
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;
const MAX_LEN = 20;
const STRIP_RE = /[\x00-\x1F\x7F\u200B-\u200D\uFEFF]/g;
const RATE_WINDOW_SEC = 60;
const NOTES_KEY = 'notes';

const BROWSERS = [
  [/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari'],
];
const OSES = [
  [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'], [/Windows/, 'Windows'], [/Linux/, 'Linux'],
];
function parseUA(ua) {
  if (!ua) return '';
  const b = BROWSERS.find(([re]) => re.test(ua))?.[1] || 'browser';
  const o = OSES.find(([re]) => re.test(ua))?.[1] || 'device';
  return `${b} on ${o}`;
}

let redis;
function getRedis() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

async function isRateLimited(client, ip) {
  if (process.env.RATE_LIMIT_ENABLED !== 'true') return false;
  if (!ip) return false;
  const result = await client.set(`rl:${ip}`, '1', { ex: RATE_WINDOW_SEC, nx: true });
  return result !== 'OK';
}

function pickOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (LOCALHOST_RE.test(origin)) return origin;
  return null;
}

function setCors(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'x-rate-limit');
}

async function readNotes(client) {
  return await client.zrange(NOTES_KEY, 0, -1);
}

async function addNote(client, note) {
  await client.zadd(NOTES_KEY, { score: note.ts, member: note });
}

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

module.exports = async (req, res) => {
  const origin = pickOrigin(req.headers.origin);
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const client = getRedis();
  if (!client) {
    res.statusCode = 500;
    return res.json({ error: 'server not configured' });
  }

  try {
    if (req.method === 'GET') {
      res.setHeader('x-rate-limit', process.env.RATE_LIMIT_ENABLED === 'true' ? 'on' : 'off');
      const notes = await readNotes(client);
      return res.json(notes);
    }

    if (req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (await isRateLimited(client, ip)) {
        res.statusCode = 429;
        return res.json({ error: 'chill out bru' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const raw = body?.text;
      if (typeof raw !== 'string') {
        res.statusCode = 400;
        return res.json({ error: 'text required' });
      }
      const text = raw.replace(STRIP_RE, '').trim();
      if (!text || text.length > MAX_LEN) {
        res.statusCode = 400;
        return res.json({ error: 'invalid length' });
      }
      const country = (req.headers['x-vercel-ip-country'] || '').trim();
      const city = decodeURIComponent(req.headers['x-vercel-ip-city'] || '').trim();
      const device = parseUA(req.headers['user-agent']);
      const geo = (country || city) ? { country, city } : null;
      const note = {
        text, ts: Date.now(), id: randomId(),
        ...(geo && { geo }),
        ...(device && { device }),
      };
      await addNote(client, note);
      return res.json({ ok: true, note });
    }

    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
