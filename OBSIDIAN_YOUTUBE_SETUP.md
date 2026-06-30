# Obsidian YouTube Notes Sync

Target local vault folder:

`D:\obsidian\knowledge\youtube`

The Render bot cannot write directly to a Windows local folder. The sync path is:

1. Render Xiaoye writes Markdown files to a private GitHub repo.
2. The repo is cloned or synced into `D:\obsidian\knowledge`.
3. Obsidian reads notes from `D:\obsidian\knowledge\youtube`.

## Repository Layout

```text
D:\obsidian\knowledge
  youtube\
    <video-note>.md
  topics\
    SpaceX.md
```

`youtube/` stores one note per YouTube video or YouTube research request.

`topics/SpaceX.md` is the topic index. Notes link back to it with `[[SpaceX]]`, tags such as `#spacex`, and YAML frontmatter.

## Render Environment Variables

```text
TRANSCRIPT_API_ENABLED=true
TRANSCRIPT_API_KEY=<rotate-and-use-a-secret-key>
TRANSCRIPT_API_BASE_URL=https://transcriptapi.com
YOUTUBE_RESEARCH_REQUIRE_PRIMARY=false
YOUTUBE_RESEARCH_FORCE_PRIMARY_WITH_FALLBACK=true

OBSIDIAN_SYNC_ENABLED=true
OBSIDIAN_GITHUB_TOKEN=<github-token-with-repo-contents-write-access>
OBSIDIAN_GITHUB_REPO=<owner>/<private-obsidian-repo>
OBSIDIAN_GITHUB_BRANCH=main
OBSIDIAN_YOUTUBE_FOLDER=youtube
OBSIDIAN_TOPIC_FOLDER=topics
```

## Local Obsidian Setup

Clone the private repo so its root is `D:\obsidian\knowledge`, or use the Obsidian Git plugin with the same repo.

Recommended Obsidian Git plugin settings:

- Pull on startup: enabled
- Auto pull interval: 5 minutes
- Auto commit and sync: optional for local edits

## Model Choice

Keep `YOUTUBE_RESEARCH_FORCE_PRIMARY_WITH_FALLBACK=true` for this skill. YouTube transcript notes need long-context compression, technical detail extraction, translation, and careful Markdown structure. This setting makes the skill call the primary model first even if the normal chat primary-model switch is disabled, then fall back to MiniMax-M3 if the primary call fails.
