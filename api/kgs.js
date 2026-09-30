// Optional Vercel serverless fallback: forwards read-only KGS API calls when the browser can't reach the worker directly (CORS/network).
const UPSTREAM = "https://apicf.udemylover.workers.dev";
const HEADERS = { Accept: "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36", "Accept-Language": "en-US,en;q=0.9", Origin: "https://darkuniversekgs.vercel.app", Referer: "https://darkuniversekgs.vercel.app/" };

module.exports = async (req, res) => {
  const path = String(req.query.path || "");
  if (!/^\/api\/courses\/[A-Za-z0-9_\-\/?=&%.]*$/.test(path) || path.includes("..") || path.includes("//")) {
    res.status(400).json({ success: false, message: "Bad path" });
    return;
  }
  try {
    const upstream = await fetch(UPSTREAM + path, { headers: HEADERS });
    const text = await upstream.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ success: false, message: "Upstream unavailable" });
  }
};
