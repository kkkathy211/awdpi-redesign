// Internal form for syncing WeChat articles to the website.
//   GET  /                     install page with the bookmark and instructions
//   POST /capture              the bookmark posts the open article here; keeps it as a draft, shows the confirm form
//   POST /submit               team password + original/reprint choice + category; queues the import and starts the workflow
//   GET  /status/<id>          progress page
//   GET  /status/<id>/data     progress as JSON (written by the GitHub workflow)
// The confirm form suggests a category with a model on Bedrock (classify.mjs); the categories are read from
// data/story_categories.json in the website repository. Article text is never logged. Drafts expire after 2 days, submissions and progress after 90 (bucket lifecycle).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { choices, classify, plainText } from "./classify.mjs";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const bedrock = new BedrockRuntimeClient({ maxAttempts: 2 });
const { BUCKET, REPO, WORKFLOW, SITE_URL, PASSWORD_PARAM, TOKEN_PARAM } = process.env;
const ALLOWED_BIZ = (process.env.ALLOWED_BIZ || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 5.5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_HOST = /(^|\.)(qpic\.cn|qlogo\.cn)$/i;
const BOOKMARKLET_SOURCE = fs.readFileSync(new URL("./bookmarklet.js", import.meta.url), "utf8");
// The version the install page hands out; a capture from an older bookmark gets a notice on the confirm page.
const BOOKMARK_VERSION = Number((BOOKMARKLET_SOURCE.match(/^\s*v:\s*(\d+),/m) || [])[1] || 1);
const BOOKMARKLET = BOOKMARKLET_SOURCE
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.trim())
  .join(" ");

const log = (event, extra = {}) => console.log(JSON.stringify({ event, ...extra }));

// ---------- storage ----------
async function put(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: JSON.stringify(value), ContentType: "application/json",
  }));
}
async function get(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name === "NoSuchKey") return null;
    throw e;
  }
}
async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

const params = {};
async function param(name) {
  const hit = params[name];
  if (hit && hit.until > Date.now()) return hit.value;
  let value = "";
  try {
    value = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter.Value;
  } catch (e) {
    if (e.name !== "ParameterNotFound") throw e;
  }
  params[name] = { value, until: Date.now() + 5 * 60 * 1000 };
  return value;
}

// ---------- categories ----------
let categoryCache = { list: [], rules: [], until: 0 };
async function loadCategories() {
  if (categoryCache.until > Date.now()) return categoryCache;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/data/story_categories.json`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      categoryCache = { list: d.categories || [], rules: d.rules || [], until: Date.now() + 5 * 60 * 1000 };
    }
  } catch {
    // keep the last list
  }
  return categoryCache;
}
// The categories an article may have: all of them except those whose `titleMust` text is not in the title.
async function categories(title) {
  const { list, rules } = await loadCategories();
  const allowed = choices(list, [], title).allowed;
  return { list: allowed.length ? allowed : list, rules };
}

async function suggest(article, cats, rules) {
  if (!cats.length) return null;
  try {
    const r = await classify(bedrock, cats, { title: article.title, html: article.html }, { timeoutMs: 12000, rules });
    log("classified", { category: r.category, source: r.source, inTok: r.inputTokens, outTok: r.outputTokens });
    return r.category ? r : null;
  } catch (e) {
    log("classify_failed", { name: e.name });
    return null;
  }
}

// The card text: the summary set in the WeChat editor, unless WeChat just copied the start of the article into it;
// then the excerpt the model copied from the article.
function cardText(article, suggestion) {
  const squash = (x) => String(x || "").replace(/\s+/g, "");
  const desc = String(article.desc || "").replace(/\s+/g, " ").trim();
  if (desc.length >= 10 && !squash(plainText(article.html)).startsWith(squash(desc).replace(/…+$|\.{3}$/, ""))) return desc.slice(0, 200);
  return suggestion?.excerpt || "";
}

// ---------- the article ----------
function checkArticle(a) {
  if (!a || typeof a !== "object") return "没有读到文章。";
  let host = "";
  try { host = new URL(a.url).hostname; } catch { /* checked below */ }
  if (host !== "mp.weixin.qq.com") return "这个书签只能用在公众号文章页面上。";
  if (ALLOWED_BIZ.length && !ALLOWED_BIZ.includes(a.biz)) {
    return `这篇文章是“${String(a.account || "其他公众号").slice(0, 40)}”发的。只能同步 AWDPI 公众号自己发的文章。`;
  }
  if (typeof a.title !== "string" || !a.title.trim() || a.title.length > 300) return "没有读到文章标题。";
  if (!/^\d{9,11}$/.test(String(a.ct || ""))) return "没有读到发布时间。请等文章完全显示出来再点书签。";
  if (typeof a.html !== "string" || a.html.length < 20) return "没有读到文章正文。请等文章完全显示出来再点书签。";
  return "";
}

function derive(a) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Number(a.ct) * 1000));
  // Same naming as the existing stories: date + first 4 hex digits of the title's SHA-256.
  const slug = `${date.replaceAll("-", "")}-${createHash("sha256").update(a.title.trim()).digest("hex").slice(0, 4)}`;
  const zh = /\p{Script=Han}/u.test(a.title);
  const text = a.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const images = (a.html.match(/<img\b/gi) || []).length;
  // The label follows the browser language ("原创" or "Original").
  const original = a.copyright === "1" || /原创|original/i.test(a.originalLabel || "");
  const hints = [];
  if (a.shareSource) hints.push(`页面上写着：${a.shareSource.slice(0, 80)}`);
  const m = text.match(/.{0,12}(转载自|转自|来源[:：]|本文来源|原文链接|经授权转载|授权转载|编译自|翻译自).{0,20}/);
  if (m) hints.push(`正文里有：“${m[0].trim()}”`);
  return { slug, date, url: `${SITE_URL}${zh ? "zh-cn/" : ""}stories/${slug}/`, chars: text.length, images, original, hints, excerpt: text.slice(0, 160) };
}

async function storyExists(slug) {
  const check = (ext) => fetch(`https://raw.githubusercontent.com/${REPO}/main/content/stories/${slug}${ext}`, {
    method: "HEAD", signal: AbortSignal.timeout(2500),
  }).then((r) => r.ok, () => false);
  const found = await Promise.all([check(".html"), check(".md")]);
  return found.some(Boolean);
}

async function checkPassword(given) {
  const expected = await param(PASSWORD_PARAM);
  if (!expected || !given) return false;
  const h = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

async function dispatch(id) {
  const token = await param(TOKEN_PARAM);
  if (!token) {
    log("dispatch_skipped", { reason: "no_token" });
    return false;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "awdpi-wechat-sync",
    },
    body: JSON.stringify({ ref: "main", inputs: { id } }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => ({ status: 0, error: e.name }));
  if (r.status !== 204) {
    log("dispatch_failed", { status: r.status });
    return false;
  }
  return true;
}

// ---------- HTTP ----------
function html(status, body, nonce = "") {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        "img-src https://*.qpic.cn https://*.qlogo.cn data:",
        "style-src 'unsafe-inline'",
        nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    },
    body,
  };
}
function json(status, value) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    body: JSON.stringify(value),
  };
}
function bodyText(event) {
  const raw = event.body || "";
  return event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || "/";
  const endpoint = `https://${event.requestContext?.domainName}`;
  let m;
  try {
    if (method === "GET" && path === "/") return html(200, ...installPage(endpoint));
    if (method === "POST" && path === "/capture") return await capture(event);
    if (method === "POST" && path === "/submit") return await submit(event);
    if (method === "GET" && (m = path.match(/^\/status\/([0-9a-f-]{36})$/)) && UUID.test(m[1])) return html(200, ...statusPage(m[1]));
    if (method === "GET" && (m = path.match(/^\/status\/([0-9a-f-]{36})\/data$/)) && UUID.test(m[1])) {
      return json(200, (await get(`status/${m[1]}.json`)) || { state: "unknown" });
    }
    return html(404, message("找不到这个页面", "请从书签打开。"));
  } catch (e) {
    log("error", { route: path, name: e.name });
    return html(500, message("出错了", "请稍后再试。如果一直不行，请联系网站管理员。"));
  }
}

async function capture(event) {
  const text = bodyText(event);
  if (text.length > MAX_BODY) return html(413, message("文章太长", "这篇文章超过了表单能接收的大小，请联系网站管理员手动添加。"));
  let article;
  try {
    const raw = text.startsWith("payload=") ? text.slice(8) : new URLSearchParams(text).get("payload");
    article = JSON.parse(String(raw).trim());
  } catch {
    return html(400, message("没有读到文章", "请在公众号文章页面上点“同步到官网”书签，不要直接打开这个网址。"));
  }
  const problem = checkArticle(article);
  if (problem) {
    log("capture_rejected");
    return html(400, message("不能同步这篇文章", problem));
  }
  const derived = derive(article);
  const id = randomUUID();
  const { list: cats, rules } = await categories(article.title);
  const [already, suggestion] = await Promise.all([storyExists(derived.slug), suggest(article, cats, rules)]);
  const description = cardText(article, suggestion);
  await put(`drafts/${id}.json`, { id, createdAt: new Date().toISOString(), ...derived, suggestion, description, article });
  log("captured", { id, slug: derived.slug, bytes: text.length });
  return html(200, formPage({ id, article, d: { ...derived, suggestion, description }, already, cats }));
}

async function submit(event) {
  const form = new URLSearchParams(bodyText(event));
  const id = form.get("id") || "";
  if (!UUID.test(id)) return html(400, message("没有读到文章", "请回到公众号文章页面，重新点一次书签。"));
  if (await exists(`status/${id}.json`)) return { statusCode: 303, headers: { Location: `/status/${id}` }, body: "" };
  const draft = await get(`drafts/${id}.json`);
  if (!draft) return html(410, message("这次提交已过期", "请回到公众号文章页面，重新点一次书签。"));
  const origin = form.get("origin");
  const authorised = form.get("authorised") === "yes";
  const category = form.get("category") || "";
  const { list: cats } = await categories(draft.article.title);
  const errors = [];
  if (origin !== "original" && origin !== "reprint") errors.push("请选择这篇文章是原创还是转载。");
  if (origin === "reprint" && !authorised) errors.push("转载或改编的文章，要先取得原作者或原公众号的授权，再勾选确认。");
  // Without the category list (GitHub unreachable) the article is imported without a category.
  if (cats.length && !cats.some((c) => c.id === category)) errors.push("请选择分类。");
  if (!(await checkPassword(form.get("password") || ""))) errors.push("团队密码不对。");
  if (errors.length) {
    log("submit_rejected", { id, count: errors.length });
    return html(400, formPage({ id, article: draft.article, d: draft, already: null, errors, origin, authorised, category, cats }));
  }
  const now = new Date().toISOString();
  await put(`inbox/${id}.json`, {
    id, slug: draft.slug, date: draft.date, url: draft.url, origin, authorised, category, description: draft.description || "",
    submittedAt: now, article: draft.article,
  });
  const started = await dispatch(id);
  await put(`status/${id}.json`, { state: started ? "queued" : "waiting", title: draft.article.title, url: draft.url, at: now });
  log("submitted", { id, slug: draft.slug, category, aiCategory: draft.suggestion?.category || null, started });
  return { statusCode: 303, headers: { Location: `/status/${id}` }, body: "" };
}

// ---------- pages ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function imageUrl(raw) {
  try {
    const u = new URL(String(raw).replace(/^\/\//, "https://"));
    if (!IMAGE_HOST.test(u.hostname)) return "";
    u.protocol = "https:";
    return u.toString();
  } catch {
    return "";
  }
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f3ef;--card:#fff;--ink:#1d1a17;--muted:#6b635b;--line:#e4ddd5;--accent:#b2353b;--ok:#2f7d4f;--warn:#9a5b00;--warn-bg:#fff4e0;--err-bg:#fdecec}
@media (prefers-color-scheme:dark){:root{--bg:#1a1816;--card:#24211e;--ink:#f1ede8;--muted:#b0a79d;--line:#3a3530;--accent:#e2686d;--ok:#6cc495;--warn:#f0b45c;--warn-bg:#3a2e1c;--err-bg:#3d2224}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;line-height:1.3;margin:0 0 6px}h2{font-size:19px;margin:32px 0 10px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0}
.cover{width:100%;aspect-ratio:2.35/1;object-fit:cover;border-radius:10px;background:var(--line);display:block;margin-bottom:14px}
.title{font-size:20px;font-weight:600;line-height:1.4;margin:0 0 8px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:15px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.note{border-radius:10px;padding:12px 14px;margin:14px 0;font-size:15px}.warn{background:var(--warn-bg);color:var(--warn)}.err{background:var(--err-bg);color:var(--accent)}
fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:600;margin-bottom:8px}label.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer}
label.opt input{margin-top:5px}select,input[type=password]{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
button,.btn{display:inline-block;font:inherit;font-weight:600;padding:11px 22px;border-radius:999px;border:0;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
.bm{font-size:17px;padding:12px 26px;cursor:grab}ol{padding-left:22px;margin:0 0 12px}li{margin-bottom:6px}textarea{width:100%;height:84px;font:12px/1.4 ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--bg);color:var(--ink)}
.state{font-size:20px;font-weight:600;margin:0 0 8px}.state.ok{color:var(--ok)}.state.bad{color:var(--accent)}a{color:var(--accent)}kbd{font:13px ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:5px;padding:1px 5px}
`;

function layout(title, body, nonce = "", script = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

function message(title, text) {
  return layout(title, `<h1>${esc(title)}</h1><div class="card"><p>${esc(text)}</p></div><p class="muted">AWDPI 官网 · 公众号文章同步</p>`);
}

function installPage(endpoint) {
  const code = `javascript:${encodeURIComponent(BOOKMARKLET.replace("__ENDPOINT__", endpoint))}`;
  const nonce = randomBytes(16).toString("base64");
  const body = `
<h1>公众号文章同步到官网</h1>
<p class="muted">AWDPI 内部工具，请不要转发这个网址。</p>
<div class="card">
<p>公众号发出文章后，用一个浏览器书签把这篇文章同步到 AWDPI 官网。文章正文和图片会保存到网站上，不需要再手动整理。</p>
</div>
<h2>第一步：安装书签（每台电脑只需一次）</h2>
<ol>
<li>用电脑上的 Chrome、Edge 或 Safari 打开这个页面。</li>
<li>显示书签栏：Chrome 和 Edge 按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>（Mac 按 <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>）；Safari 选“显示 → 显示个人收藏栏”。</li>
<li>用鼠标把下面这个按钮拖到书签栏上（不要在这里点它）：</li>
</ol>
<p><a class="btn bm" href="${esc(code)}">同步到官网</a></p>
<p class="muted">拖不过去的话：手动新建一个书签，名称填“同步到官网”，网址填下面框里的全部内容。</p>
<textarea readonly id="code">${esc(code)}</textarea>
<p><button type="button" id="copy">复制书签网址</button></p>
<h2>第二步：同步一篇文章</h2>
<ol>
<li>公众号群发后，在电脑上的浏览器里打开这篇文章。可以在电脑微信里打开文章，点右上角的“…”，选“在默认浏览器中打开”；也可以把文章链接复制到浏览器的地址栏。</li>
<li>等文章完全显示出来，点书签栏里的“同步到官网”。</li>
<li>在打开的页面上核对标题、日期和封面，选择“原创”或“转载”，输入团队密码，点“发布到官网”。</li>
<li>等页面显示“已发布”。大约 2 分钟后，文章会出现在网站上。</li>
</ol>
<h2>注意</h2>
<ul>
<li>只能同步 AWDPI 公众号自己发的文章。</li>
<li>转载或改编自别人的文章，要先取得原作者或原公众号的授权。</li>
<li>文章发出后改过的，可以再同步一次，网站上的那篇会被替换。</li>
<li>文章里的视频和音频不会同步，网站上会显示一个链接，指向公众号原文。</li>
<li>团队密码请不要发到群里或其他公开的地方。</li>
</ul>`;
  const script = `document.getElementById("copy").addEventListener("click",function(){var t=document.getElementById("code");t.select();navigator.clipboard.writeText(t.value).then(function(){document.getElementById("copy").textContent="已复制";},function(){document.execCommand("copy");document.getElementById("copy").textContent="已复制";});});`;
  return [layout("公众号文章同步到官网", body, nonce, script), nonce];
}

function formPage({ id, article: a, d, already, errors = [], origin, authorised, category, cats = [] }) {
  const cover = imageUrl(a.cover);
  const chosen = origin || (d.original && !d.hints.length ? "original" : "");
  const ai = d.suggestion;
  const pickedCat = category ?? ai?.category ?? "";
  const aiCat = ai && cats.find((c) => c.id === ai.category);
  const body = `
<h1>同步到官网</h1>
<p class="muted">核对下面的信息，确认后发布到 AWDPI 官网。</p>
${Number(a.v) >= BOOKMARK_VERSION ? "" : `<div class="note warn"><strong>请重新安装书签。</strong>你用的是旧版“同步到官网”书签，有些内容可能读不全（例如图片消息的配图）。请打开<a href="/">书签安装页</a>，删掉书签栏上的旧书签，把新的拖上去，然后回到文章页重新点一次书签。</div>`}
${errors.map((e) => `<div class="note err">${esc(e)}</div>`).join("")}
<div class="card">
${cover ? `<img class="cover" src="${esc(cover)}" alt="">` : ""}
<p class="title">${esc(a.title)}</p>
<dl>
<dt>发布日期</dt><dd>${esc(d.date)}</dd>
<dt>公众号</dt><dd>${esc(a.account || "")}${a.author ? `（作者：${esc(a.author)}）` : ""}</dd>
<dt>正文</dt><dd>约 ${d.chars.toLocaleString("zh-CN")} 字，${d.images} 张图片</dd>
<dt>网站地址</dt><dd>${esc(d.url)}</dd>
</dl>
<p class="muted" style="margin-top:12px">${esc(d.excerpt)}${d.chars > d.excerpt.length ? "……" : ""}</p>
${d.description ? `<p class="muted"><strong>网站卡片上的介绍：</strong>${esc(d.description)}</p>` : ""}
</div>
${already ? `<div class="note warn">网站上已经有这篇文章。提交后，网站上的那篇会换成公众号上现在的版本。</div>` : ""}
${d.hints.length ? `<div class="note warn">这篇文章可能是转载的。${d.hints.map(esc).join("；")}</div>` : ""}
<form method="post" action="/submit" class="card">
<input type="hidden" name="id" value="${esc(id)}">
<fieldset><legend>这篇文章是：</legend>
<label class="opt"><input type="radio" name="origin" value="original"${chosen === "original" ? " checked" : ""}><span>AWDPI 自己写的（原创）${d.original ? `<br><span class="muted">公众号上标了“原创”</span>` : ""}</span></label>
<label class="opt"><input type="radio" name="origin" value="reprint"${chosen === "reprint" ? " checked" : ""}><span>转载或改编自别人的文章</span></label>
<label class="opt"><input type="checkbox" name="authorised" value="yes"${authorised ? " checked" : ""}><span>是转载的话：我确认已经取得原作者或原公众号的授权，可以发到 AWDPI 官网上</span></label>
</fieldset>
${cats.length ? `<p><label for="cat"><strong>分类</strong></label></p>
<p><select id="cat" name="category" required>
<option value="">请选择</option>
${cats.map((c) => `<option value="${esc(c.id)}"${c.id === pickedCat ? " selected" : ""}>${esc(c.zh)}</option>`).join("")}
</select></p>
<p class="muted">${aiCat ? `${ai.source === "rule" ? "按栏目名自动选好" : "AI 建议"}：${esc(aiCat.zh)}${ai.reason ? `（${esc(ai.reason)}）` : ""}。不对的话请改。` : "请选择这篇文章的分类。"}</p>` : ""}
<p><label for="pw"><strong>团队密码</strong></label></p>
<p><input type="password" id="pw" name="password" autocomplete="current-password" required></p>
<p><button type="submit">发布到官网</button></p>
<p class="muted">提交后不能撤回；需要从网站上删掉的话，请联系网站管理员。</p>
</form>`;
  return layout("同步到官网", body);
}

function statusPage(id) {
  const nonce = randomBytes(16).toString("base64");
  const body = `
<h1>同步到官网</h1>
<div class="card" aria-live="polite">
<p class="state" id="state">正在查询……</p>
<p id="detail"></p>
<p class="muted" id="title"></p>
</div>
<p class="muted">这个页面会自动更新，可以留着不关。编号：${esc(id)}</p>`;
  const script = `
var url = "/status/${id}/data", started = Date.now(), timer;
var text = {
  queued: ["已提交，排队中", "马上开始处理。"],
  running: ["正在处理", "正在下载图片、生成网页，通常需要 1 到 3 分钟。"],
  waiting: ["已收到", "自动发布还没有开通，网站管理员会手动处理这篇文章。"],
  published: ["已发布", ""],
  failed: ["没有成功", ""],
  unknown: ["正在查询……", ""]
};
function set(id, value) { document.getElementById(id).textContent = value; }
function show(s) {
  var t = text[s.state] || text.unknown, el = document.getElementById("state");
  el.textContent = t[0];
  el.className = "state" + (s.state === "published" ? " ok" : s.state === "failed" ? " bad" : "");
  var d = document.getElementById("detail");
  d.textContent = t[1];
  if (s.title) set("title", s.title);
  if (s.state === "published" && s.dryRun) {
    el.textContent = "试运行成功";
    d.textContent = "管理员的试运行：文章能正常导入，但没有发布到网站。";
  } else if (s.state === "published" && s.url) {
    d.textContent = (s.replaced ? "网站上的旧版本已被替换。" : "") + "网站更新大约需要 2 分钟，之后可以在这里看到：";
    var a = document.createElement("a"); a.href = s.url; a.textContent = s.url; a.target = "_blank"; a.rel = "noopener";
    d.appendChild(a);
    if (s.imagesFailed) d.appendChild(document.createTextNode("（有 " + s.imagesFailed + " 张图片没有下载下来，网站上暂时直接显示公众号的图片。）"));
  }
  if (s.state === "failed") {
    d.textContent = (s.message ? s.message + "。" : "") + "可以稍后回到文章页面重新点书签；如果还是不行，请把这个页面的网址发给网站管理员。";
  }
  return s.state === "published" || s.state === "failed" || s.state === "waiting";
}
function poll() {
  fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
    if (!show(s) && Date.now() - started < 20 * 60 * 1000) timer = setTimeout(poll, 4000);
  }).catch(function () { timer = setTimeout(poll, 8000); });
}
poll();`;
  return [layout("同步到官网", body, nonce, script), nonce];
}
