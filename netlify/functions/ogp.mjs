// リンクカード用: 指定URLのページから、タイトル・説明・サムネイルなどを取得して返す。
// 呼び出し: GET /api/ogp?url=https://...
//
// 安全のため、取得してよいサイトは下の ALLOW_HOSTS に限っています(誰でも使える中継所にならないように)。
// 載せたいサイトが増えたら、ここにドメインを足してください。
// 環境変数 LINKCARD_ALLOW(カンマ区切り)でも指定できます。

const DEFAULT_ALLOW_HOSTS = [
  "qjweb.jp",
  "itmedia.co.jp",
  "magmix.jp",
  "note.com",
  "dofmgzn.com",
  "liberdade-consultant.netlify.app",
];

const ALLOW_HOSTS = (process.env.LINKCARD_ALLOW
  ? process.env.LINKCARD_ALLOW.split(",")
  : DEFAULT_ALLOW_HOSTS
).map((s) => s.trim().toLowerCase()).filter(Boolean);

const UA = "Mozilla/5.0 (compatible; LinkCardBot/1.0)";
const MAX_BYTES = 800 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8000;

export const config = { path: "/api/ogp" };

/* ---------- 検証 ---------- */

export function isAllowed(u) {
  let url;
  try { url = u instanceof URL ? u : new URL(u); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOW_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

/* ---------- HTML解析 ---------- */

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChr(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] ?? m));
}
function safeChr(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

export function parseHtml(html, baseUrl) {
  const head = html.slice(0, MAX_BYTES);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = decodeEntities(a.content).trim();
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const abs = (v) => {
    if (!v) return "";
    try { return new URL(decodeEntities(v), baseUrl).href; } catch { return ""; }
  };

  let favicon = "";
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel || "").toLowerCase();
    if (/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel) && a.href) {
      favicon = abs(a.href);
      if (!/apple-touch-icon/.test(rel)) break;
    }
  }
  if (!favicon) favicon = abs("/favicon.ico");

  const siteName = meta["og:site_name"] || "";
  const rawTitle = meta["og:title"] || meta["twitter:title"] || (titleTag ? decodeEntities(titleTag[1]).trim() : "");
  return {
    title: cleanTitle(rawTitle, siteName),
    description: (meta["og:description"] || meta["twitter:description"] || meta["description"] || "").replace(/\s+/g, " ").trim(),
    image: abs(meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"]),
    siteName,
    favicon,
  };
}

// 「記事名 | ねとらぼ」「記事名 - QJWeb クイック・ジャパン ウェブ」「…（1/2 ページ）」などの末尾を整える
export function cleanTitle(title, siteName) {
  let t = String(title || "").replace(/\s+/g, " ").trim();
  const seps = "[|｜\\-－–—]";
  if (siteName) {
    const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*${seps}\\s*[^|｜]*${esc}[^|｜]*$`), "");
    t = t.replace(new RegExp(`\\s*${seps}\\s*${esc}\\s*$`), "");
  }
  t = t.replace(/\s*[（(]\d+\s*\/\s*\d+\s*ページ[）)]\s*$/, "");
  return t.trim();
}

/* ---------- 取得(リダイレクトも毎回チェック) ---------- */

async function fetchWithGuard(startUrl, init = {}) {
  let url = new URL(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isAllowed(url)) throw new HttpError(400, "このURLは取得できません");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeout ?? TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8", ...(init.headers || {}) },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    return { res, url };
  }
  throw new HttpError(502, "リダイレクトが多すぎます");
}

async function readLimited(res, limit) {
  const reader = res.body?.getReader?.();
  if (!reader) return new Uint8Array(await res.arrayBuffer()).slice(0, limit);
  let acc = Buffer.alloc(0);
  while (acc.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    acc = Buffer.concat([acc, value]);
    // <head> を読み終えたら、残りは取らない
    if (acc.toString("latin1").toLowerCase().includes("</head>")) break;
  }
  try { await reader.cancel(); } catch { /* noop */ }
  return acc.subarray(0, limit);
}

function decodeBody(bytes, contentType) {
  const sniff = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  let label =
    (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "") || [])[1] ||
    (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff) || [])[1] ||
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ---------- noteだけの追加情報(スキ数・著者・日付)。取れなければ無視 ---------- */

async function noteExtras(url) {
  const m = /^\/[^/]+\/n\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (url.hostname !== "note.com" || !m) return {};
  try {
    const { res } = await fetchWithGuard(`https://note.com/api/v3/notes/${m[1]}`, {
      timeout: 4000,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return {};
    const d = (await res.json())?.data;
    if (!d) return {};
    const u = d.user || {};
    return {
      likeCount: Number(d.likeCount ?? d.like_count ?? NaN),
      authorName: String(u.nickname ?? u.name ?? ""),
      authorIcon: String(u.userProfileImagePath ?? u.user_profile_image_path ?? ""),
      publishedAt: String(d.publishAt ?? d.publish_at ?? ""),
    };
  } catch {
    return {};
  }
}

/* ---------- 本体 ---------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

export default async (req) => {
  if (req.method !== "GET") return json({ error: "GETのみ対応しています" }, 405);
  const target = new URL(req.url).searchParams.get("url");
  if (!target || target.length > 2000) return json({ error: "urlを指定してください" }, 400);

  let url;
  try { url = new URL(target); } catch { return json({ error: "URLの形式が正しくありません" }, 400); }
  if (!isAllowed(url)) return json({ error: "このサイトは対象外です" }, 400);

  try {
    const { res, url: finalUrl } = await fetchWithGuard(url, { headers: { accept: "text/html,application/xhtml+xml" } });
    if (!res.ok) return json({ error: `取得に失敗しました(${res.status})` }, 502);
    const bytes = await readLimited(res, MAX_BYTES);
    const html = decodeBody(bytes, res.headers.get("content-type"));
    const info = parseHtml(html, finalUrl.href);
    const extras = await noteExtras(finalUrl);

    return json(
      { url: finalUrl.href, host: finalUrl.hostname, ...info, ...extras },
      200,
      {
        "cache-control": "public, max-age=3600",
        "netlify-cdn-cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    );
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e?.name === "AbortError" ? 504 : 502;
    return json({ error: e instanceof HttpError ? e.message : "取得に失敗しました" }, status);
  }
};
