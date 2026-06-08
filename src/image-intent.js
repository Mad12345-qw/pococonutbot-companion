export const imageGenerationCommands = ["/draw", "/image", "/imagine", "/生图", "/画图"];

const visualObjectPattern = /(图|图片|图像|配图|攻略图|信息图|流程图|海报|封面|头像|壁纸|插画|漫画|表情包|自拍|自拍照|照片|相片|photo|poster|cover|wallpaper|infographic)/i;
const actionPattern = /(画图|生图|生成图片|生成图像|生成一张图|生成一张图片|生成一张|生成一个|画一张|画一个|画个|画|做一张|做一个|做个|制作|设计|出图|出一张|来一张|生成)/i;
const negativePattern = /(不要|不用|不需要|不是|先别|暂时别).{0,8}(画图|生图|生成|制作|设计|出图)/i;
const metaQuestionPattern = /(怎么|如何|教程|文档|接口|api|模型|报错|失败).{0,12}(画图|生图|生成图片|生成图像)/i;

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanImagePrompt(text = "") {
  return String(text || "")
    .replace(/^[:：,，、\s]+/, "")
    .trim()
    .slice(0, 3000);
}

function stripLeadingBotName(text = "", botNames = []) {
  let output = String(text || "").trim();
  const names = [...new Set([...botNames, "小椰"].filter(Boolean))]
    .map((value) => escapeRegExp(value));
  if (names.length > 0) {
    output = output.replace(new RegExp(`^(?:${names.join("|")})\\s*[,，:：、]?\\s*`, "i"), "");
  }
  return output.replace(/^(?:你|妳)\s*/, "").trim();
}

function stripActionPrefix(text = "") {
  const raw = String(text || "").trim();
  const match = raw.match(actionPattern);
  if (!match || match.index == null) return raw;
  return raw.slice(match.index).trim();
}

export function extractImageGenerationIntent(text = "", options = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { requested: false, prompt: "" };

  const normalized = stripLeadingBotName(raw, options.botNames || []);
  if (!normalized || negativePattern.test(normalized)) {
    return { requested: false, prompt: "" };
  }

  for (const command of imageGenerationCommands) {
    const commandPattern = new RegExp(`^${escapeRegExp(command)}(?:@\\w+)?\\s*(.*)$`, "i");
    const match = normalized.match(commandPattern);
    if (match) {
      return { requested: true, prompt: cleanImagePrompt(match[1] || normalized) };
    }
  }

  if (/^(?:请|帮我|麻烦你|给我)?\s*(?:画图|生图|生成图片|生成图像|生成一张图|生成一张图片|画一张|画一个|画个|做一张|做一个|做个)/i.test(normalized)) {
    return { requested: true, prompt: cleanImagePrompt(stripActionPrefix(normalized)) };
  }

  const hasAction = actionPattern.test(normalized);
  const hasVisualObject = visualObjectPattern.test(normalized);
  if (!hasAction || !hasVisualObject) {
    return { requested: false, prompt: "" };
  }

  if (metaQuestionPattern.test(normalized) && !/(帮我|给我|替我|给她|给他|按照|先按|来一张|出一张)/.test(normalized)) {
    return { requested: false, prompt: "" };
  }

  return {
    requested: true,
    prompt: cleanImagePrompt(stripActionPrefix(normalized))
  };
}
