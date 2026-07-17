const REPO = 'edwin-sal/edwinsal';
const USER_AGENT = 'edwinsal.vercel.app (personal site)';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  }

  try {
    const url = `https://api.github.com/repos/${REPO}/commits?per_page=1&sha=master`;
    const ghRes = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
    if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
    const data = await ghRes.json();
    const date = data[0]?.commit?.author?.date;
    if (!date) throw new Error('no commit date in response');

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ date });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
