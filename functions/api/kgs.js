// Cloudflare Pages Function twin of api/kgs.js (used automatically when the site is hosted on Cloudflare Pages).
const UPSTREAM = "https://apicf.udemylover.workers.dev";
export async function onRequest({ request }) {
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!/^\/api\/courses\/[A-Za-z0-9_\-\/?=&%.]*$/.test(path) || path.includes("..") || path.includes("//")) {
    return new Response(JSON.stringify({ success: false, message: "Bad path" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const r = await fetch(UPSTREAM + path, { headers: { Accept: "application/json", Origin: "https://darkuniversekgs.vercel.app", Referer: "https://darkuniversekgs.vercel.app/" } });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
}
