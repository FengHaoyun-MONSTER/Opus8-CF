/**
 * Opus8-CF · AI 服务解锁分流清单
 * ------------------------------------------------------------------
 * 命中这些域名的流量，从边缘节点走「自建 SOCKS5 落地机」出口（干净 IP，解锁）；
 * 其余流量走默认 CF 出口（优选 IP）。规则由控制面按套餐下发，此文件是内置默认值。
 *
 * 收录范围：非中国大陆 AI 服务（对话/图像/视频/音频/编程助手/推理 API）。
 * 明确排除：中国大陆 AI 服务（见 EXCLUDED_CN，仅作记录，不参与分流）。
 *
 * 维护：可由 CI 定期从上游清单增量合并；匹配为「域名或其任意子域」。
 */

export const AI_UNLOCK_DOMAINS: Record<string, string[]> = {
  anthropic: [
    "anthropic.com",
    "claude.ai",
    "claudeusercontent.com",
    "console.anthropic.com",
    "api.anthropic.com",
    "statsig.anthropic.com",
  ],
  openai: [
    "openai.com",
    "chatgpt.com",
    "chat.openai.com",
    "api.openai.com",
    "auth.openai.com",
    "auth0.openai.com",
    "platform.openai.com",
    "cdn.openai.com",
    "oaistatic.com",
    "oaiusercontent.com",
    "sora.com",
    "videos.openai.com",
  ],
  xai_grok: [
    "x.ai",
    "api.x.ai",
    "grok.com",
    "accounts.x.ai",
  ],
  google_ai: [
    // 仅 AI 相关子域，避免把整个 google.com 都甩去落地
    "gemini.google.com",
    "aistudio.google.com",
    "generativelanguage.googleapis.com",
    "ai.google.dev",
    "makersuite.google.com",
    "labs.google",
    "notebooklm.google.com",
    "deepmind.google",
    "aitestkitchen.google.com",
    "aisandbox-pa.googleapis.com",
    "proactivebackend-pa.googleapis.com",
    "alkalimakersuite-pa.clients6.google.com",
  ],
  microsoft_copilot: [
    "copilot.microsoft.com",
    "copilot.cloud.microsoft",
    "api.githubcopilot.com",
    "copilot-proxy.githubusercontent.com",
  ],
  perplexity: ["perplexity.ai", "pplx.ai"],
  mistral: ["mistral.ai", "chat.mistral.ai"],
  cohere: ["cohere.com", "cohere.ai"],
  meta_ai: ["meta.ai"],
  groq: ["groq.com", "api.groq.com"],
  together: ["together.ai", "api.together.xyz"],
  huggingface: ["huggingface.co", "hf.co"],
  replicate: ["replicate.com", "replicate.delivery"],
  poe: ["poe.com"],
  you: ["you.com"],
  phind: ["phind.com"],
  character_ai: ["character.ai"],
  // 编程助手
  cursor: ["cursor.com", "cursor.sh", "api2.cursor.sh", "api3.cursor.sh"],
  codeium_windsurf: ["codeium.com", "windsurf.com"],
  vercel_v0: ["v0.dev", "v0.app"],
  // 图像/视频/音频
  stability: ["stability.ai"],
  midjourney: ["midjourney.com"],
  runway: ["runwayml.com"],
  leonardo: ["leonardo.ai"],
  ideogram: ["ideogram.ai"],
  elevenlabs: ["elevenlabs.io"],
  suno: ["suno.com", "suno.ai"],
  luma: ["lumalabs.ai"],
  pika: ["pika.art"],
};

/** 展平后的完整解锁域名数组（供路由匹配使用）。 */
export const AI_UNLOCK_LIST: string[] = Object.values(AI_UNLOCK_DOMAINS).flat();

/**
 * 明确排除的中国大陆 AI 服务（不解锁、不分流，走默认或直连由客户端规则处理）。
 * 仅作记录，帮助维护者不要误加进解锁清单。
 */
export const EXCLUDED_CN: string[] = [
  "deepseek.com",            // DeepSeek
  "moonshot.cn", "kimi.com", // Kimi / Moonshot
  "doubao.com",              // 豆包 / 火山
  "tongyi.aliyun.com", "dashscope.aliyuncs.com", // 通义千问 / Qwen
  "zhipuai.cn", "chatglm.cn", "bigmodel.cn",     // 智谱 / ChatGLM
  "yiyan.baidu.com",         // 文心一言 Ernie
  "hunyuan.tencent.com",     // 腾讯混元
  "xinghuo.xfyun.cn",        // 讯飞星火
  "minimaxi.com", "hailuoai.com", // MiniMax / 海螺
  "lingyiwanwu.com",         // 零一万物 Yi
  "baichuan-ai.com",         // 百川
  "stepfun.com",             // 阶跃星辰
];

/**
 * 判断 host 是否命中解锁清单（域名或任意子域）。
 * @example isUnlockHost("api.openai.com") -> true
 */
export function isUnlockHost(host: string, list: string[] = AI_UNLOCK_LIST): boolean {
  host = host.toLowerCase().replace(/\.$/, "");
  return list.some((d) => host === d || host.endsWith("." + d));
}
