// Suggests a category (and a card excerpt) for every story, with the model in aws/src/classify.mjs.
// Usage (admin, AWS SSO profile awdpi):
//   AWS_PROFILE=awdpi node classify-all.mjs <repo root> <results.json> [--write] [--redo]
// Results are saved after every article, so an interrupted run continues where it stopped.
//   --write  puts `category:` into each article's front matter, and `description:` (the excerpt) where there is none.
//            An article that already has a category keeps it unless --redo is given.
//   --redo   asks the model again for articles that are already in the results file.
//   --excerpts asks again only for articles without an excerpt, and keeps their category.
import fs from "node:fs";
import path from "node:path";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { classify } from "./aws/src/classify.mjs";

const [repoArg, resultsPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const write = process.argv.includes("--write");
const redo = process.argv.includes("--redo");
const excerpts = process.argv.includes("--excerpts");
if (!repoArg || !resultsPath) {
  console.error("Usage: node classify-all.mjs <repo root> <results.json> [--write] [--redo]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const { categories, rules = [] } = JSON.parse(fs.readFileSync(path.join(repo, "data/story_categories.json"), "utf8"));
const bedrock = new BedrockRuntimeClient({ region: "eu-north-1", maxAttempts: 4 });
// USD per million tokens for deepseek.v3.2 in eu-north-1 (same figures as the Avoice relay's cost gate).
const PRICE_IN = 0.74, PRICE_OUT = 2.22;

function stories() {
  const out = [];
  for (const dir of ["content/stories", "content/en/stories", "content/zh-cn/stories"]) {
    for (const name of fs.readdirSync(path.join(repo, dir)).sort()) {
      if (!/\.(html|md)$/.test(name) || name.startsWith("_index")) continue;
      const rel = `${dir}/${name}`;
      const text = fs.readFileSync(path.join(repo, rel), "utf8");
      const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
      if (!m || /^(build|layout):/m.test(m[1])) continue;
      out.push({ rel, front: m[1], body: text.slice(m[0].length) });
    }
  }
  return out;
}

const field = (front, key) => {
  const m = front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return "";
  const v = m[1].trim();
  try { return v.startsWith('"') ? JSON.parse(v) : v.replace(/^'(.*)'$/, "$1"); } catch { return v; }
};

function setField(front, key, value, after = "date") {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(front)) return front.replace(re, line);
  const anchor = new RegExp(`^${after}:.*$`, "m");
  return anchor.test(front) ? front.replace(anchor, (m) => `${m}\n${line}`) : `${front}\n${line}`;
}

const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) : {};
const all = stories();
const todo = all.filter((s) => redo || !results[s.rel] || (excerpts && !results[s.rel].excerpt));
console.error(`${all.length} stories, ${todo.length} to classify`);

let done = 0, failed = 0;
async function worker() {
  while (todo.length) {
    const s = todo.shift();
    try {
      const r = await classify(bedrock, categories, { title: field(s.front, "title"), html: s.body }, { rules });
      const before = results[s.rel];
      results[s.rel] = excerpts && before
        ? { ...before, excerpt: r.excerpt, inputTokens: before.inputTokens + r.inputTokens, outputTokens: before.outputTokens + r.outputTokens }
        : { ...r, title: field(s.front, "title"), date: field(s.front, "date"), at: new Date().toISOString() };
    } catch (e) {
      failed++;
      console.error(`  failed: ${s.rel} (${e.name})`);
    }
    if (++done % 20 === 0) {
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 1));
      console.error(`  ${done} done`);
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 1));

const rows = Object.values(results);
const tokIn = rows.reduce((n, r) => n + (r.inputTokens || 0), 0);
const tokOut = rows.reduce((n, r) => n + (r.outputTokens || 0), 0);
const counts = {};
for (const r of rows) counts[r.category || "none"] = (counts[r.category || "none"] || 0) + 1;
console.error(`classified ${rows.length}, failed now ${failed}; tokens in ${tokIn}, out ${tokOut}; about $${((tokIn * PRICE_IN + tokOut * PRICE_OUT) / 1e6).toFixed(3)}`);
console.error(JSON.stringify(counts));

if (write) {
  let changed = 0;
  for (const s of all) {
    const r = results[s.rel];
    if (!r || !r.category) continue;
    let front = s.front;
    if (redo || !field(front, "category")) front = setField(front, "category", r.category);
    if (r.excerpt && !field(front, "description")) front = setField(front, "description", JSON.stringify(r.excerpt), "category");
    if (front !== s.front) {
      fs.writeFileSync(path.join(repo, s.rel), `---\n${front}\n---\n${s.body}`);
      changed++;
    }
  }
  console.error(`wrote ${changed} files`);
}
