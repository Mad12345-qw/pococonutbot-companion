import crypto from "node:crypto";
import { logEvent } from "./runtime-log.js";
import { parseJsonObject, truncate } from "./utils.js";

const projectCreatePattern = /^(?:\/project|新建项目|创建项目|开始项目|项目brief|brief)[:：\s-]*/i;

function todayStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function makeProjectId() {
  return `P-${todayStamp()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function cleanBriefText(text = "") {
  return String(text || "").replace(projectCreatePattern, "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[,\n，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function list(items, fallback = "待补充") {
  const rows = asArray(items);
  if (!rows.length) return `- ${fallback}`;
  return rows.map((item) => `- ${item}`).join("\n");
}

function tableRows(items = [], mapper) {
  const rows = Array.isArray(items) ? items : [];
  return rows.map(mapper).filter(Boolean);
}

function normalizeAnalysis(raw, briefText) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    title: String(value.title || value.projectTitle || "AI 方案项目").slice(0, 80),
    clientName: String(value.clientName || value.client || "待补充").slice(0, 80),
    productName: String(value.productName || value.product || "待补充").slice(0, 80),
    objective: String(value.objective || value.goal || "根据 brief 生成营销方案初稿").slice(0, 500),
    audience: asArray(value.audience || value.targetAudience),
    channels: asArray(value.channels),
    deliverables: asArray(value.deliverables),
    coreSellingPoints: asArray(value.coreSellingPoints || value.sellingPoints),
    marketingAngles: asArray(value.marketingAngles || value.angles),
    missingInfo: asArray(value.missingInfo || value.questions),
    researchDirections: asArray(value.researchDirections || value.research),
    frameworkSections: Array.isArray(value.frameworkSections) ? value.frameworkSections : [],
    assetNeeds: Array.isArray(value.assetNeeds) ? value.assetNeeds : [],
    contentTasks: asArray(value.contentTasks),
    qaChecklist: asArray(value.qaChecklist),
    briefSummary: String(value.briefSummary || briefText).slice(0, 1200)
  };
}

function fallbackAnalysis(briefText) {
  return normalizeAnalysis({
    title: "AI 方案项目",
    objective: "基于用户提供的 brief，搭建调研、方案框架和素材需求表。",
    missingInfo: ["客户/品牌背景", "产品核心卖点", "预算", "上线时间", "已有素材", "目标人群数据"],
    researchDirections: ["企业与品牌背景", "产品功能与卖点", "竞品传播方式", "目标人群需求", "可用视觉资产"],
    frameworkSections: [
      { title: "项目背景与目标", purpose: "对齐甲方诉求和交付目标", bullets: ["业务背景", "传播目标", "核心挑战"] },
      { title: "产品卖点梳理", purpose: "提炼可传播的核心利益点", bullets: ["功能卖点", "情绪价值", "场景价值"] },
      { title: "营销策略方向", purpose: "形成可执行的传播主线", bullets: ["主题方向", "渠道打法", "内容支柱"] },
      { title: "执行排期与产出", purpose: "拆解后续执行工作", bullets: ["阶段节奏", "素材需求", "验收指标"] }
    ],
    assetNeeds: [
      { module: "产品介绍", assetType: "白底产品图", keywords: ["产品白底图", "SKU 图"], usage: "用于卖点页和电商转化页" },
      { module: "策略主视觉", assetType: "KV 参考", keywords: ["品牌 KV", "Campaign visual"], usage: "用于确定视觉调性" }
    ],
    qaChecklist: ["目标是否明确", "卖点是否具体", "每个模块是否有证据或数据支撑", "是否缺少素材和版权说明"]
  }, briefText);
}

function safeJsonPrompt(briefText) {
  return [
    {
      role: "system",
      content: [
        "你是顶级 FDE 级营销方案项目经理，负责把客户 brief 结构化为可执行项目。",
        "只输出 JSON，不要 Markdown，不要解释。",
        "字段：title, clientName, productName, objective, audience[], channels[], deliverables[], coreSellingPoints[], marketingAngles[], missingInfo[], researchDirections[], frameworkSections[], assetNeeds[], contentTasks[], qaChecklist[], briefSummary。",
        "frameworkSections 每项字段：title, purpose, bullets[]。",
        "assetNeeds 每项字段：module, assetType, keywords[], usage, licenseNote。",
        "如果 brief 缺信息，不要编造成事实，写入 missingInfo。"
      ].join("\n")
    },
    {
      role: "user",
      content: `请结构化这个 brief：\n${briefText}`
    }
  ];
}

function buildResearchMarkdown(project, analysis) {
  return [
    `# ${project.title}｜调研文档`,
    "",
    "## 说明",
    "这是第一阶段自动生成的调研骨架，当前基于 brief 和模型推理，不等同于已联网核验的事实。正式交付前，需要补充来源链接、产品资料和竞品证据。",
    "",
    "## 项目摘要",
    `- 项目编号：${project.id}`,
    `- 客户/品牌：${analysis.clientName}`,
    `- 产品/服务：${analysis.productName}`,
    `- 核心目标：${analysis.objective}`,
    "",
    "## Brief 摘要",
    analysis.briefSummary || "待补充",
    "",
    "## 目标人群假设",
    list(analysis.audience, "待补充目标人群"),
    "",
    "## 产品主要卖点",
    list(analysis.coreSellingPoints, "待补充产品卖点"),
    "",
    "## 适合营销的方向",
    list(analysis.marketingAngles, "待补充营销方向"),
    "",
    "## 需要继续调研的问题",
    list(analysis.researchDirections, "待补充调研方向"),
    "",
    "## 缺失信息",
    list(analysis.missingInfo, "暂无明显缺失信息")
  ].join("\n");
}

function buildFrameworkMarkdown(project, analysis) {
  const sections = analysis.frameworkSections.length
    ? analysis.frameworkSections
    : fallbackAnalysis(project.briefText).frameworkSections;
  const sectionText = sections.map((section, index) => [
    `## ${index + 1}. ${section.title || "方案模块"}`,
    section.purpose ? `- 模块目的：${section.purpose}` : "",
    list(section.bullets || [], "待补充内容点")
  ].filter(Boolean).join("\n")).join("\n\n");

  return [
    `# ${project.title}｜方案框架`,
    "",
    "## 方案定位",
    `- 项目编号：${project.id}`,
    `- 核心目标：${analysis.objective}`,
    `- 建议渠道：${asArray(analysis.channels).join("、") || "待补充"}`,
    `- 交付物：${asArray(analysis.deliverables).join("、") || "待补充"}`,
    "",
    "## 推荐 PPT 结构",
    sectionText,
    "",
    "## 内容填充任务",
    list(analysis.contentTasks, "按模块补充数据、案例、素材、执行排期"),
    "",
    "## 质检清单",
    list(analysis.qaChecklist, "检查逻辑、证据、素材、执行与预算是否完整")
  ].join("\n");
}

function buildAssetRows(project, analysis) {
  const needs = analysis.assetNeeds.length
    ? analysis.assetNeeds
    : fallbackAnalysis(project.briefText).assetNeeds;
  return [
    ["项目编号", "模块", "素材类型", "搜索关键词", "用途", "版权/来源备注", "状态"],
    ...tableRows(needs, (item) => [
      project.id,
      item.module || "待补充模块",
      item.assetType || "参考图/产品图",
      asArray(item.keywords).join(" / ") || "待补充关键词",
      item.usage || "用于方案或 PPT 视觉参考",
      item.licenseNote || "需人工确认可商用/可引用范围",
      "待查找"
    ])
  ];
}

function artifactSummary(markdown = "") {
  return truncate(String(markdown || "").replace(/\n{3,}/g, "\n\n"), 1800);
}

export function isProjectCreateRequest(text = "") {
  return projectCreatePattern.test(String(text || "").trim());
}

export class ProjectEngine {
  constructor({ config, storage, ai, feishuWorkspace }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.feishuWorkspace = feishuWorkspace;
  }

  async analyzeBrief(briefText) {
    try {
      const response = await this.ai.chat(safeJsonPrompt(briefText), {
        maxTokens: 2200,
        temperature: 0.35
      });
      const parsed = parseJsonObject(response);
      if (!parsed) throw new Error("brief parser returned non-JSON");
      return normalizeAnalysis(parsed, briefText);
    } catch (error) {
      logEvent("warn", "Project brief parser fallback used", { error: error.message });
      return fallbackAnalysis(briefText);
    }
  }

  async createProjectFromBrief({ chatId, userId, text, reply }) {
    const briefText = cleanBriefText(text);
    if (!briefText || briefText.length < 12) {
      await reply("把 brief 跟在“新建项目”后面发给我，例如：新建项目：客户、产品、目标、渠道、交付物。");
      return null;
    }

    const project = {
      id: makeProjectId(),
      platform: "feishu",
      chatId,
      ownerUserId: userId,
      title: "AI 方案项目",
      clientName: "",
      productName: "",
      briefText,
      status: "running",
      metadata: {}
    };

    await this.storage.createProject(project);
    await reply(`收到，已创建项目 ${project.id}。\n我开始解析 brief、生成调研骨架、方案框架和素材表。`);

    const analysis = await this.analyzeBrief(briefText);
    project.title = analysis.title;
    project.clientName = analysis.clientName;
    project.productName = analysis.productName;
    project.metadata = { analysis };
    await this.storage.updateProject(project.id, {
      title: project.title,
      clientName: project.clientName,
      productName: project.productName,
      status: "generating",
      metadata: project.metadata
    });

    await this.storage.addProjectTask({
      projectId: project.id,
      agentType: "brief_agent",
      status: "completed",
      input: { briefText },
      output: analysis
    });

    const researchMarkdown = buildResearchMarkdown(project, analysis);
    const frameworkMarkdown = buildFrameworkMarkdown(project, analysis);
    const assetRows = buildAssetRows(project, analysis);

    await this.writeArtifact({
      project,
      artifactType: "research_doc",
      title: `${project.id} 调研文档`,
      markdown: researchMarkdown
    });
    await this.writeArtifact({
      project,
      artifactType: "framework_doc",
      title: `${project.id} 方案框架`,
      markdown: frameworkMarkdown
    });
    await this.writeSheetArtifact({
      project,
      artifactType: "asset_sheet",
      title: `${project.id} 素材需求表`,
      rows: assetRows
    });

    await this.storage.updateProject(project.id, { status: "ready" });
    const artifacts = await this.storage.listProjectArtifacts(project.id);
    const links = artifacts.map((item) => {
      const metadata = item.metadata || {};
      const reason = metadata.writeError || metadata.error || "";
      const suffix = reason ? `\n  原因：${truncate(reason, 260)}` : "";
      const link = item.url
        ? `\n${item.url}${metadata.writeError ? "\n  （文档已创建，但内容写入失败，正文已保存在项目记录里）" : ""}`
        : "\n（飞书文档未创建成功，内容已保存在项目记录里）";
      return `- ${item.title}${link}${suffix}`;
    }).join("\n");

    const missing = analysis.missingInfo.length ? `\n\n我还需要你补充：\n${list(analysis.missingInfo)}` : "";
    await reply([
      `项目 ${project.id} 第一阶段已完成。`,
      "",
      "已生成：",
      links || "- 项目记录",
      missing
    ].join("\n"));
    return project;
  }

  async writeArtifact({ project, artifactType, title, markdown }) {
    let url = "";
    let token = "";
    let metadata = {};
    try {
      if (!this.feishuWorkspace?.enabled) throw new Error("Feishu workspace client is not enabled.");
      const doc = await this.feishuWorkspace.createDocument({ title, markdown });
      url = doc.url;
      token = doc.token;
      metadata = { feishuTitle: doc.title, writeError: doc.writeError || "" };
    } catch (error) {
      metadata = { error: error.message };
      logEvent("warn", "Project document artifact fallback used", { projectId: project.id, artifactType, error: error.message });
    }
    await this.storage.addProjectArtifact({
      projectId: project.id,
      artifactType,
      title,
      url,
      token,
      contentSummary: artifactSummary(markdown),
      metadata
    });
  }

  async writeSheetArtifact({ project, artifactType, title, rows }) {
    let url = "";
    let token = "";
    let metadata = { rows };
    try {
      if (!this.feishuWorkspace?.enabled) throw new Error("Feishu workspace client is not enabled.");
      const sheet = await this.feishuWorkspace.createSpreadsheet({ title, rows });
      url = sheet.url;
      token = sheet.token;
      metadata = { rows, feishuTitle: sheet.title };
    } catch (error) {
      metadata = { rows, error: error.message };
      logEvent("warn", "Project spreadsheet artifact fallback used", { projectId: project.id, artifactType, error: error.message });
    }
    await this.storage.addProjectArtifact({
      projectId: project.id,
      artifactType,
      title,
      url,
      token,
      contentSummary: rows.map((row) => row.join(" | ")).join("\n").slice(0, 1800),
      metadata
    });
  }
}
