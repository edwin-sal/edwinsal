const { WIKI_IMAGE_KEY, getRedis, pickImage } = require('../_lib/wiki');

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
    const payload = await pickImage();
    if (!payload) {
      res.statusCode = 502;
      return res.json({ error: 'could not fetch image' });
    }
    await redis.set(WIKI_IMAGE_KEY, payload);
    return res.json({ ok: true, image: payload });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: e.message });
  }
};
