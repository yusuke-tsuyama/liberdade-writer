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
const MAX_BYTES = 1200 * 1024;      // これ以上は読まない
const SEARCH_BYTES = 600 * 1024;    // <head> に情報がないとき、本文をここまで探す
const AFTER_EMBED_BYTES = 24 * 1024; // 埋め込みデータを見つけたあと、続けて読む量
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

// 普通の <meta> タグ
function htmlMeta(html) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = decodeEntities(a.content).trim();
  }
  return meta;
}

// Next.js(noteなど)は、<meta> の内容を、script の中に
//   {\"property\":\"og:image\",\"content\":\"https://...\"}
// のようなエスケープされた形で入れている。それを取り出す。
function collectJsonMeta(s, out) {
  const re = /\{"(?:property|name)":"([^"]+)","content":"((?:[^"\\]|\\[\s\S])*)"\}/g;
  for (const m of s.matchAll(re)) {
    const k = m[1].toLowerCase();
    if (k in out) continue;
    try { out[k] = JSON.parse('"' + m[2] + '"').trim(); } catch { out[k] = m[2]; }
  }
}
export function embeddedMeta(text) {
  const out = {};
  const pushRe = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\[\s\S])*)"\]\)/g;
  for (const p of text.matchAll(pushRe)) {
    let chunk;
    try { chunk = JSON.parse('"' + p[1] + '"'); } catch { continue; }
    collectJsonMeta(chunk, out);
  }
  if (!Object.keys(out).length) collectJsonMeta(text.replace(/\\"/g, '"'), out); // 取りこぼし対策
  return out;
}

// og:image が無いページ用: 本文中の、最初の記事写真らしい画像を探す
const NOT_CONTENT_IMG = /logo|icon|avatar|emoji|gravatar|sprite|spacer|pixel|blank|loading|banner|header|footer|button|1x1/i;
export function firstContentImage(html, baseUrl) {
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const cand = [a["data-src"], a["data-lazy-src"], a["data-original"], (a.srcset || a["data-srcset"] || "").split(",")[0]?.trim().split(/\s+/)[0], a.src];
    const raw = cand.find((v) => v && !/^data:/i.test(v));
    if (!raw) continue;
    let abs;
    try { abs = new URL(decodeEntities(raw), baseUrl).href; } catch { continue; }
    if (!/\.(jpe?g|png|webp|avif)(\?|#|$)/i.test(abs)) continue;
    if (NOT_CONTENT_IMG.test(abs) || NOT_CONTENT_IMG.test(a.class || "") || NOT_CONTENT_IMG.test(a.alt || "")) continue;
    const w = parseInt(a.width, 10), h = parseInt(a.height, 10);
    if ((w && w < 120) || (h && h < 80)) continue;
    return abs;
  }
  return "";
}

export function parseHtml(html, baseUrl) {
  const meta = { ...embeddedMeta(html), ...htmlMeta(html) }; // 普通の<meta>を優先
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const abs = (v) => {
    if (!v) return "";
    try { return new URL(decodeEntities(v), baseUrl).href; } catch { return ""; }
  };

  let favicon = "", touch = "";
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel || "").toLowerCase();
    if (!a.href) continue;
    if (/apple-touch-icon/.test(rel)) { if (!touch) touch = abs(a.href); }
    else if (/(^|\s)(icon|shortcut icon)(\s|$)/.test(rel) && !favicon) favicon = abs(a.href);
  }
  if (!favicon) favicon = touch || abs("/favicon.ico");

  // サムネイル: og:image → twitter:image → 本文の最初の記事写真 → サイトのアイコン
  let image = abs(meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"]);
  let imageSource = image ? "meta" : "";
  if (!image) {
    image = firstContentImage(html, baseUrl);
    if (image) imageSource = "content";
  }
  if (!image) {
    image = touch || abs(meta["msapplication-tileimage"]);
    if (image) imageSource = "icon";
  }

  const siteName = meta["og:site_name"] || "";
  const rawTitle = meta["og:title"] || meta["twitter:title"] || (titleTag ? decodeEntities(titleTag[1]).trim() : "");
  return {
    title: cleanTitle(rawTitle, siteName),
    description: (meta["og:description"] || meta["twitter:description"] || meta["description"] || "").replace(/\s+/g, " ").trim(),
    image,
    imageSource,
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

// 必要な分だけ読む:
//  ・<head> に og:image / og:title があれば、そこで止める(ふつうのサイト)
//  ・無ければ、本文を探す。埋め込みデータ(noteなど)が見つかったら、少し先まで読んで止める
async function readSmart(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES);
  const chunks = [];
  let total = 0, text = "", scanFrom = 0, embedAt = -1;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    text += Buffer.from(value).toString("latin1");

    const headEnd = text.search(/<\/head>/i);
    if (headEnd >= 0 && /(?:property|name)\s*=\s*["'](?:og:image|og:title|twitter:image)["']/i.test(text.slice(0, headEnd))) break;
    if (embedAt < 0) {
      const re = /og:(?:image|title)/g;
      re.lastIndex = Math.max(0, scanFrom - 8);
      const m = re.exec(text);
      if (m) embedAt = m.index;
      scanFrom = text.length;
    }
    if (embedAt >= 0 && text.length > embedAt + AFTER_EMBED_BYTES) break;
    if (headEnd >= 0 && embedAt < 0 && total >= SEARCH_BYTES) break;
  }
  try { await reader.cancel(); } catch { /* noop */ }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

function decodeBody(bytes, contentType) {
  const sniff = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const label =
    (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "") || [])[1] ||
    (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff) || [])[1] ||
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ---------- noteの記事だけの追加情報(スキ数・著者・日付・題名)。取れなければ無視 ---------- */

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
      noteTitle: String(d.name ?? ""),
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
    const bytes = await readSmart(res);
    const html = decodeBody(bytes, res.headers.get("content-type"));
    const info = parseHtml(html, finalUrl.href);
    const { noteTitle, ...extras } = await noteExtras(finalUrl);
    if (noteTitle) info.title = noteTitle;

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
