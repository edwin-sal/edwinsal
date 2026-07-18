const { WIKI_IMAGE_KEY, getRedis, pickImage } = require('./_lib/wiki');

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
      image = await pickImage();
      if (image) await redis.set(WIKI_IMAGE_KEY, image);
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
