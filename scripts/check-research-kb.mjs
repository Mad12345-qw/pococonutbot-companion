import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStorage } from "../src/storage.js";

const originalCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-kb-"));

try {
  process.chdir(tempDir);
  const storage = createStorage({ databaseUrl: "", databaseSsl: false });
  await storage.init();

  await storage.upsertResearchJob({
    id: "job:test-open-source",
    sourceType: "future_unknown_source",
    sourceUrl: "https://example.com/source",
    status: "running",
    stage: "evidence_extraction",
    attempts: 1,
    input: {
      principle: "plan_before_generation"
    }
  });
  await storage.updateResearchJob("job:test-open-source", {
    status: "done",
    stage: "done",
    output: {
      ok: true
    }
  });

  const result = await storage.upsertResearchSourceBundle({
    topics: [
      {
        name: "AI 光模块 / CPO / 数据中心网络",
        topicType: "theme",
        role: "report_topic",
        aliases: ["CPO", "光模块", "数据中心网络"]
      }
    ],
    source: {
      sourceId: "source:test-open-ended",
      sourceType: "future_unknown_source",
      platform: "example",
      url: "https://example.com/source",
      title: "Open-ended source type should not require schema changes",
      author: "Example Author",
      organization: "Example Org",
      publishedAt: "2026-07-02",
      recordedAt: "",
      eventPeriod: "2026",
      language: "en",
      durationText: "",
      rawText: "A primary quote with a time-sensitive CPO industry claim.",
      rawTextHash: "hash-test",
      docUrl: "https://example.com/doc",
      obsidianPath: "sources/example.md",
      reliabilityLevel: "source_text",
      sourcePerspective: "primary_or_expert_source",
      institutionType: "open_adapter",
      institutionRole: "source_material",
      analysisLenses: ["technology", "industry_chain", "risk"],
      evidenceStrength: "primary_text",
      accessLevel: "public",
      conflictProfile: "unknown_bias_possible",
      metadata: {
        adapter: "test_future_adapter"
      }
    },
    evidenceCards: [
      {
        evidenceType: "technology",
        claim: "This is a grounded CPO claim.",
        quoteOriginal: "A primary quote with a time-sensitive CPO industry claim.",
        location: "p.1",
        whyItMatters: "It should become reusable evidence, not just Markdown.",
        confidence: 0.8,
        timeSensitivity: "medium",
        evidenceStrength: "primary_text",
        analysisLens: "technology",
        requiresRecheck: ["product_progress"]
      }
    ],
    entities: [
      {
        entityId: "entity:test-company",
        name: "Example Org",
        entityType: "organization",
        role: "publisher"
      }
    ],
    timeContext: {
      eventPeriod: "2026",
      currentRelevance: "Useful only after time-context calibration.",
      timeSensitivity: "medium",
      staleIf: "The source facts change.",
      requiresRecheck: ["policy", "capacity"]
    },
    questions: [
      {
        question: "Which cross-source evidence should validate this claim?",
        priority: 1,
        researchDirection: "cross_source_validation",
        suggestedSourceTypes: ["company_disclosure", "regulatory_filing", "video", "dataset"]
      }
    ],
    coverageGaps: [
      {
        gap: "single_source_material",
        impact: "Do not synthesize investment conclusions from one source.",
        fallbackSignals: ["company_disclosure", "industry_report", "regulatory_filing"],
        confidenceImpact: "high"
      }
    ]
  });

  assert.equal(result.sourceId, "source:test-open-ended");
  assert.equal(result.evidenceCards, 1);
  assert.equal(result.entities, 1);
  assert.equal(result.questions, 1);
  assert.equal(result.coverageGaps, 1);

  const exported = await storage.exportState();
  assert.equal(exported.researchJobs[0].status, "done");
  assert.equal(exported.researchSources[0].source_type || exported.researchSources[0].sourceType, "future_unknown_source");
  assert.deepEqual(exported.researchSources[0].analysis_lenses || exported.researchSources[0].analysisLenses, ["technology", "industry_chain", "risk"]);
  assert.equal(exported.researchEvidenceCards[0].evidence_strength || exported.researchEvidenceCards[0].evidenceStrength, "primary_text");
  assert.equal(exported.researchEntities[0].name, "Example Org");
  assert.equal(exported.researchTimeContexts[0].time_sensitivity || exported.researchTimeContexts[0].timeSensitivity, "medium");
  assert.equal(exported.researchQuestions[0].status, "open");
  assert.equal(exported.researchCoverageGaps[0].gap, "single_source_material");
  assert.ok(exported.researchTopics.some((topic) => (topic.topic_key || topic.topicKey) === "ai-光模块-cpo-数据中心网络"));
  assert.ok(exported.researchEvidenceTopics.length >= 1);

  const topicMap = await storage.getResearchTopicMap({ query: "CPO", limit: 20 });
  assert.ok(topicMap.topics.some((topic) => topic.canonicalName === "AI 光模块 / CPO / 数据中心网络"));

  const graphCorpus = await storage.listResearchEvidenceForReport({
    query: "CPO",
    topicMap,
    limit: 5,
    evidenceLimit: 10
  });
  assert.equal(graphCorpus.sources.length, 1);
  assert.equal(graphCorpus.evidenceCards[0].claim, "This is a grounded CPO claim.");

  await storage.upsertResearchJob({
    id: "job:investment-report-v1",
    sourceType: "investment_report",
    sourceUrl: "CPO",
    status: "done",
    stage: "done",
    output: { title: "CPO 产业链报告 v1" }
  });
  const versionOne = await storage.recordInvestmentReportVersion({
    jobId: "job:investment-report-v1",
    query: "CPO",
    topicMap,
    structured: {
      title: "CPO 产业链报告 v1",
      oneSentence: "CPO remains an evidence-bounded research direction.",
      thesis: "CPO thesis must be verified by cross-source evidence.",
      hypotheses: [
        {
          title: "CPO may become a data-center network value-chain node.",
          confidence: "medium",
          evidenceIds: ["E1"]
        }
      ]
    },
    pack: graphCorpus
  });
  assert.equal(versionOne.versionNo, 1);
  const priorReport = await storage.getPriorInvestmentReport({ query: "CPO", topicMap });
  assert.equal(priorReport.versionNo, 1);
  assert.equal(priorReport.output.title, "CPO 产业链报告 v1");

  const reusableBeforeNewEvidence = await storage.getReusableInvestmentReport({
    query: "CPO",
    topicMap,
    maxAgeMinutes: 720
  });
  assert.equal(reusableBeforeNewEvidence, null);

  await storage.upsertResearchJob({
    id: "job:investment-report-v2",
    sourceType: "investment_report",
    sourceUrl: "CPO",
    status: "done",
    stage: "done",
    output: { title: "CPO 产业链报告 v2", feishuDocUrl: "https://example.feishu.cn/wiki/reportv2" }
  });
  const versionTwo = await storage.recordInvestmentReportVersion({
    jobId: "job:investment-report-v2",
    query: "CPO",
    topicMap,
    structured: {
      title: "CPO 产业链报告 v2",
      oneSentence: "The next report should compare against v1.",
      deltaSincePrior: "New evidence strengthens the need for cross-source validation.",
      hypotheses: []
    },
    pack: graphCorpus,
    priorReport
  });
  assert.equal(versionTwo.versionNo, 2);

  const reusableAfterLinkedReport = await storage.getReusableInvestmentReport({
    query: "CPO",
    topicMap,
    maxAgeMinutes: 720
  });
  assert.equal(reusableAfterLinkedReport.feishuDocUrl, "https://example.feishu.cn/wiki/reportv2");

  const afterReportsExported = await storage.exportState();
  assert.equal(afterReportsExported.researchSources.some((source) =>
    String(source.source_type || source.sourceType || "") === "investment_report"
  ), false);
  assert.equal(afterReportsExported.researchEvidenceCards.some((card) =>
    String(card.evidence_type || card.evidenceType || "").includes("investment_report")
  ), false);

  await storage.upsertResearchSourceBundle({
    source: {
      sourceId: "source:test-open-ended",
      sourceType: "future_unknown_source",
      platform: "example",
      url: "https://example.com/source",
      title: "Re-running the same source replaces old research children",
      rawText: "Updated source text.",
      rawTextHash: "hash-test-updated"
    },
    evidenceCards: [
      {
        evidenceType: "risk",
        claim: "Updated claim replaces the previous evidence set.",
        quoteOriginal: "Updated source text.",
        location: "p.2",
        whyItMatters: "Long-running research jobs must not accumulate stale child rows."
      }
    ],
    questions: [
      {
        question: "What changed after the rerun?",
        priority: 2
      }
    ],
    coverageGaps: [
      {
        gap: "updated_gap_after_rerun",
        impact: "Old gaps should not remain attached to the source after rerun.",
        confidenceImpact: "medium"
      }
    ]
  });

  const rerunExported = await storage.exportState();
  assert.equal(rerunExported.researchSources.length, 1);
  assert.equal(rerunExported.researchEvidenceCards.length, 1);
  assert.equal(rerunExported.researchQuestions.length, 1);
  assert.equal(rerunExported.researchCoverageGaps.length, 1);
  assert.equal(rerunExported.researchCoverageGaps[0].gap, "updated_gap_after_rerun");

  const reportCorpus = await storage.listResearchEvidenceForReport({
    query: "Re-running source",
    limit: 5,
    evidenceLimit: 10
  });
  assert.equal(reportCorpus.sources.length, 1);
  assert.equal(reportCorpus.evidenceCards.length, 1);
  assert.equal(reportCorpus.evidenceCards[0].claim, "Updated claim replaces the previous evidence set.");

  await storage.upsertResearchSourceBundle({
    topics: [
      {
        name: "商业航天 / Starship / 液氧甲烷发动机",
        topicType: "theme",
        role: "report_topic",
        aliases: ["SpaceX", "Starship", "Raptor", "液氧甲烷", "可复用火箭"]
      }
    ],
    source: {
      sourceId: "source:test-starship-raptor",
      sourceType: "video",
      platform: "youtube",
      url: "https://youtube.com/watch?v=starship-raptor",
      title: "SpaceX Starship Raptor engine and reusable launch cadence",
      organization: "SpaceX",
      rawText: "Starship uses Raptor methalox engines and depends on reusable launch cadence.",
      rawTextHash: "hash-starship-raptor",
      docUrl: "https://example.feishu.cn/wiki/starshipraptor",
      metadata: {
        topic: "SpaceX Starship Raptor"
      }
    },
    evidenceCards: [
      {
        evidenceType: "technology",
        claim: "Raptor 液氧甲烷发动机和可复用发射节奏会影响商业航天供应链。",
        quoteOriginal: "Raptor methalox engines drive Starship's reusable launch cadence.",
        location: "12:30",
        whyItMatters: "这条证据应能被中文窄查询自动检索到，而不是要求用户输入 SpaceX。"
      }
    ]
  });
  const expandedQueryCorpus = await storage.listResearchEvidenceForReport({
    query: "商业航天液氧甲烷发动机与可复用火箭的供应链",
    limit: 5,
    evidenceLimit: 10
  });
  assert.ok(expandedQueryCorpus.sources.some((source) =>
    String(source.source_id || source.sourceId || "") === "source:test-starship-raptor"
  ));
  assert.ok(expandedQueryCorpus.evidenceCards.some((card) =>
    String(card.claim || "").includes("Raptor 液氧甲烷发动机")
  ));
  await storage.upsertResearchJob({
    id: "job:spacex-report",
    sourceType: "investment_report",
    sourceUrl: "SpaceX",
    status: "done",
    stage: "done",
    output: { title: "SpaceX 产业链报告", feishuDocUrl: "https://example.feishu.cn/wiki/spacexreport" }
  });
  await storage.recordInvestmentReportVersion({
    jobId: "job:spacex-report",
    query: "SpaceX",
    topicMap: expandedQueryCorpus.topicMap,
    structured: {
      title: "SpaceX 产业链报告",
      oneSentence: "SpaceX is only one evidence anchor, not every aerospace report identity.",
      hypotheses: []
    },
    pack: expandedQueryCorpus
  });
  const expandedPriorBeforeOwnReport = await storage.getPriorInvestmentReport({
    query: "商业航天液氧甲烷发动机与可复用火箭的供应链",
    topicMap: expandedQueryCorpus.topicMap
  });
  assert.equal(expandedPriorBeforeOwnReport, null);
  await storage.upsertResearchJob({
    id: "job:methalox-supply-chain-report",
    sourceType: "investment_report",
    sourceUrl: "商业航天液氧甲烷发动机与可复用火箭的供应链",
    status: "done",
    stage: "done",
    output: { title: "商业航天液氧甲烷发动机供应链报告", feishuDocUrl: "https://example.feishu.cn/wiki/methaloxreport" }
  });
  const expandedVersion = await storage.recordInvestmentReportVersion({
    jobId: "job:methalox-supply-chain-report",
    query: "商业航天液氧甲烷发动机与可复用火箭的供应链",
    topicMap: expandedQueryCorpus.topicMap,
    structured: {
      title: "商业航天液氧甲烷发动机供应链报告",
      oneSentence: "The report identity follows the user's research topic, while evidence retrieval may use SpaceX assets.",
      hypotheses: []
    },
    pack: expandedQueryCorpus
  });
  assert.equal(expandedVersion.versionNo, 1);
  const expandedPriorAfterOwnReport = await storage.getPriorInvestmentReport({
    query: "商业航天液氧甲烷发动机与可复用火箭的供应链",
    topicMap: expandedQueryCorpus.topicMap
  });
  assert.equal(expandedPriorAfterOwnReport.feishuDocUrl || expandedPriorAfterOwnReport.output?.feishuDocUrl, "https://example.feishu.cn/wiki/methaloxreport");

  await storage.addMessage({
    chatId: "feishu:test",
    userId: "feishu:user",
    role: "assistant",
    modality: "system",
    content: "SpaceX Starfactory research document synced.",
    metadata: {
      platform: "feishu",
      youtubeResearch: true,
      topic: "SpaceX",
      title: "First Look Inside SpaceX Starfactory",
      feishuDocUrl: "https://example.feishu.cn/wiki/backfilltoken"
    }
  });
  const history = await storage.listYoutubeResearchHistoryForBackfill({
    query: "SpaceX",
    limit: 5
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].metadata.feishuDocUrl, "https://example.feishu.cn/wiki/backfilltoken");
  const expandedHistory = await storage.listYoutubeResearchHistoryForBackfill({
    query: "商业航天液氧甲烷发动机与可复用火箭的供应链",
    limit: 5
  });
  assert.equal(expandedHistory.length, 1);
  assert.equal(expandedHistory[0].metadata.feishuDocUrl, "https://example.feishu.cn/wiki/backfilltoken");

  console.log("Research knowledge base checks passed.");
} finally {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
}
