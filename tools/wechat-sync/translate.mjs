// English versions of the Chinese stories, made with a model on Amazon Bedrock (eu-north-1).
// Usage (admin with the awdpi AWS profile, or the wechat-import workflow):
//   node translate.mjs <repo root> [--slugs a,b,c] [--redo] [--concurrency 8] [--limit N]
// For each story in content/stories/ it writes content/stories-en/<same file name>: the same front matter with an
// English title and description plus `translated: true`, and the same HTML with every piece of Chinese text
// translated in place, so the layout, images and links stay as they are. hugo.toml mounts content/stories-en first
// for English, so a translation replaces the Chinese original on the English site only.
// Stories that already have a translation are skipped unless --redo; stories with almost no Chinese are skipped.
//
// How the text is translated:
// - only text containing Chinese characters goes to the model; everything else (numbers, emoji, English) stays,
//   and Chinese punctuation in it becomes English punctuation;
// - the pieces are numbered and sent in order, a few thousand characters at a time, so the model sees the context;
// - checks: every number must come back, and a piece must not come back still in Chinese. Failed pieces are sent
//   once more to Qwen, then to DeepSeek; a piece that still fails keeps its Chinese text and is counted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export const MODEL = "qwen.qwen3-235b-a22b-2507-v1:0";
export const FALLBACK = "deepseek.v3.2";
const PRICES = { [MODEL]: [0.22, 0.88], [FALLBACK]: [0.74, 2.22] }; // USD per million tokens, eu-north-1
const CHUNK_HAN = 2500, CHUNK_SEGMENTS = 120;
const HAN = /\p{Script=Han}/u;
const HAN_G = /\p{Script=Han}/gu;

const SYSTEM = (glossary) => `You are a professional Chinese-to-English translator for the website of AWDPI (Asian Women Development Plan International), a non-profit that supports Asian women living overseas.
Rules:
1. Translate faithfully and completely: every sentence, name, number, date, link and emoji. Never summarise, never add information, never explain, never write anything that is not in the source.
2. Culture-specific or historical terms (roles, organisations, customs, idioms): use the established English term if one exists. If none exists, write it in pinyin and add a short English gloss in parentheses the first time it appears.
3. Chinese personal names: write them in pinyin (or the person's known English name).
6. Never leave Chinese characters in the translation, except inside web addresses.
4. Write natural English for an international audience; keep the tone of the original.
5. Output only what is asked for, with no preamble.
Glossary (always use):
${glossary.map(([zh, en]) => `${zh} = ${en}`).join("\n")}`;

const STRICT = "Your previous answer left Chinese characters in some segments. Translate every Chinese word into English (names in pinyin). Apart from web addresses, the reply must not contain any Chinese characters.";
const INSTRUCTION = `The numbered segments below are consecutive pieces of one article, in order. A sentence may be split across several segments: translate each segment so that the segments read naturally one after another, and keep each segment's meaning in its own number. Reply with every number, one segment per line, as ⟦n⟧ translation. Do not merge, split, skip or renumber segments.`;

const PUNCT = { "｜": " | ", "丨": " | ", "，": ", ", "。": ". ", "：": ": ", "；": "; ", "！": "! ", "？": "? ", "、": ", ", "（": " (", "）": ") ", "“": "\"", "”": "\"", "‘": "'", "’": "'", "《": "\"", "》": "\"", "【": "[", "】": "]", "…": "…", "—": "—", "　": " " };
const englishPunct = (s) => s.replace(/[｜丨，。：；！？、（）“”‘’《》【】　]/g, (c) => PUNCT[c]);
// Chinese punctuation the model sometimes keeps inside English text
const tidy = (s) => englishPunct(s).replace(/ {2,}/g, " ").replace(/ +([,.;:!?)])/g, "$1").trim();

// Chinese left outside web addresses ("丨" is a separator, not a word)
const chineseLeft = (out) => (String(out || "").replace(/https?:\/\/\S+/g, "").replace(/丨/g, "").match(HAN_G) || []).length;
function stillChinese(src, out) {
  return !out || !out.trim() || chineseLeft(out) > 0;
}

export function makeTranslator({ region = "eu-north-1", glossary = [] } = {}) {
  const bedrock = new BedrockRuntimeClient({ region, maxAttempts: 4 });
  const usage = { [MODEL]: [0, 0], [FALLBACK]: [0, 0] };
  const system = SYSTEM(glossary);

  async function ask(model, text, maxTokens) {
    const out = await bedrock.send(new ConverseCommand({
      modelId: model, system: [{ text: system }],
      messages: [{ role: "user", content: [{ text }] }],
      inferenceConfig: { maxTokens, temperature: 0 },
    }), { abortSignal: AbortSignal.timeout(180000) });
    usage[model][0] += out.usage?.inputTokens || 0;
    usage[model][1] += out.usage?.outputTokens || 0;
    return (out.output?.message?.content || []).map((c) => c.text || "").join("").replace(/<think>[\s\S]*?<\/think>/g, "");
  }

  // pieces: [{ id, text }] -> Map id -> English
  async function numbered(model, pieces, strict = false) {
    const han = pieces.reduce((n, p) => n + (p.text.match(HAN_G) || []).length, 0);
    const reply = await ask(model, `${INSTRUCTION}${strict ? `\n${STRICT}` : ""}\n\n${pieces.map((p) => `⟦${p.id}⟧ ${p.text}`).join("\n")}`, Math.min(16000, 800 + han * 4));
    const got = new Map();
    let current = null;
    for (const line of reply.split("\n")) {
      const m = line.match(/^\s*⟦(\d+)⟧\s?(.*)$/);
      if (m) { current = +m[1]; got.set(current, m[2]); }
      else if (current !== null && line.trim()) got.set(current, `${got.get(current)} ${line.trim()}`);
    }
    return got;
  }

  // Translates pieces with the checks and retries described above. Returns Map id -> English (or original).
  async function translatePieces(pieces) {
    const result = new Map();
    const chunks = [];
    let chunk = [], han = 0;
    for (const p of pieces) {
      const h = (p.text.match(HAN_G) || []).length;
      if (chunk.length && (han + h > CHUNK_HAN || chunk.length >= CHUNK_SEGMENTS)) { chunks.push(chunk); chunk = []; han = 0; }
      chunk.push(p); han += h;
    }
    if (chunk.length) chunks.push(chunk);
    let failed = 0;
    for (const c of chunks) {
      let todo = c;
      const best = new Map(); // id -> the attempt with the least Chinese left
      for (const [model, label] of [[MODEL, "first"], [MODEL, "retry"], [FALLBACK, "fallback"]]) {
        if (!todo.length) break;
        let got;
        try {
          got = await numbered(model, todo, label !== "first");
        } catch (e) {
          got = new Map();
          if (label === "fallback") console.error(`  model error ${e.name}`);
        }
        const next = [];
        for (const p of todo) {
          const t = tidy(got.get(p.id) || "");
          if (t && (!best.has(p.id) || chineseLeft(t) < chineseLeft(best.get(p.id)))) best.set(p.id, t);
          if (stillChinese(p.text, t)) next.push(p);
          else result.set(p.id, t);
        }
        todo = next;
      }
      // still some Chinese after three tries: keep the best attempt; the original only if there is none
      for (const p of todo) {
        if (best.has(p.id) && chineseLeft(best.get(p.id)) < (p.text.match(HAN_G) || []).length) result.set(p.id, best.get(p.id));
        else { result.set(p.id, p.text); failed++; }
      }
    }
    return { result, failed };
  }

  function cost() {
    return Object.entries(usage).reduce((s, [m, [i, o]]) => s + (i * PRICES[m][0] + o * PRICES[m][1]) / 1e6, 0);
  }
  return { translatePieces, usage, cost };
}

const BLOCK = new Set(["p", "div", "section", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "tr", "table", "blockquote", "figure", "figcaption", "header", "footer", "article"]);

// Translates one story file's text. Returns { front, body, failed, pieces } or null when there is nothing to translate.
export async function translateStory(translator, source) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const front = m[1], body = source.slice(m[0].length);
  const $ = cheerio.load(`<div id="awdpi-root">${body}</div>`, null, false);
  const root = $("#awdpi-root")[0];

  // text nodes in document order, with the block they belong to
  const nodes = [];
  (function walk(el, block) {
    for (const c of el.children || []) {
      if (c.type === "text") nodes.push({ node: c, block });
      else if (c.type === "tag" && !["script", "style"].includes(c.name)) walk(c, BLOCK.has(c.name) ? c : block);
      if (c.type === "tag" && c.name === "br") nodes.push({ br: true, block });
    }
  })(root, root);

  const pieces = [];
  const lines = []; // per text node: array of { text, id? }
  for (const n of nodes) {
    if (n.br) continue;
    n.lines = n.node.data.split("\n").map((line) => {
      const core = line.trim();
      if (!HAN.test(core)) return { raw: englishPunct(line) };
      const id = pieces.length + 1;
      pieces.push({ id, text: core });
      return { raw: line, lead: line.match(/^\s*/)[0], trail: line.match(/\s*$/)[0], id };
    });
  }
  const titleLine = front.match(/^title:\s*(.*)$/m);
  const descLine = front.match(/^description:\s*(.*)$/m);
  const unq = (v) => { v = v.trim(); try { return v.startsWith('"') ? JSON.parse(v) : v; } catch { return v; } };
  const title = titleLine ? unq(titleLine[1]) : "";
  const desc = descLine ? unq(descLine[1]) : "";
  const hanCount = (body.match(HAN_G) || []).length;
  if (hanCount < 20 && !HAN.test(title)) return null;

  const meta = [];
  if (HAN.test(title)) meta.push({ id: 1, text: title });
  if (HAN.test(desc)) meta.push({ id: 2, text: desc });
  const [{ result: metaOut, failed: metaFailed }, { result, failed }] = await Promise.all([
    translator.translatePieces(meta), translator.translatePieces(pieces),
  ]);

  // put the English back, then add a space between inline pieces of the same block where English needs one
  const flat = [];
  for (const n of nodes) {
    if (n.br) { flat.push({ br: true }); continue; }
    n.node.data = n.lines.map((l) => (l.id ? `${l.lead}${result.get(l.id)}${l.trail}` : l.raw)).join("\n");
    flat.push(n);
  }
  for (let i = 0; i < flat.length - 1; i++) {
    const a = flat[i], b = flat[i + 1];
    if (a.br || b.br || a.block !== b.block) continue;
    if (/[A-Za-z0-9.,;:!?)"'’]$/.test(a.node.data) && /^[A-Za-z0-9("'‘]/.test(b.node.data)) a.node.data += " ";
  }

  const yaml = (s) => JSON.stringify(String(s).replace(/\s+/g, " ").trim());
  let newFront = front;
  if (metaOut.get(1)) newFront = newFront.replace(/^title:.*$/m, `title: ${yaml(metaOut.get(1))}`);
  if (metaOut.get(2)) newFront = newFront.replace(/^description:.*$/m, `description: ${yaml(metaOut.get(2))}`);
  newFront = newFront.replace(/^translated:.*\n?/m, "") + "\ntranslated: true";
  return { front: newFront, body: $("#awdpi-root").html(), failed: failed + metaFailed, pieces: pieces.length };
}

export function loadGlossary(repo) {
  const file = path.join(repo, "data", "translation_glossary.json");
  if (!fs.existsSync(file)) return [];
  return Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).terms || {});
}

// ---------- command line ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const repo = path.resolve(args.find((a) => !a.startsWith("--")) || ".");
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const redo = args.includes("--redo");
  const slugs = opt("--slugs") ? new Set(opt("--slugs").split(",").filter(Boolean)) : null;
  const concurrency = +(opt("--concurrency") || 6);
  const limit = +(opt("--limit") || Infinity);
  const srcDir = path.join(repo, "content", "stories"), outDir = path.join(repo, "content", "stories-en");
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(srcDir).filter((f) => /\.(html|md)$/.test(f))
    .filter((f) => !slugs || slugs.has(f.replace(/\.(html|md)$/, "")))
    .filter((f) => redo || !fs.existsSync(path.join(outDir, f)))
    .sort().reverse().slice(0, limit);
  console.error(`${files.length} stories to translate`);
  const translator = makeTranslator({ glossary: loadGlossary(repo) });
  let done = 0, skipped = 0, failedPieces = 0, errors = 0;
  const queue = [...files];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const r = await translateStory(translator, fs.readFileSync(path.join(srcDir, f), "utf8"));
        if (!r) { skipped++; continue; }
        fs.writeFileSync(path.join(outDir, f), `---\n${r.front}\n---\n${r.body}\n`);
        failedPieces += r.failed;
        done++;
        console.error(`ok ${f} (${r.pieces} pieces${r.failed ? `, ${r.failed} left in Chinese` : ""}) ${done}/${files.length} $${translator.cost().toFixed(3)}`);
      } catch (e) {
        errors++;
        console.error(`FAIL ${f}: ${e.name} ${e.message.slice(0, 200)}`);
      }
    }
  }));
  console.error(`translated ${done}, skipped ${skipped}, errors ${errors}, pieces left in Chinese ${failedPieces}, cost about $${translator.cost().toFixed(3)}`);
  console.error(JSON.stringify(translator.usage));
  if (errors) process.exitCode = 1;
}
