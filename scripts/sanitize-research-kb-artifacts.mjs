import pg from "pg";

const { Pool } = pg;

function arg(name) {
  return process.argv.includes(name);
}

function valueArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function compact(value = "", max = 1400) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeTopicForMatch(value = "") {
  return String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
}

function isWeakYoutubeTitle(value = "") {
  const text = compact(value);
  if (!text) return true;
  const normalized = normalizeTopicForMatch(text.replace(/youtube\s*技术笔记/ig, "").replace(/技术笔记/g, ""));
  return normalized.length <= 3 ||
    /^(?:this|it|a|an|ai|tech|technology|youtube|video|summary|note|notes|技术|科技|视频|总结|笔记)$/.test(normalized) ||
    /youtube\s*技术笔记/i.test(text) ||
    /技术笔记$/i.test(text);
}

function cleanYoutubeTitle(value = "") {
  return compact(value, 500)
    .replace(/\s*YouTube\s*技术笔记\s*$/i, "")
    .replace(/\s*技术笔记\s*$/i, "")
    .trim();
}

function isLowValueArtifact(value = "") {
  const text = compact(value);
  if (!text) return false;
  return /YouTube\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading|<\/?details|<summary|我先按|接下来我会/i.test(text);
}

function cleanResearchText(value = "", max = 1400) {
  const raw = compact(value, max);
  if (!raw) return "";
  if (/^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:阅读导航|输出语言|内容形态|这部分没有生成到有效内容)\s*[:：]?/i.test(raw)) return "";
  if (/^(?:#{1,6}\s*)?.*YouTube\s*技术笔记\s*$/i.test(raw)) {
    const title = cleanYoutubeTitle(raw.replace(/^#{1,6}\s*/, ""));
    return isWeakYoutubeTitle(title) ? "" : title;
  }
  const cleaned = raw
    .replace(/\s*YouTube\s*技术笔记\s*/ig, " ")
    .replace(/\s*技术笔记\s*$/ig, "")
    .replace(/<\/?details[^>]*>|<\/?summary[^>]*>/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:我先按|接下来我会)/.test(cleaned)) return "";
  return cleaned.slice(0, max);
}

function cleanEvidenceText(value = "", max = 1400) {
  const raw = compact(value, max);
  if (/^(?:#{1,6}\s*)?.*YouTube\s*技术笔记\s*$/i.test(raw)) return "";
  return cleanResearchText(raw, max);
}

function changed(before, after) {
  return String(before || "") !== String(after || "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function main() {
  if (arg("--help")) {
    console.log([
      "Usage:",
      "  node scripts/sanitize-research-kb-artifacts.mjs [--apply] [--database-url <url>]",
      "",
      "Default is dry-run. It reports changes without writing.",
      "With --apply it removes legacy Markdown-generation artifacts from structured research tables."
    ].join("\n"));
    return;
  }

  const databaseUrl = valueArg("--database-url", process.env.DATABASE_URL || "");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Pass --database-url or set DATABASE_URL.");
  }
  const apply = arg("--apply");
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
  });
  const client = await pool.connect();
  const summary = {
    mode: apply ? "apply" : "dry-run",
    sourcesUpdated: 0,
    evidenceUpdated: 0,
    evidenceDeleted: 0,
    questionsUpdated: 0,
    questionsDeleted: 0,
    gapsUpdated: 0,
    gapsDeleted: 0,
    timeContextsUpdated: 0,
    topicsUpdated: 0,
    samples: []
  };

  const sample = (table, id, before, after) => {
    if (summary.samples.length >= 20) return;
    summary.samples.push({ table, id, before: compact(before, 160), after: compact(after, 160) });
  };

  try {
    await client.query("BEGIN");

    const sources = await client.query(
      `SELECT source_id, title, author, organization, conflict_profile
       FROM research_sources
       WHERE title ~* 'YouTube\\s*技术笔记|技术笔记$|阅读导航|输出语言|内容形态'
          OR author ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态'
          OR organization ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态'
          OR conflict_profile ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态'`
    );
    for (const row of sources.rows) {
      const title = cleanResearchText(row.title, 500) || "历史 YouTube 研究文档";
      const author = cleanResearchText(row.author, 240);
      const organization = cleanResearchText(row.organization, 240);
      const conflictProfile = cleanResearchText(row.conflict_profile, 500);
      if (
        changed(row.title, title) ||
        changed(row.author, author) ||
        changed(row.organization, organization) ||
        changed(row.conflict_profile, conflictProfile)
      ) {
        summary.sourcesUpdated += 1;
        sample("research_sources", row.source_id, row.title, title);
        if (apply) {
          await client.query(
            `UPDATE research_sources
             SET title = $2, author = $3, organization = $4, conflict_profile = $5, updated_at = now()
             WHERE source_id = $1`,
            [row.source_id, title, author, organization, conflictProfile]
          );
        }
      }
    }

    const evidence = await client.query(
      `SELECT id, claim, quote_original, quote_zh, location, why_it_matters, stale_risk
       FROM research_evidence_cards
       WHERE claim ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR quote_original ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR quote_zh ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR location ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会|legacy_heading'
          OR why_it_matters ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR stale_risk ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'`
    );
    for (const row of evidence.rows) {
      const claim = cleanEvidenceText(row.claim, 1200);
      const quoteOriginal = cleanEvidenceText(row.quote_original, 2400);
      const quoteZh = cleanEvidenceText(row.quote_zh, 2400);
      const location = cleanEvidenceText(row.location, 120);
      const whyItMatters = cleanEvidenceText(row.why_it_matters, 1200);
      const staleRisk = cleanEvidenceText(row.stale_risk, 1200);
      if (!claim && !quoteOriginal && !quoteZh) {
        summary.evidenceDeleted += 1;
        sample("research_evidence_cards/delete", row.id, row.claim || row.quote_original || row.quote_zh, "");
        if (apply) await client.query(`DELETE FROM research_evidence_cards WHERE id = $1`, [row.id]);
        continue;
      }
      if (
        changed(row.claim, claim) ||
        changed(row.quote_original, quoteOriginal) ||
        changed(row.quote_zh, quoteZh) ||
        changed(row.location, location) ||
        changed(row.why_it_matters, whyItMatters) ||
        changed(row.stale_risk, staleRisk)
      ) {
        summary.evidenceUpdated += 1;
        sample("research_evidence_cards", row.id, row.claim || row.quote_original, claim || quoteOriginal || quoteZh);
        if (apply) {
          await client.query(
            `UPDATE research_evidence_cards
             SET claim = $2, quote_original = $3, quote_zh = $4, location = $5,
                 why_it_matters = $6, stale_risk = $7
             WHERE id = $1`,
            [row.id, claim, quoteOriginal, quoteZh, location, whyItMatters, staleRisk]
          );
        }
      }
    }

    const questions = await client.query(
      `SELECT id, question, research_direction
       FROM research_questions
       WHERE question ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR research_direction ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'`
    );
    for (const row of questions.rows) {
      const question = cleanEvidenceText(row.question, 600);
      const researchDirection = cleanEvidenceText(row.research_direction, 240);
      if (!question) {
        summary.questionsDeleted += 1;
        sample("research_questions/delete", row.id, row.question, "");
        if (apply) await client.query(`DELETE FROM research_questions WHERE id = $1`, [row.id]);
      } else if (changed(row.question, question) || changed(row.research_direction, researchDirection)) {
        summary.questionsUpdated += 1;
        sample("research_questions", row.id, row.question, question);
        if (apply) {
          await client.query(
            `UPDATE research_questions SET question = $2, research_direction = $3 WHERE id = $1`,
            [row.id, question, researchDirection]
          );
        }
      }
    }

    const gaps = await client.query(
      `SELECT id, gap, impact, confidence_impact
       FROM research_coverage_gaps
       WHERE gap ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR impact ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR confidence_impact ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'`
    );
    for (const row of gaps.rows) {
      const gap = cleanEvidenceText(row.gap, 600);
      const impact = cleanEvidenceText(row.impact, 1000);
      const confidenceImpact = cleanEvidenceText(row.confidence_impact, 240);
      if (!gap) {
        summary.gapsDeleted += 1;
        sample("research_coverage_gaps/delete", row.id, row.gap, "");
        if (apply) await client.query(`DELETE FROM research_coverage_gaps WHERE id = $1`, [row.id]);
      } else if (changed(row.gap, gap) || changed(row.impact, impact) || changed(row.confidence_impact, confidenceImpact)) {
        summary.gapsUpdated += 1;
        sample("research_coverage_gaps", row.id, row.gap, gap);
        if (apply) {
          await client.query(
            `UPDATE research_coverage_gaps SET gap = $2, impact = $3, confidence_impact = $4 WHERE id = $1`,
            [row.id, gap, impact, confidenceImpact]
          );
        }
      }
    }

    const contexts = await client.query(
      `SELECT source_id, current_relevance, stale_if
       FROM research_time_contexts
       WHERE current_relevance ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR stale_if ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'`
    );
    for (const row of contexts.rows) {
      const currentRelevance = cleanEvidenceText(row.current_relevance, 1200);
      const staleIf = cleanEvidenceText(row.stale_if, 1000);
      if (changed(row.current_relevance, currentRelevance) || changed(row.stale_if, staleIf)) {
        summary.timeContextsUpdated += 1;
        sample("research_time_contexts", row.source_id, row.current_relevance, currentRelevance);
        if (apply) {
          await client.query(
            `UPDATE research_time_contexts SET current_relevance = $2, stale_if = $3, updated_at = now() WHERE source_id = $1`,
            [row.source_id, currentRelevance, staleIf]
          );
        }
      }
    }

    const topics = await client.query(
      `SELECT topic_key, canonical_name, topic_type, aliases, description
       FROM research_topics
       WHERE canonical_name ~* 'YouTube\\s*技术笔记|技术笔记$|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'
          OR topic_type ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态'
          OR aliases::text ~* 'YouTube\\s*技术笔记|技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会|https?://'
          OR description ~* 'YouTube\\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会'`
    );
    for (const row of topics.rows) {
      const canonicalName =
        cleanResearchText(row.canonical_name, 160) ||
        cleanResearchText(row.topic_key, 160) ||
        "历史研究主题";
      const topicType = cleanResearchText(row.topic_type, 80) || "theme";
      const description = cleanResearchText(row.description, 800);
      const seenAliases = new Set();
      const aliases = asArray(row.aliases)
        .map((item) => {
          const raw = compact(item, 240);
          if (!raw || isLowValueArtifact(raw) || /^https?:\/\//i.test(raw)) return "";
          const clean = cleanEvidenceText(raw, 160);
          if (!clean || isLowValueArtifact(clean) || clean === canonicalName || clean.length > 80) return "";
          const key = clean.toLowerCase();
          if (seenAliases.has(key)) return "";
          seenAliases.add(key);
          return clean;
        })
        .filter(Boolean);
      const beforeAliases = JSON.stringify(asArray(row.aliases));
      const afterAliases = JSON.stringify(aliases);
      if (
        changed(row.canonical_name, canonicalName) ||
        changed(row.topic_type, topicType) ||
        beforeAliases !== afterAliases ||
        changed(row.description, description)
      ) {
        summary.topicsUpdated += 1;
        sample("research_topics", row.topic_key, `${row.canonical_name} aliases=${beforeAliases}`, `${canonicalName} aliases=${afterAliases}`);
        if (apply) {
          await client.query(
            `UPDATE research_topics
             SET canonical_name = $2,
                 topic_type = $3,
                 aliases = $4::jsonb,
                 description = $5,
                 updated_at = now()
             WHERE topic_key = $1`,
            [row.topic_key, canonicalName, topicType, JSON.stringify(aliases), description]
          );
        }
      }
    }

    if (apply) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
