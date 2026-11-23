// Suggests a category and a short excerpt for an article, using a model on Amazon Bedrock (eu-north-1).
// Used by the internal form (index.mjs) for new articles and by classify-all.mjs for existing ones.
// The categories and their definitions come from data/story_categories.json in the website repository.
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export const MODEL_ID = "deepseek.v3.2";
const TEXT_CHARS = 1200;

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

export function plainText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|section|div|h\d|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
    .replace(/[ \t 　]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function prompt(categories, title, text) {
  const list = categories.map((c) => `- ${c.id}：${c.zh}——${c.define}`).join("\n");
  return `分类（id：名称——定义）：
${list}

规则：
- 只能选上面的一个 id。
- 标题里“｜”“丨”“|”前面的栏目名是重要线索，但以文章的主要内容为准。
- confidence：high 表示很确定；medium 表示有两个分类都说得通；low 表示看不出来。
- reason：一句话说明理由，不超过 30 个字。
- excerpt：从下面的正文里原样复制连续的一到两句话（30 到 100 个字），让读者看懂这篇文章讲什么。不要改写、不要拼接、不要加字；不要选“点击蓝字关注”“扫码”“编辑”“排版”之类的公众号套话。找不到合适的就写空字符串。

文章标题：${title}
正文开头：
${text}

只回复一个 JSON 对象：{"category": "", "confidence": "", "reason": "", "excerpt": ""}`;
}

const squash = (s) => String(s || "").replace(/\s+/g, "");

// Returns { category, confidence, reason, excerpt, inputTokens, outputTokens }; category is null when the reply was unusable.
export async function classify(bedrock, categories, { title, html, text }, { timeoutMs = 20000 } = {}) {
  const body = (text ?? plainText(html)).slice(0, TEXT_CHARS);
  const out = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: "你帮 AWDPI（亚裔女性国际发展计划，一个支持海外亚裔女性的非营利组织）的网站给公众号文章分类。只回复一个 JSON 对象，不要其他文字。" }],
      messages: [{ role: "user", content: [{ text: prompt(categories, title, body) }] }],
      inferenceConfig: { maxTokens: 400, temperature: 0 },
    }),
    { abortSignal: AbortSignal.timeout(timeoutMs) },
  );
  const reply = (out.output?.message?.content || []).map((c) => c.text || "").join("");
  const usage = { inputTokens: out.usage?.inputTokens || 0, outputTokens: out.usage?.outputTokens || 0 };
  let data = {};
  try {
    data = JSON.parse((reply.match(/\{[\s\S]*\}/) || ["{}"])[0]);
  } catch {
    return { category: null, confidence: "low", reason: "模型回复无法解析", excerpt: "", ...usage };
  }
  const ids = new Set(categories.map((c) => c.id));
  const category = ids.has(data.category) ? data.category : null;
  const confidence = ["high", "medium", "low"].includes(data.confidence) ? data.confidence : "low";
  // Only keep an excerpt that really is in the article, so nothing the model wrote itself appears on the site.
  // The model sometimes ends the excerpt with a full stop where the article goes on: compare without the final
  // punctuation and end the excerpt the way the article does (or with an ellipsis).
  let excerpt = "";
  const core = String(data.excerpt || "").replace(/\s+/g, " ").trim().replace(/[。，、；：,.;:!！?？…\s]+$/u, "");
  if (core.length >= 15 && core.length <= 200) {
    const flat = squash(plainText(html ?? text));
    const at = flat.indexOf(squash(core));
    if (at >= 0) {
      const next = flat[at + squash(core).length] || "";
      excerpt = core + (/[。！？!?]/.test(next) ? next : "…");
    }
  }
  return { category, confidence: category ? confidence : "low", reason: String(data.reason || "").slice(0, 80), excerpt, ...usage };
}
