// Internal form for syncing WeChat articles to the website.
//   GET  /                     install page with the bookmark and instructions
//   POST /capture              the bookmark posts the open article here; keeps it as a draft, shows the confirm form
//   POST /submit               team password + original/reprint choice + category; queues the import and starts the workflow
//   GET  /status/<id>          progress page
//   GET  /status/<id>/data     progress as JSON (written by the GitHub workflow)
//   GET  /session              whether this computer is remembered (the form then hides the password field)
//   GET  /forget               forget this computer
// The confirm form suggests a category with a model on Bedrock (classify.mjs); the categories are read from
// data/story_categories.json in the website repository. Article text is never logged. Drafts expire after 2 days, submissions and progress after 90 (bucket lifecycle).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
// Copies of static/img/awdpi-logo-zh.png and awdpi-favicon.png, inlined because the pages load nothing from elsewhere.
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(new URL(file, import.meta.url)).toString("base64")}`;
const LOGO = dataUri("./awdpi-logo.png");
const FAVICON = dataUri("./awdpi-favicon.png");

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

// ---------- remembered computers ----------
// After the team password is entered once with "记住这台电脑", the browser keeps a signed cookie for a year and the
// form no longer asks for the password on that computer. The signature is keyed on the current password, so changing
// the password forgets every computer. SameSite=Lax: another website cannot make the browser submit with the cookie.
const REMEMBER_COOKIE = "awdpi_sync";
const REMEMBER_DAYS = 365;
async function rememberKey() {
  const pw = await param(PASSWORD_PARAM);
  return pw ? createHash("sha256").update(`awdpi-sync-remember:${pw}`).digest() : null;
}
async function rememberCookie() {
  const exp = Math.floor(Date.now() / 1000) + REMEMBER_DAYS * 86400;
  const sig = createHmac("sha256", await rememberKey()).update(String(exp)).digest("base64url");
  return `${REMEMBER_COOKIE}=${exp}.${sig}; Max-Age=${REMEMBER_DAYS * 86400}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
const FORGET_COOKIE = `${REMEMBER_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
function cookie(event, name) {
  const all = [...(event.cookies || []), ...String(event.headers?.cookie || "").split(";")];
  for (const c of all) {
    const i = c.indexOf("=");
    if (i > 0 && c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return "";
}
async function remembered(event) {
  const m = cookie(event, REMEMBER_COOKIE).match(/^(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  const key = await rememberKey();
  if (!key) return false;
  const expected = createHmac("sha256", key).update(m[1]).digest();
  const given = Buffer.from(m[2], "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
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
    if (method === "GET" && path === "/") return html(200, ...installPage(endpoint, event.headers?.["user-agent"] || ""));
    if (method === "POST" && path === "/capture") return await capture(event);
    if (method === "POST" && path === "/submit") return await submit(event);
    if (method === "GET" && path === "/session") return json(200, { remembered: await remembered(event) });
    if (method === "GET" && path === "/forget") {
      return { ...html(200, message("已经忘记这台电脑", "下次在这台电脑上同步文章时，需要重新输入团队密码。")), cookies: [FORGET_COOKIE] };
    }
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
  return html(200, ...formPage({ id, article, d: { ...derived, suggestion, description }, already, cats }));
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
  const known = await remembered(event);
  const remember = form.get("remember") === "yes";
  if (!known && !(await checkPassword(form.get("password") || ""))) errors.push("团队密码不对。");
  if (errors.length) {
    log("submit_rejected", { id, count: errors.length });
    return html(400, ...formPage({ id, article: draft.article, d: draft, already: null, errors, origin, authorised, category, cats, remember }));
  }
  const now = new Date().toISOString();
  await put(`inbox/${id}.json`, {
    id, slug: draft.slug, date: draft.date, url: draft.url, origin, authorised, category, description: draft.description || "",
    submittedAt: now, article: draft.article,
  });
  const started = await dispatch(id);
  await put(`status/${id}.json`, { state: started ? "queued" : "waiting", title: draft.article.title, url: draft.url, at: now });
  log("submitted", { id, slug: draft.slug, category, aiCategory: draft.suggestion?.category || null, started, remembered: known });
  const done = { statusCode: 303, headers: { Location: `/status/${id}` }, body: "" };
  if (!known && remember) done.cookies = [await rememberCookie()];
  return done;
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

// Colours follow the website (static/css/style.css, AWDPI brand guideline): cream page, coral buttons with dark text.
const CSS = `
:root{color-scheme:light dark;--bg:#fbf7f1;--card:#fff;--sunk:#f5eee4;--ink:#26180e;--muted:#6e5d50;--line:#ecdfd0;--coral:#ff6e4f;--coral-h:#ff8466;--accent:#c4401c;--tint:#ffebe5;--ok:#2f7d4f;--warn:#8a4b00;--warn-bg:#fff2e3;--err:#bf210a;--err-bg:#ffe4df;--shadow:0 1px 2px rgba(70,35,10,.05),0 10px 30px rgba(70,35,10,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#1b1511;--card:#261e18;--sunk:#201913;--ink:#f7ede3;--muted:#c3b2a3;--line:#3b2f26;--accent:#ff9277;--tint:#3a221a;--ok:#6cc495;--warn:#f0b45c;--warn-bg:#3a2e1c;--err:#ff8f80;--err-bg:#3d2224;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.25)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:16px 16px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0 16px;border-bottom:1px solid var(--line)}.logo{height:52px;width:auto;display:block}
.tag{font-size:13px;color:var(--muted);background:var(--sunk);border:1px solid var(--line);border-radius:999px;padding:3px 12px;white-space:nowrap}
h1{font-size:28px;line-height:1.3;margin:28px 0 6px}h2{font-size:20px;line-height:1.35;margin:32px 0 10px}h3{font-size:17px;line-height:1.45;margin:0 0 4px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:22px;margin:18px 0}
.cover{width:100%;aspect-ratio:2.35/1;object-fit:cover;border-radius:14px;background:var(--line);display:block;margin-bottom:14px}
.title{font-size:20px;font-weight:600;line-height:1.4;margin:0 0 8px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:15px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.note{border-radius:14px;padding:12px 16px;margin:14px 0;font-size:15px}.warn{background:var(--warn-bg);color:var(--warn)}.note.ok{background:var(--sunk);border:1px solid var(--line);color:var(--ok)}.err{background:var(--err-bg);color:var(--err)}
fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:600;margin-bottom:8px}label.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:14px;margin-bottom:8px;cursor:pointer}
label.opt input{margin-top:6px;accent-color:var(--coral)}select,input[type=password]{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink)}
button,.btn{display:inline-block;font:inherit;font-weight:700;padding:11px 24px;border-radius:999px;border:0;background:var(--coral);color:#26180e;cursor:pointer;text-decoration:none;box-shadow:0 6px 18px rgba(255,110,79,.28)}
button:hover,.btn:hover{background:var(--coral-h)}button.btn2{background:transparent;color:var(--ink);border:1.5px solid var(--ink);box-shadow:none;padding:8px 18px;font-size:15px}button.btn2:hover{background:var(--ink);color:var(--bg)}
ol,ul{padding-left:22px;margin:0 0 12px}li{margin-bottom:6px}textarea{width:100%;height:76px;font:12px/1.4 ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:12px;padding:8px;background:var(--bg);color:var(--ink);resize:vertical}
.state{font-size:20px;font-weight:600;margin:0 0 8px}.state.ok{color:var(--ok)}.state.bad{color:var(--err)}
kbd{display:inline-block;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-width:24px;text-align:center;background:var(--card);border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;padding:0 6px;color:var(--ink)}
.lead{font-size:17px;color:var(--muted);max-width:36em}
.sec{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:24px;margin:22px 0}.sec h2{margin:0}
.sec-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-bottom:22px}.badge{font-size:13px;font-weight:700;color:var(--accent);background:var(--tint);border-radius:999px;padding:2px 11px}.when{font-size:14px;color:var(--muted);margin-left:auto}
.steps{list-style:none;padding:0;margin:0;counter-reset:s}.steps>li{position:relative;padding:0 0 24px 50px;margin:0;counter-increment:s}.steps>li:last-child{padding-bottom:0}
.steps>li::before{content:counter(s);position:absolute;left:0;top:-2px;width:32px;height:32px;border-radius:50%;background:var(--tint);color:var(--accent);font-weight:700;font-size:15px;display:grid;place-items:center;transition:background .3s,color .3s}
.steps>li:not(:last-child)::after{content:"";position:absolute;left:16px;top:38px;bottom:8px;width:1px;background:var(--line)}
.steps p{margin:0 0 6px}.steps>li.next::before{background:var(--coral);color:#26180e;animation:pop .5s}@keyframes pop{50%{transform:scale(1.25)}}
.seen{display:inline-block;font-size:13px;color:var(--muted);background:var(--sunk);border-radius:999px;padding:1px 10px;margin-bottom:6px}
.dragarea{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0 10px}@media (max-width:640px){.dragarea{grid-template-columns:1fr}}
.zone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:190px;padding:18px;border:2px dashed var(--line);border-radius:16px;background:var(--sunk);text-align:center}
.hint{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600;color:var(--accent)}.hint svg{width:16px;height:16px;animation:up 1.6s ease-in-out infinite}@keyframes up{0%,100%{transform:translateY(2px)}50%{transform:translateY(-4px)}}
a.bm{display:inline-flex;align-items:center;gap:10px;font-size:18px;font-weight:700;padding:14px 28px 14px 20px;border-radius:999px;background:var(--coral);color:#26180e;text-decoration:none;cursor:grab;box-shadow:0 8px 22px rgba(255,110,79,.38)}
a.bm::before{content:"";width:10px;height:16px;background:radial-gradient(circle,rgba(38,24,14,.6) 1.5px,transparent 1.9px) 0 0/5px 5.33px}a.bm:hover{background:var(--coral-h)}a.bm:active{cursor:grabbing}
a.bm.shake{animation:shake .45s}@keyframes shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}.clickwarn{font-size:14px;color:var(--err);margin:0}
.demo{position:relative;min-height:190px;border:1px solid var(--line);border-radius:16px;background:var(--card);overflow:hidden}
.d-top{height:28px;display:flex;align-items:center;gap:5px;padding:0 10px;background:var(--sunk);border-bottom:1px solid var(--line)}.d-top i{width:8px;height:8px;border-radius:50%;background:var(--line)}.d-url{flex:1;height:14px;margin-left:8px;border-radius:7px;background:var(--card);border:1px solid var(--line)}
.d-bar{position:relative;height:28px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--line)}.d-bar i{flex:none;width:44px;height:10px;border-radius:5px;background:var(--line)}
.d-new{font-size:11px;font-weight:700;line-height:1;padding:4px 8px;border-radius:6px;background:var(--tint);color:var(--accent);white-space:nowrap;opacity:0;animation:d-new 5s infinite}
.d-caret{position:absolute;left:109px;top:5px;width:2px;height:18px;border-radius:1px;background:var(--coral);opacity:0;animation:d-caret 5s infinite}
.d-btn,.d-ghost{position:absolute;left:64%;top:112px;transform:translate(-50%,-50%);white-space:nowrap;font-weight:700}
.d-btn{font-size:12px;padding:7px 14px;border-radius:999px;background:var(--coral);color:#26180e;animation:d-btn 5s infinite}
.d-ghost{font-size:11px;padding:4px 9px;border-radius:6px;background:var(--card);border:1px solid var(--coral);color:var(--ink);box-shadow:var(--shadow);opacity:0;animation:d-ghost 5s infinite}
.d-cur{position:absolute;left:86%;top:170px;width:18px;height:22px;margin:-1px 0 0 -1px;opacity:0;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25));animation:d-cur 5s infinite}
.d-cap{position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:12px;color:var(--muted)}
@keyframes d-cur{0%{left:86%;top:170px;opacity:0}8%{opacity:1}20%,26%{left:64%;top:112px;scale:1}30%{scale:.85}60%{left:152px;top:42px;scale:.85}66%{scale:1}84%{left:152px;top:42px;opacity:1}92%,100%{left:152px;top:42px;opacity:0}}
@keyframes d-ghost{0%,28%{left:64%;top:112px;opacity:0}32%{opacity:.95}60%{left:152px;top:42px;opacity:.95}64%,100%{left:152px;top:42px;opacity:0}}
@keyframes d-btn{0%,28%{opacity:1}32%,62%{opacity:.45}70%,100%{opacity:1}}
@keyframes d-caret{0%,44%{opacity:0}48%,60%{opacity:1}63%,100%{opacity:0}}
@keyframes d-new{0%,61%{opacity:0;transform:scale(.6)}67%{opacity:1;transform:scale(1.1)}72%,88%{opacity:1;transform:scale(1)}96%,100%{opacity:0}}
.dropbar{position:fixed;left:50%;top:10px;z-index:10;display:flex;align-items:center;gap:8px;max-width:calc(100% - 32px);padding:10px 18px;border-radius:999px;background:var(--ink);color:var(--bg);font-weight:600;font-size:15px;box-shadow:0 10px 30px rgba(0,0,0,.25);transform:translate(-50%,-160%);opacity:0;visibility:hidden;transition:transform .25s,opacity .25s,visibility .25s;pointer-events:none}
.dropbar svg{flex:none;width:18px;height:18px}body.dragging .dropbar{transform:translate(-50%,0);opacity:1;visibility:visible}
details{border-top:1px solid var(--line);margin-top:18px;padding-top:14px}summary{display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:600;color:var(--accent);list-style:none}summary::-webkit-details-marker{display:none}
summary::before{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .2s}details[open] summary::before{transform:rotate(45deg)}details>div{padding-top:12px}
.foot{margin-top:28px;text-align:center}
@media (max-width:480px){h1{font-size:24px}.sec,.card{padding:18px}.logo{height:44px}.when{margin-left:0;width:100%}}
@media (prefers-reduced-motion:reduce){.demo *,.hint svg,a.bm.shake,.steps>li.next::before{animation:none!important}.d-new{opacity:1}.d-cur,.d-ghost,.d-caret{display:none}}
`;

function layout(title, body, nonce = "", script = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="icon" href="${FAVICON}"><style>${CSS}</style></head><body><main><header class="top"><img class="logo" src="${LOGO}" alt="AWDPI 亚裔女性国际发展计划"><span class="tag">公众号文章同步</span></header>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

function message(title, text) {
  return layout(title, `<h1>${esc(title)}</h1><div class="card"><p>${esc(text)}</p></div><p class="muted">AWDPI 官网 · 公众号文章同步</p>`);
}

// The install page only shows how to reach the bookmark bar in the browser it is opened in (from the User-Agent).
// Browsers built on Chrome under another name (QQ, 360, Sogou, Opera) get the general instructions.
function browserOf(ua) {
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
  const mac = !mobile && /Macintosh|Mac OS X/.test(ua);
  const win = !mobile && /Windows/.test(ua);
  const name = /QQBrowser|MetaSr|360SE|360EE|OPR\/|YaBrowser|UCBrowser/.test(ua) ? ""
    : /Edg\//.test(ua) ? "edge" : /Firefox\//.test(ua) ? "firefox" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "";
  return { mobile, mac, win, name };
}
const BROWSERS = { chrome: ["Chrome", "书签栏"], edge: ["Edge", "收藏夹栏"], safari: ["Safari", "个人收藏栏"], firefox: ["Firefox", "书签工具栏"] };
const keys = (...k) => k.map((x) => `<kbd>${x}</kbd>`).join(" + ");
const ARROW_UP = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14V2M3 7l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function installPage(endpoint, ua) {
  const code = `javascript:${encodeURIComponent(BOOKMARKLET.replace("__ENDPOINT__", endpoint))}`;
  const nonce = randomBytes(16).toString("base64");
  const b = browserOf(ua);
  const [label, bar] = BROWSERS[b.name] || ["", "书签栏"];
  const mod = b.mac ? "⌘" : "Ctrl";
  const seen = label && (b.mac || b.win) ? `${b.mac ? "Mac" : "Windows"} 上的 ${label}` : label;
  const showBar = b.name === "safari" ? `按 ${keys("⌘", "Shift", "B")}，或在屏幕顶部的菜单栏选“显示 → 显示个人收藏栏”。`
    : b.name ? `按 ${keys(mod, "Shift", "B")}，地址栏下面会出现一行${bar}。${b.name === "firefox" ? "（Firefox 没有测试过，建议改用 Chrome、Edge 或 Safari。）" : ""}`
    : `Chrome 和 Edge 按 ${keys(mod, "Shift", "B")}；Safari 按 ${keys("⌘", "Shift", "B")}。`;
  const body = `
<section>
<h1>公众号文章，一键同步到官网</h1>
<p class="lead">在浏览器里装一个书签。公众号发完文章后，在文章页上点一下这个书签，核对后就能发布到 AWDPI 官网，正文和图片会自动整理好。</p>
<p class="muted">AWDPI 内部工具，请不要转发这个网址。</p>
</section>
${b.mobile ? `<div class="note warn"><strong>请在电脑上打开这个页面。</strong>手机和平板上的浏览器装不了这个书签，也读不了公众号文章。</div>` : ""}
<section class="sec">
<div class="sec-head"><span class="badge">第一步</span><h2>安装书签</h2><span class="when">每台电脑一次，约 30 秒</span></div>
<ol class="steps">
<li>
<h3>显示${bar}</h3>
${seen ? `<p class="seen">你现在用的是 ${seen}</p>` : ""}
<p>${showBar}</p>
<p class="muted">地址栏下面已经有一行${bar}的，跳过这一步。</p>
</li>
<li>
<h3>把按钮拖到${bar}上</h3>
<p>按住下面的按钮不放，往上拖到${bar}上，再松开鼠标。</p>
<div class="dragarea">
<div class="zone">
<span class="hint">${ARROW_UP}按住，往上拖</span>
<a class="bm" id="bm" href="${esc(code)}">同步到官网</a>
<p class="clickwarn" id="clickwarn" hidden>要按住拖到${bar}上，在这里点它没有用。</p>
</div>
<div class="demo" aria-hidden="true">
<div class="d-top"><i></i><i></i><i></i><span class="d-url"></span></div>
<div class="d-bar"><i></i><i></i><span class="d-new">同步到官网</span><span class="d-caret"></span></div>
<span class="d-btn">同步到官网</span><span class="d-ghost">同步到官网</span>
<svg class="d-cur" viewBox="0 0 18 22"><path d="M1 1v16.5l4.4-4.1 2.9 6.5 2.8-1.2-2.9-6.4H14z" fill="#fff" stroke="#26180e" stroke-width="1.3" stroke-linejoin="round"/></svg>
<span class="d-cap">演示：拖到${bar}上</span>
</div>
</div>
<p class="muted">以前装过的：先在${bar}上右键旧的“同步到官网”，删掉，再拖新的。</p>
</li>
<li id="try">
<h3>点一下试试</h3>
<p>点${bar}上刚出现的“同步到官网”。弹出提示“请先在电脑浏览器里打开一篇公众号文章……”，就说明装好了。</p>
<p class="muted">没有反应的话：确认点的是${bar}上的书签，不是这个页面上的按钮；还是不行，换用 Chrome 或 Edge。</p>
</li>
</ol>
<details>
<summary>拖不动？手动添加书签</summary>
<div>
<ol>
<li>点下面的“复制书签网址”。</li>
<li>按 ${keys(mod, "D")} 把这个页面加为书签，位置选${b.name === "safari" ? "“个人收藏”" : `“${bar}”`}。</li>
<li>在${bar}上右键这个新书签，选“修改”或“编辑”（Safari 是“编辑地址”和“重新命名”），名称改成“同步到官网”，网址换成刚才复制的内容，保存。</li>
</ol>
<textarea readonly id="code" aria-label="书签网址">${esc(code)}</textarea>
<p><button type="button" class="btn2" id="copy">复制书签网址</button></p>
</div>
</details>
<details>
<summary>其他浏览器怎么显示书签栏</summary>
<div><dl>
<dt>Chrome</dt><dd>${keys("Ctrl", "Shift", "B")}，Mac 上 ${keys("⌘", "Shift", "B")}，叫“书签栏”</dd>
<dt>Edge</dt><dd>${keys("Ctrl", "Shift", "B")}，Mac 上 ${keys("⌘", "Shift", "B")}，叫“收藏夹栏”</dd>
<dt>Safari</dt><dd>${keys("⌘", "Shift", "B")}，或菜单栏“显示 → 显示个人收藏栏”</dd>
<dt>手机、平板</dt><dd>用不了，请用电脑</dd>
</dl></div>
</details>
</section>
<section class="sec">
<div class="sec-head"><span class="badge">第二步</span><h2>同步一篇文章</h2><span class="when">每次公众号发完文章后</span></div>
<ol class="steps">
<li><h3>在电脑浏览器里打开文章</h3><p>在电脑微信里打开这篇公众号文章，点右上角的“…”，选“在默认浏览器中打开”。也可以把文章链接复制到浏览器的地址栏。</p></li>
<li><h3>点${bar}上的“同步到官网”</h3><p>等文章完全显示出来再点。</p></li>
<li><h3>核对，然后发布</h3><p>在打开的页面上核对标题、日期、封面和分类，选“原创”或“转载”，点“发布到官网”。</p><p class="muted">每台电脑第一次发布时要输入团队密码；勾选“记住这台电脑”后，一年内不用再输。</p></li>
<li><h3>等页面显示“已发布”</h3><p>大约 2 分钟后，文章出现在网站上，英文网站上同时有 AI 翻译的英文版。</p></li>
</ol>
</section>
<section class="sec">
<h2>注意</h2>
<ul>
<li>只能同步 AWDPI 公众号自己发的文章。</li>
<li>转载或改编自别人的文章，要先取得原作者或原公众号的授权。</li>
<li>文章发出后改过的，再同步一次，网站上的那篇会被替换。</li>
<li>文章里的视频和音频不会同步，网站上会显示一个链接，指向公众号原文。</li>
<li>团队密码请不要发到群里或其他公开的地方；公用电脑上不要勾选“记住这台电脑”。</li>
</ul>
</section>
<p class="muted foot">AWDPI 官网 · 公众号文章同步 · 书签第 ${BOOKMARK_VERSION} 版</p>
<div class="dropbar" aria-hidden="true">${ARROW_UP}放到地址栏下面的${bar}上，再松开鼠标</div>`;
  // Clicking the button here does nothing useful (and the page's CSP blocks javascript: links), so say to drag it.
  const script = `var bm = document.getElementById("bm"), warn = document.getElementById("clickwarn");
bm.addEventListener("click", function (e) { e.preventDefault(); warn.hidden = false; bm.classList.remove("shake"); void bm.offsetWidth; bm.classList.add("shake"); });
bm.addEventListener("dragstart", function () { document.body.classList.add("dragging"); warn.hidden = true; });
bm.addEventListener("dragend", function () { document.body.classList.remove("dragging"); document.getElementById("try").classList.add("next"); });
document.getElementById("copy").addEventListener("click", function () {
  var t = document.getElementById("code"), btn = this;
  t.select();
  navigator.clipboard.writeText(t.value).then(function () { btn.textContent = "已复制"; }, function () { document.execCommand("copy"); btn.textContent = "已复制"; });
});`;
  return [layout("公众号文章同步到官网", body, nonce, script), nonce];
}

function formPage({ id, article: a, d, already, errors = [], origin, authorised, category, cats = [], remember = true }) {
  const nonce = randomBytes(16).toString("base64");
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
<div id="pwbox">
<p><label for="pw"><strong>团队密码</strong></label></p>
<p><input type="password" id="pw" name="password" autocomplete="current-password"></p>
<label class="opt"><input type="checkbox" name="remember" value="yes"${remember ? " checked" : ""}><span>记住这台电脑：一年内在这台电脑上不用再输密码。公用电脑请不要勾选。</span></label>
</div>
<p id="known" class="note ok" hidden>这台电脑已经记住，不用输入密码。<a href="/forget">不是你自己的电脑？点这里让它忘记</a></p>
<p><button type="submit">发布到官网</button></p>
<p class="muted">提交后不能撤回；需要从网站上删掉的话，请联系网站管理员。</p>
</form>`;
  // A remembered computer does not need the password (the cookie itself is not readable from the page).
  const script = `fetch("/session", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
  if (s.remembered) { document.getElementById("pwbox").hidden = true; document.getElementById("known").hidden = false; }
}).catch(function () {});`;
  return [layout("同步到官网", body, nonce, script), nonce];
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
