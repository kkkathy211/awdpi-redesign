// Turns one article captured by the bookmarklet into a story: content/stories/<slug>.html plus its images.
// Usage: node import.mjs <submission.json> <repo root> <result.json>
// Run by .github/workflows/wechat-import.yml; the submission comes from the internal form (aws/src/index.mjs).
//
// What it does:
// - removes what only works inside WeChat (scripts, profile and mini-program cards) and the blocks the old
//   import removed (style markers, the title image, "END", the Avoice project link); videos and audio
//   become a link to the original article;
// - downloads every image (img, background-image, SVG image) from WeChat's image servers and converts it to WebP;
// - stores each image once: a file that already exists anywhere in static/media/stories is reused, and one that
//   another article already has is moved to static/media/stories/shared/ (see the README);
// - writes the article with title, date, cover image and the WeChat id, so a second submission of the same article
//   replaces it at the same address.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { fixLayout } from "./layout.mjs";

const [submissionPath, repoArg, resultPath] = process.argv.slice(2);
if (!submissionPath || !repoArg || !resultPath) {
  console.error("Usage: node import.mjs <submission.json> <repo root> <result.json>");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const allowedBiz = (process.env.ALLOWED_BIZ || "").split(",").map((s) => s.trim()).filter(Boolean);
const siteUrl = (process.env.SITE_URL || "https://awdpi.org/").replace(/\/?$/, "/");

const MEDIA_REL = "media/stories";
const SHARED_REL = `${MEDIA_REL}/shared`;
const staticDir = path.join(repo, "static");
const mediaDir = path.join(staticDir, MEDIA_REL);
const storiesDir = path.join(repo, "content", "stories");
const REF = /media\/stories\/[A-Za-z0-9_./-]+/g;
const IMAGE_HOST = /(^|\.)(qpic\.cn|qlogo\.cn)$/i;
const log = (...a) => console.error(...a);

// ---------- read and check the submission ----------
const sub = JSON.parse(fs.readFileSync(submissionPath, "utf8"));
const a = sub.article || {};
function fail(message) {
  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, message }));
  log("Import stopped:", message);
  process.exit(1);
}
if (!/^\d{8}-[0-9a-f]{4}$/.test(sub.slug || "")) fail("文章编号格式不对");
if (!/^\d{4}-\d{2}-\d{2}$/.test(sub.date || "")) fail("发布日期格式不对");
if (!a.title || typeof a.title !== "string") fail("没有读到文章标题");
if (!a.html || typeof a.html !== "string") fail("没有读到文章正文");
if (allowedBiz.length && !allowedBiz.includes(a.biz)) fail("这篇文章不是 AWDPI 公众号发的");
if (sub.origin === "reprint" && !sub.authorised) fail("转载文章需要先确认已获授权");
const wechatId = [a.biz, a.mid, a.idx].every((v) => /^[A-Za-z0-9=_-]+$/.test(String(v || "")))
  ? `${a.biz}-${a.mid}-${a.idx}`
  : "";
const link = [a.link, a.url].find((u) => /^https:\/\/mp\.weixin\.qq\.com\/[^\s"'<>]*$/.test(u || "")) || "";

// The same WeChat article imported before keeps its address, even if the title or the date changed since.
let slug = sub.slug;
if (wechatId && fs.existsSync(storiesDir)) {
  for (const name of fs.readdirSync(storiesDir)) {
    const text = fs.readFileSync(path.join(storiesDir, name), "utf8").slice(0, 2000);
    if (text.includes(`wechat_id: "${wechatId}"`)) {
      slug = name.replace(/\.(html|md)$/, "");
      break;
    }
  }
}
for (const lang of ["en", "zh-cn"]) {
  for (const ext of [".html", ".md"]) {
    if (fs.existsSync(path.join(repo, "content", lang, "stories", slug + ext))) {
      fail(`网站上已有这篇文章的${lang === "en" ? "英文" : "中文"}单独版本（content/${lang}/stories/${slug}${ext}），请让网站管理员手动更新`);
    }
  }
}
const articleRel = `${MEDIA_REL}/${slug}`;
const articleDir = path.join(staticDir, articleRel);

// ---------- helpers ----------
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name !== ".DS_Store") out.push(p);
  }
  return out;
}

function contentFiles() {
  return walk(path.join(repo, "content")).filter((p) => /\.(html|md)$/.test(p));
}

// Replaces whole media paths in every content file (a path is never a prefix of a longer one).
function rewriteReferences(mapping) {
  let files = 0;
  for (const file of contentFiles()) {
    const text = fs.readFileSync(file, "utf8");
    let n = 0;
    const next = text.replace(REF, (m) => (mapping.has(m) ? (n++, mapping.get(m)) : m));
    if (n) {
      fs.writeFileSync(file, next);
      files++;
    }
  }
  return files;
}

function normaliseUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/&amp;/g, "&");
  if (s.startsWith("//")) s = "https:" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !IMAGE_HOST.test(u.hostname)) return null;
  u.protocol = "https:";
  // Ask for the original format rather than WeChat's lazy-load WebP thumbnails.
  for (const k of ["tp", "wxfrom", "wx_lazy", "wx_co"]) u.searchParams.delete(k);
  return u.toString();
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "awdpi-wechat-import (+https://github.com/kkkathy211/awdpi-redesign)" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error(`only ${buf.length} bytes`);
      return buf;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

const EXT = { jpeg: ".jpg", png: ".png", gif: ".gif", webp: ".webp" };

// WebP, like the existing stories: big images lossy at quality 60, small PNGs lossless, other small ones at 80.
// Keeps a JPEG, PNG or GIF as it is when WebP would not be smaller.
async function convert(buf) {
  const meta = await sharp(buf, { animated: true, failOn: "none" }).metadata();
  const format = meta.format;
  if (format === "webp") return { buf, ext: ".webp" };
  const big = buf.length > 50 * 1024;
  let img = sharp(buf, { animated: true, failOn: "none" });
  if ((meta.width || 0) > 1920) img = img.resize({ width: 1920, withoutEnlargement: true });
  const options = format === "png" && !big ? { lossless: true } : { quality: big ? 60 : 80 };
  const out = await img.webp(options).toBuffer();
  if (EXT[format] && out.length >= buf.length) return { buf, ext: EXT[format] };
  return { buf: out, ext: ".webp" };
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ---------- clean the article body ----------
const $ = cheerio.load(`<div id="awdpi-root">${a.html}</div>`, null, false);
const root = $("#awdpi-root");

root.find("script, noscript, link, meta, base, form, input, button, textarea, select").remove();
root.find("*").each((_, el) => {
  for (const name of Object.keys(el.attribs || {})) {
    const value = el.attribs[name] || "";
    if (/^on/i.test(name)) $(el).removeAttr(name);
    else if (/^(href|src|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value)) $(el).removeAttr(name);
  }
});

// Removes an ancestor `levels` up from el, as the old import did, but never the article itself
// and never a block that holds real text.
function removeAncestor(el, levels, maxText) {
  let target = $(el);
  for (let i = 0; i < levels; i++) {
    const parent = target.parent();
    if (!parent.length || parent.is(root)) break;
    target = parent;
  }
  if (target.is(root) || target.text().trim().length > maxText) return false;
  target.remove();
  return true;
}

let removed = 0;
root.find("p:has(> mp-style-type), mp-style-type").each((_, el) => { $(el).remove(); removed++; });

// The title image at the top of the body repeats the cover.
const titleImage = root.find("[data-croporisrc]").first();
if (titleImage.length && removeAncestor(titleImage[0], 3, 40)) removed++;

for (const [text, selector, levels] of [
  ["Avoice海外华人女性保护项目介绍链接", "span", 5],
  ["Avoice海外华人女性保护项目介绍链接", "p", 4],
  ["END", "span", 6],
  ["END", "strong", 5],
]) {
  root.find(selector).filter((_, el) => $(el).html() === text).each((_, el) => {
    if (removeAncestor(el, levels, 80)) removed++;
  });
}

// Profile, mini-program and ad cards only work inside WeChat.
root.find("mp-common-profile, mp-miniprogram, mp-common-miniprogram, mpprofile, .js_uneditable.custom_select_card_wrp").each((_, el) => {
  $(el).remove();
  removed++;
});

// Videos and audio cannot play outside WeChat: point to the original article instead.
function note(what) {
  const p = $('<p style="text-align:center;font-size:14px;color:#888"></p>');
  const text = `此处有${what}，请在公众号原文中观看`;
  if (link) p.append($('<a target="_blank" rel="noopener"></a>').attr("href", link).text(text));
  else p.text(text);
  return p;
}
let media = 0;
root.find("iframe, mpvideo, mp-video, mpvideosnap, mp-common-videosnap, mpvoice, mp-common-mpaudio, qqmusic, mp-common-qqmusic, video, audio").each((_, el) => {
  const tag = el.tagName.toLowerCase();
  const isVideo = /video|iframe/.test(tag) || /v\.qq\.com|video/.test($(el).attr("data-src") || $(el).attr("src") || "");
  const isAudio = /voice|audio|music/.test(tag);
  if (tag === "iframe" && !isVideo) $(el).remove();
  else $(el).replaceWith(note(isAudio ? "音频" : "视频"));
  media++;
});

// Phone layouts on a wider page (see layout.mjs).
const layout = fixLayout($, root);

// ---------- collect images ----------
const uses = []; // { url, apply(newPath) }
const STYLE_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
root.find("img").each((_, el) => {
  const img = $(el);
  const candidates = [img.attr("data-src"), img.attr("src"), img.attr("data-croporisrc")];
  const url = candidates.map(normaliseUrl).find(Boolean);
  for (const k of ["srcset", "data-src", "data-croporisrc", "data-backsrc", "data-before-oversubscription-url"]) img.removeAttr(k);
  if (url) uses.push({ url, apply: (p) => img.attr("src", p) });
  else if (/^data:/.test(img.attr("src") || "") || !img.attr("src")) img.remove();
});
root.find("*").each((_, el) => {
  const node = $(el);
  const lazy = normaliseUrl(node.attr("data-lazy-bgimg"));
  node.removeAttr("data-lazy-bgimg");
  const style = node.attr("style") || "";
  const found = [];
  for (const m of style.matchAll(STYLE_URL)) {
    const url = normaliseUrl(m[2]);
    if (url) found.push({ raw: m[0], url });
  }
  if (lazy && !found.some((f) => f.url === lazy)) {
    uses.push({ url: lazy, apply: (p) => node.attr("style", `${node.attr("style") || ""};background-image:url("${p}")`) });
  }
  for (const f of found) {
    uses.push({ url: f.url, apply: (p) => node.attr("style", (node.attr("style") || "").split(f.raw).join(`url("${p}")`)) });
  }
  for (const attr of ["href", "xlink:href"]) {
    if (el.tagName.toLowerCase() === "image") {
      const url = normaliseUrl(node.attr(attr));
      if (url) uses.push({ url, apply: (p) => node.attr(attr, p) });
    }
  }
});
const coverUrl = normaliseUrl(a.cover);

// ---------- download, convert, store once ----------
// Index every story image by content.
const index = new Map(); // sha256 -> rel path ("media/stories/...")
// A second import of the same article starts from a clean folder: drop its old files that nothing else uses.
const oldFiles = new Set(walk(articleDir).map((p) => path.relative(staticDir, p).split(path.sep).join("/")));
if (oldFiles.size) {
  const selfFiles = [".html", ".md"].map((ext) => path.join(storiesDir, slug + ext));
  const usedElsewhere = new Set();
  for (const file of contentFiles()) {
    if (selfFiles.includes(file)) continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(REF)) if (oldFiles.has(m[0])) usedElsewhere.add(m[0]);
  }
  for (const rel of oldFiles) if (!usedElsewhere.has(rel)) fs.rmSync(path.join(staticDir, rel));
}
for (const file of walk(mediaDir)) {
  index.set(sha256(fs.readFileSync(file)), path.relative(staticDir, file).split(path.sep).join("/"));
}

const unique = [...new Set([...(coverUrl ? [coverUrl] : []), ...uses.map((u) => u.url)])];
const stored = new Map(); // url -> "/media/stories/..."
const failed = [];
let counter = 0, reused = 0, movedToShared = 0, bytes = 0;
const moves = new Map(); // old rel -> shared rel, for other articles

const prepared = await pool(unique, 6, async (url) => {
  try {
    return { url, ...(await convert(await download(url))) };
  } catch (e) {
    log(`Image failed: ${url} (${e.message})`);
    return { url, error: e.message };
  }
});

fs.mkdirSync(articleDir, { recursive: true });
for (const item of prepared) {
  if (item.error) {
    failed.push(item.url);
    continue;
  }
  const digest = sha256(item.buf);
  let rel = index.get(digest);
  if (rel && rel.startsWith(articleRel + "/")) {
    // already stored for this article in this run
  } else if (rel && rel.startsWith(SHARED_REL + "/")) {
    reused++;
  } else if (rel) {
    // Another article has the same image: move it to shared/ and point that article there too.
    const sharedRel = `${SHARED_REL}/${digest.slice(0, 16)}${path.extname(rel).toLowerCase()}`;
    fs.mkdirSync(path.join(staticDir, SHARED_REL), { recursive: true });
    fs.renameSync(path.join(staticDir, rel), path.join(staticDir, sharedRel));
    moves.set(rel, sharedRel);
    index.set(digest, sharedRel);
    rel = sharedRel;
    reused++;
    movedToShared++;
  } else {
    // Old files kept because another page still uses them keep their names.
    let name = item.url === coverUrl ? `cover${item.ext}` : `${++counter}${item.ext}`;
    while (fs.existsSync(path.join(articleDir, name))) name = `${++counter}${item.ext}`;
    rel = `${articleRel}/${name}`;
    fs.writeFileSync(path.join(staticDir, rel), item.buf);
    index.set(digest, rel);
    bytes += item.buf.length;
  }
  stored.set(item.url, "/" + rel);
}
const otherArticles = moves.size ? rewriteReferences(moves) : 0;
for (const dir of new Set([articleDir, ...[...moves.keys()].map((rel) => path.dirname(path.join(staticDir, rel)))])) {
  if (fs.existsSync(dir) && !fs.readdirSync(dir).filter((f) => f !== ".DS_Store").length) fs.rmSync(dir, { recursive: true });
}

for (const use of uses) {
  // An image that could not be downloaded stays on WeChat's server; the site sends no Referer, so it still shows.
  use.apply(stored.get(use.url) || use.url);
}

// ---------- write the article ----------
let body = root.html().trim();
const image = (coverUrl && stored.get(coverUrl)) || [...stored.values()][0] || "";
const yaml = (s) => JSON.stringify(String(s).replace(/\s+/g, " ").trim());
const front = [
  "---",
  `title: ${yaml(a.title)}`,
  `date: ${sub.date}`,
  image ? `image: ${image}` : null,
  wechatId ? `wechat_id: ${yaml(wechatId)}` : null,
  link ? `wechat: ${yaml(link)}` : null,
  sub.origin === "reprint" ? "reprint: true" : null,
  "---",
].filter(Boolean).join("\n");
fs.mkdirSync(storiesDir, { recursive: true });
const existed = [".html", ".md"].some((ext) => fs.existsSync(path.join(storiesDir, slug + ext)));
fs.rmSync(path.join(storiesDir, slug + ".md"), { force: true });
fs.writeFileSync(path.join(storiesDir, slug + ".html"), `${front}\n${body}\n`);

const zh = /\p{Script=Han}/u.test(a.title);
const result = {
  ok: true,
  slug,
  title: a.title,
  replaced: existed,
  url: `${siteUrl}${zh ? "zh-cn/" : ""}stories/${slug}/`,
  images: stored.size,
  imagesReused: reused,
  imagesMovedToShared: movedToShared,
  otherArticlesUpdated: otherArticles,
  imagesFailed: failed.length,
  newImageBytes: bytes,
  blocksRemoved: removed,
  mediaReplacedWithLink: media,
  imageStylesRestored: layout.restored,
  hangingMarginsRemoved: layout.margins,
};
fs.writeFileSync(resultPath, JSON.stringify(result));
log(JSON.stringify(result, null, 1));
