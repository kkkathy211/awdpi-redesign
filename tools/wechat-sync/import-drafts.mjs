// Imports many articles at once: the drafts the bookmark leaves in S3 when nobody submits the confirm form.
// For catching up on a backlog: an editor opens each article and clicks the bookmark, then an admin runs this.
// Usage (admin, AWS SSO profile awdpi, in tools/wechat-sync after `npm ci`):
//   aws s3 sync s3://awdpi-wechat-sync-<account>/drafts/ <drafts dir> --profile awdpi
//   node import-drafts.mjs <repo root> <drafts dir> <report.json> [--dry-run]
// Each article is imported with import.mjs, exactly as the workflow would, with the category the form suggested
// (column rule or AI) and the date the article was published. Not imported, and listed in the report:
// - articles already on the site (same WeChat id or same name),
// - articles that look like reprints from another account (they need the editors to confirm permission),
// - drafts the form rejected (another account's article).
// The imported articles are then translated into English (translate.mjs). Afterwards build the site, look at the
// report, and commit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { plainText } from "./aws/src/classify.mjs";

const [repoArg, draftsDir, reportPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dry = process.argv.includes("--dry-run");
if (!repoArg || !draftsDir || !reportPath) {
  console.error("Usage: node import-drafts.mjs <repo root> <drafts dir> <report.json> [--dry-run]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const here = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_BIZ = process.env.ALLOWED_BIZ || "Mzg3MjY5ODAyNA==";
const SITE_URL = process.env.SITE_URL || "https://kkkathy211.github.io/awdpi-redesign/";
const storiesDir = path.join(repo, "content", "stories");

// What is on the site already.
const onSite = new Map(); // wechat id or slug -> file
for (const name of fs.readdirSync(storiesDir)) {
  const text = fs.readFileSync(path.join(storiesDir, name), "utf8").slice(0, 3000);
  onSite.set(name.replace(/\.(html|md)$/, ""), name);
  const m = text.match(/^wechat_id:\s*"([^"]+)"/m);
  if (m) onSite.set(m[1], name);
}

// One draft per article: the newest.
const drafts = new Map();
for (const name of fs.readdirSync(draftsDir).filter((n) => n.endsWith(".json"))) {
  const d = JSON.parse(fs.readFileSync(path.join(draftsDir, name), "utf8"));
  const a = d.article || {};
  const key = [a.biz, a.mid, a.idx].join("-");
  const before = drafts.get(key);
  if (!before || String(d.createdAt) > String(before.createdAt)) drafts.set(key, d);
}

// Signs that the article was taken from another account. The bookmark reads WeChat's "以下文章来源于" card;
// the text phrases catch manual reprints. 编译 and 翻译 are our own columns, image credits ("图片来源") are not reprints.
const REPRINT = /转载自|转自[^\s，。]{1,20}(公众号|微信)|经授权转载|授权转载|本文来源于|文章来源[:：]/;

const report = { imported: [], held: [], skipped: [], failed: [] };
const list = [...drafts.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
for (const d of list) {
  const a = d.article;
  const entry = { date: d.date, title: a.title, slug: d.slug, url: a.link || a.url };
  const wechatId = `${a.biz}-${a.mid}-${a.idx}`;
  if (a.biz !== ALLOWED_BIZ) { report.skipped.push({ ...entry, why: "不是 AWDPI 公众号发的" }); continue; }
  if (onSite.has(wechatId) || onSite.has(d.slug)) { report.skipped.push({ ...entry, why: `已在网站上（${onSite.get(wechatId) || onSite.get(d.slug)}）` }); continue; }
  const text = plainText(a.html);
  const sign = (/来源于|转载/.test(a.shareSource || "") && a.shareSource) || (text.match(REPRINT) || [])[0];
  if (sign) { report.held.push({ ...entry, why: `可能是转载：${String(sign).slice(0, 60)}` }); continue; }
  const category = d.suggestion?.category || "";
  const submission = {
    id: randomUUID(), slug: d.slug, date: d.date, url: d.url, origin: "original", authorised: false,
    category, description: d.description || "", submittedAt: new Date().toISOString(), article: a,
  };
  if (dry) { report.imported.push({ ...entry, category, dryRun: true }); continue; }
  const subFile = path.join(path.dirname(path.resolve(reportPath)), `.sub-${submission.id}.json`);
  const resFile = `${subFile}.result`;
  fs.writeFileSync(subFile, JSON.stringify(submission));
  const run = spawnSync(process.execPath, [path.join(here, "import.mjs"), subFile, repo, resFile], {
    env: { ...process.env, ALLOWED_BIZ, SITE_URL }, encoding: "utf8", maxBuffer: 1 << 26,
  });
  const result = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, "utf8")) : { ok: false, message: run.stderr.slice(-300) };
  fs.rmSync(subFile, { force: true });
  fs.rmSync(resFile, { force: true });
  if (result.ok) {
    report.imported.push({ ...entry, slug: result.slug, category: result.category, images: result.images, imagesFailed: result.imagesFailed, newImageBytes: result.newImageBytes });
    onSite.set(wechatId, result.slug);
  } else {
    report.failed.push({ ...entry, why: result.message });
  }
  console.error(`${result.ok ? "ok  " : "FAIL"} ${d.date} ${a.title.slice(0, 40)}`);
}

// English versions of the imported articles (needs the awdpi AWS profile or other credentials for Bedrock).
if (!dry && report.imported.length) {
  const slugs = report.imported.map((x) => x.slug).join(",");
  const t = spawnSync(process.execPath, [path.join(here, "translate.mjs"), repo, "--slugs", slugs, "--redo", "--concurrency", "8"], { stdio: "inherit" });
  report.translated = t.status === 0;
}

// Same title on two different days: probably sent twice; say so in the report.
const byTitle = new Map();
for (const x of report.imported) byTitle.set(x.title, [...(byTitle.get(x.title) || []), x.slug]);
report.sameTitle = [...byTitle].filter(([, v]) => v.length > 1).map(([title, slugs]) => ({ title, slugs }));
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.error(`imported ${report.imported.length}, held ${report.held.length}, skipped ${report.skipped.length}, failed ${report.failed.length}`);
