const { Redis } = require('@upstash/redis');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const POSTS_KEY = 'posts';
const TOPICS_KEY = 'topics';
const TOPICS_USED_KEY = 'topics:used';
const LOGS_KEY = 'logs:generate';
const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TITLE_LEN = 120;
const MAX_HTML_LEN = 200_000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
const GEMINI_TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE) || 1.3;
const GEMINI_TOP_P = Number(process.env.GEMINI_TOP_P) || 0.95;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STYLE_GUIDE = readFileSync(join(__dirname, 'prompt.md'), 'utf8');

let redis;
function getRedis() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

function createRunLog(req) {
  const startedAt = Date.now();
  const runId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ua = req.headers['user-agent'] || '';
  const trigger = ua.includes('vercel-cron') ? 'cron' : 'manual';
  const events = [];
  const emit = (level, msg, extra) => {
    const entry = { dt: Date.now() - startedAt, level, msg };
    if (extra) entry.extra = extra;
    events.push(entry);
    const tail = extra ? ` ${JSON.stringify(extra)}` : '';
    const line = `[generate ${runId}] ${level} ${msg}${tail}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    runId,
    startedAt,
    trigger,
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
    snapshot(outcome) {
      return {
        runId,
        trigger,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        ...outcome,
        events,
      };
    },
  };
}

async function persistLog(client, record) {
  if (!client) return;
  try {
    const cutoff = Date.now() - LOG_TTL_MS;
    await client.zremrangebyscore(LOGS_KEY, 0, cutoff);
    await client.zadd(LOGS_KEY, { score: record.startedAt, member: record });
  } catch (e) {
    console.error(`[generate ${record.runId}] failed to persist log: ${e.message}`);
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const OPENER_SHAPES = {
  'title-says-it-all':
    'Use the "title says it all" opener shape from §8, but you MAY NOT use the exact phrase "the title explains it all, you don\'t even have to read" or any near-verbatim variant. Paraphrase the sentiment with fresh wording.',
  'obvious-solution':
    'Use the "obvious solution" opener shape from §8 — frame it as: this should be easy, the parts already exist, nobody has bothered to do it right.',
  'list-of-demands':
    'Use the "list of demands" opener shape from §8 — frame it as: here is what a [thing] actually needs, nothing on this list is unreasonable, none of it exists.',
  'personal-exasperation':
    'Use the "personal exasperation" opener shape from §8 — first-person, name specific things you have tried that all failed.',
  'cold-anecdote':
    'Open with a short, specific anecdote (2-4 sentences) about a concrete moment that triggered this rant. No meta-framing — just drop the reader into the scene, then pivot to the thesis.',
  'definition-flip':
    'Open by stating what [thing] is supposed to mean or do, then immediately contrast it with what it actually does. One or two sentences, no list yet.',
};

const CLOSER_DIRECTIONS = [
  'Close with a one-line dare. Do NOT start it with "Tell me when" — that template has been used to death. Try "Call me when…", "Until then, …", "I\'ll wait.", or invent a fresh dare that fits the topic.',
  'Close with a one-line dare aimed AT the offender, not the reader. Avoid the "Tell me when" template entirely.',
  'Close with a one-line dare that is a flat statement of intent, not a request — e.g. "I\'m not waiting around for them to figure it out." Avoid "Tell me when".',
  'Close with a one-line rhetorical question as the dare. Avoid "Tell me when".',
];

const STRUCTURE_HINTS = [
  'Structure: skip the upfront <ol>/<ul> of demands this run. Go straight from opener into the first <h3> section.',
  'Structure: open with the <ol> list of grievances, then <h3> sections — the canonical shape.',
  'Structure: omit <hr> separators between sections; let the <h3> headings carry the breaks alone.',
  'Structure: use only 3 <h3> sections. Make each one punchier and longer instead of fragmenting into many.',
  'Structure: weave a single <blockquote> into the body for a representative quote, fake error message, or imagined exchange.',
  'Structure: use <h3> + <h4> nesting at least once — a major section with a subsection underneath.',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickKey(obj) {
  const keys = Object.keys(obj);
  return keys[Math.floor(Math.random() * keys.length)];
}

function extractFirstParaText(html) {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html || '');
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractLastParaText(html) {
  const matches = [...(html || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  if (!matches.length) return '';
  return matches[matches.length - 1][1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickVariation() {
  return {
    openerShape: pickKey(OPENER_SHAPES),
    closerDirection: pick(CLOSER_DIRECTIONS),
    structureHint: pick(STRUCTURE_HINTS),
  };
}

function buildUserTurn(topic, recentPosts, variation) {
  const recent = (recentPosts || []).slice(-6).reverse();
  const recentOpeners = recent
    .map((p) => extractFirstParaText(p && p.html))
    .filter(Boolean)
    .slice(0, 5);
  const recentClosers = recent
    .map((p) => extractLastParaText(p && p.html))
    .filter(Boolean)
    .slice(0, 5);

  const avoidLines = [];
  if (recentOpeners.length) {
    avoidLines.push('Recent opening lines already published on this site — do NOT verbatim reuse any of these phrasings or sentence shapes:');
    recentOpeners.forEach((o, i) => avoidLines.push(`  ${i + 1}. ${o.slice(0, 220)}`));
  }
  if (recentClosers.length) {
    avoidLines.push('Recent closing dares — do NOT reuse these templates or near-paraphrases:');
    recentClosers.forEach((c, i) => avoidLines.push(`  ${i + 1}. ${c.slice(0, 160)}`));
  }
  const avoidBlock = avoidLines.length ? `\n\n${avoidLines.join('\n')}` : '';

  return `Write a blog post in this style about: ${topic}

This run's structural variation (apply these on top of the style guide):
- Opener shape: ${OPENER_SHAPES[variation.openerShape]}
- Closer: ${variation.closerDirection}
- ${variation.structureHint}${avoidBlock}

Output format (overrides any Markdown examples in the style guide — the site renders HTML, not Markdown):
- The "title" field: the post title only, lowercase, no ending punctuation, under 80 characters. Do NOT wrap it in an <h1> and do NOT repeat it inside "html".
- The "html" field: the body only, as an HTML fragment. No <html>, <head>, <body>, <h1>, <style>, or <script>. Allowed tags: <p>, <h3>, <h4>, <h5>, <ul>, <ol>, <li>, <em>, <strong>, <code>, <hr>, <a>, <blockquote>. No inline styles. No images.
- Heading levels: use <h3> where the style guide calls for H2 (major sections), <h4> for subsections, <h5> for minor notes.
- Use <hr> between major sections only if the structural variation above does not say otherwise.
- Do not include a "Summary", "TL;DR", or recap section at the end. Close on a single one-line dare and stop. A wrap-up that restates the points reads like AI slop.
- Do not mention that you are an AI. Do not include a byline, date, or author line — the site adds those.`;
}

async function callGeminiOnce(apiKey, model, userTurn, log, attempt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: STYLE_GUIDE }] },
    contents: [{ role: 'user', parts: [{ text: userTurn }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      temperature: GEMINI_TEMPERATURE,
      topP: GEMINI_TOP_P,
      responseJsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          html: { type: 'string' },
        },
        required: ['title', 'html'],
      },
    },
  };
  log.info('gemini request', { model, attempt });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  log.info('gemini response', { model, attempt, status: res.status });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`gemini ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    log.warn('gemini non-STOP finish', { model, attempt, finishReason });
  }
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error('gemini: no text in response');
  const parsed = JSON.parse(text);
  if (typeof parsed?.title !== 'string' || typeof parsed?.html !== 'string') {
    throw new Error('gemini: bad shape');
  }
  return parsed;
}

async function callGeminiWithRetry(apiKey, userTurn, log) {
  const plan = [
    { model: GEMINI_MODEL, label: 'primary' },
    { model: GEMINI_FALLBACK_MODEL, label: 'fallback' },
  ];
  let lastErr;
  for (let i = 0; i < plan.length; i++) {
    const { model, label } = plan[i];
    try {
      const result = await callGeminiOnce(apiKey, model, userTurn, log, i + 1);
      return { result, model, label, attempts: i + 1 };
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || RETRYABLE_STATUSES.has(e.status);
      const hasNext = i < plan.length - 1;
      if (!retryable || !hasNext) {
        log.warn('gemini attempt failed, not retrying', { model, attempt: i + 1, status: e.status, retryable, hasNext });
        throw e;
      }
      log.warn('gemini attempt failed, will retry', { model, attempt: i + 1, status: e.status, backoffMs: RETRY_BACKOFF_MS });
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  throw lastErr;
}

module.exports = async (req, res) => {
  const log = createRunLog(req);
  const client = getRedis();
  log.info('request received', { method: req.method, trigger: log.trigger });

  const finish = async (status, body, outcome) => {
    const record = log.snapshot({ status, ...outcome });
    await persistLog(client, record);
    res.statusCode = status;
    return res.json(body);
  };

  if (req.method !== 'GET') {
    log.warn('method not allowed', { method: req.method });
    return finish(405, { error: 'method not allowed' }, { result: 'method_not_allowed' });
  }

  const secret = process.env.CRON_SECRET;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!secret || !geminiKey) {
    log.error('server not configured', { hasSecret: !!secret, hasGeminiKey: !!geminiKey });
    return finish(500, { error: 'server not configured' }, { result: 'not_configured' });
  }

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    log.warn('unauthorized', { hasAuthHeader: !!auth });
    return finish(401, { error: 'unauthorized' }, { result: 'unauthorized' });
  }

  if (process.env.CRON_ENABLED !== 'true') {
    log.info('cron disabled');
    return finish(200, { ok: false, disabled: true }, { result: 'disabled' });
  }

  if (!client) {
    log.error('redis client unavailable');
    return finish(500, { error: 'server not configured' }, { result: 'no_redis' });
  }

  try {
    const rawTopic = await client.srandmember(TOPICS_KEY);
    if (typeof rawTopic !== 'string' || !rawTopic.trim()) {
      log.error('topics exhausted');
      return finish(500, { error: 'topics exhausted' }, { result: 'topics_exhausted' });
    }
    const topic = rawTopic.replace(/\s+/g, ' ').trim();
    log.info('topic picked', { topic, normalized: topic !== rawTopic });

    const existing = await client.zrange(POSTS_KEY, 0, -1);
    log.info('existing posts loaded', { count: existing.length });

    const variation = pickVariation();
    log.info('variation picked', { openerShape: variation.openerShape });
    const userTurn = buildUserTurn(topic, existing, variation);
    const { result: generated, model: usedModel, label: modelLabel, attempts } = await callGeminiWithRetry(geminiKey, userTurn, log);
    log.info('gemini succeeded', { model: usedModel, modelLabel, attempts });
    const title = generated.title.trim();
    const html = generated.html;

    if (!title || title.length > MAX_TITLE_LEN) {
      log.error('invalid title from gemini', { titleLen: title.length });
      return finish(502, { error: 'invalid title from gemini' }, { result: 'invalid_title' });
    }
    if (!html || html.length > MAX_HTML_LEN) {
      log.error('invalid html from gemini', { htmlLen: html.length });
      return finish(502, { error: 'invalid html from gemini' }, { result: 'invalid_html' });
    }
    const slug = slugify(title);
    if (!slug) {
      log.error('invalid slug', { title });
      return finish(502, { error: 'invalid slug' }, { result: 'invalid_slug' });
    }
    if (existing.some((p) => p && p.slug === slug)) {
      log.warn('slug collision', { slug });
      return finish(409, { error: 'slug exists', slug }, { result: 'slug_exists', slug });
    }

    const ts = Date.now();
    const post = {
      slug,
      title,
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(ts),
      html,
      ts,
    };
    await client.zadd(POSTS_KEY, { score: ts, member: post });
    await client.smove(TOPICS_KEY, TOPICS_USED_KEY, rawTopic);
    log.info('post saved', { slug, title, htmlLen: html.length });
    return finish(200, { ok: true, post }, { result: 'ok', slug, topic, model: usedModel, modelLabel, attempts, openerShape: variation.openerShape });
  } catch (e) {
    log.error('upstream error', { message: e.message });
    return finish(502, { error: e.message || 'upstream error' }, { result: 'error', message: e.message });
  }
};
