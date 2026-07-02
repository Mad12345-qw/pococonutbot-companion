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
      rawText: "A primary quote with a time-sensitive industry claim.",
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
        claim: "This is a grounded claim.",
        quoteOriginal: "A primary quote with a time-sensitive industry claim.",
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

  console.log("Research knowledge base checks passed.");
} finally {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
}
