import { truncate } from "./utils.js";

function stableStringify(value) {
  return JSON.stringify(value);
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSort(value[key])]));
}

function toBase64Utf8(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function fromBase64Utf8(text) {
  return Buffer.from(text || "", "base64").toString("utf8");
}

function countStateRecords(state) {
  if (!state || typeof state !== "object") return 0;
  return Object.values(state).reduce((count, value) => {
    if (Array.isArray(value)) return count + value.length;
    if (value && typeof value === "object") return count + Object.keys(value).length;
    return count;
  }, 0);
}

export class GitHubMemoryBackup {
  constructor({ config, storage }) {
    this.config = config;
    this.storage = storage;
    this.lastStableState = "";
  }

  get enabled() {
    return Boolean(this.config.githubBackupToken && this.config.githubBackupRepo);
  }

  async start() {
    if (!this.enabled) {
      console.log("GitHub memory backup is disabled.");
      return;
    }

    console.log(`GitHub memory backup enabled for ${this.config.githubBackupRepo}/${this.config.githubBackupPath}`);
    try {
      await this.ensureBranch();

      if (this.config.restoreMemoryFromGithub && await this.storage.isEmpty()) {
        await this.restoreLatest();
      }

      await this.backupNow("startup");
    } catch (error) {
      console.error("GitHub memory backup startup failed:", error.message);
    }

    const intervalMs = Math.max(5, this.config.githubBackupIntervalMinutes) * 60 * 1000;
    setInterval(() => {
      this.backupNow("interval").catch((error) => {
        console.error("GitHub memory backup failed:", error.message);
      });
    }, intervalMs);
  }

  async request(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.githubBackupToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub API ${response.status}: ${truncate(text, 500)}`);
      error.status = response.status;
      throw error;
    }

    return text ? JSON.parse(text) : null;
  }

  async requestText(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.githubBackupToken}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "pococonutbot-memory-backup",
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub raw API ${response.status}: ${truncate(text, 500)}`);
      error.status = response.status;
      throw error;
    }
    return text;
  }

  async ensureBranch() {
    const [owner, repo] = this.config.githubBackupRepo.split("/");
    const branch = encodeURIComponent(this.config.githubBackupBranch);

    try {
      await this.request(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      return;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    const repoInfo = await this.request(`/repos/${owner}/${repo}`);
    const sourceBranch = encodeURIComponent(repoInfo.default_branch || "master");
    const sourceRef = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${sourceBranch}`);
    await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${this.config.githubBackupBranch}`,
        sha: sourceRef.object.sha
      })
    });
    console.log(`Created GitHub backup branch ${this.config.githubBackupBranch}.`);
  }

  async getRemoteBackup() {
    const [owner, repo] = this.config.githubBackupRepo.split("/");
    const path = this.config.githubBackupPath.split("/").map(encodeURIComponent).join("/");
    const branch = encodeURIComponent(this.config.githubBackupBranch);

    try {
      const file = await this.request(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
      let decoded = fromBase64Utf8(String(file.content || "").replace(/\s/g, "")).trim();
      if (!decoded && file.git_url) {
        const blobPath = new URL(file.git_url).pathname;
        const blob = await this.request(blobPath);
        if (blob?.encoding === "base64" && blob.content) {
          decoded = fromBase64Utf8(String(blob.content || "").replace(/\s/g, "")).trim();
        }
      }
      if (!decoded && file.download_url) {
        decoded = (await this.requestText(file.download_url)).trim();
      }
      if (!decoded) {
        return { sha: file.sha, snapshot: null };
      }
      let parsed;
      try {
        parsed = JSON.parse(decoded);
      } catch (error) {
        console.warn(`Ignoring invalid GitHub memory backup JSON at ${this.config.githubBackupPath}: ${error.message}`);
        return { sha: file.sha, snapshot: null };
      }
      return { sha: file.sha, snapshot: parsed };
    } catch (error) {
      if (error.status === 404) return { sha: "", snapshot: null };
      throw error;
    }
  }

  async restoreLatest() {
    const remote = await this.getRemoteBackup();
    if (!remote.snapshot?.data) return;

    await this.storage.importState(remote.snapshot.data);
    this.lastStableState = stableStringify(deepSort(remote.snapshot.data));
    console.log("Restored memory from GitHub backup.");
  }

  async backupNow(reason = "manual") {
    const state = await this.storage.exportState();
    const stableState = stableStringify(deepSort(state));

    if (stableState === this.lastStableState) {
      return;
    }

    const remote = await this.getRemoteBackup();
    if (countStateRecords(state) === 0 && countStateRecords(remote.snapshot?.data) > 0) {
      console.warn("Refusing to overwrite non-empty GitHub memory backup with empty local state.");
      return;
    }

    if (remote.snapshot?.data && stableStringify(deepSort(remote.snapshot.data)) === stableState) {
      this.lastStableState = stableState;
      return;
    }

    const snapshot = {
      version: 1,
      exportedAt: new Date().toISOString(),
      reason,
      service: "telegram-ai-companion",
      data: state
    };

    const [owner, repo] = this.config.githubBackupRepo.split("/");
    const path = this.config.githubBackupPath.split("/").map(encodeURIComponent).join("/");
    const branch = this.config.githubBackupBranch;
    const body = {
      message: `Backup Telegram bot memory (${reason})`,
      content: toBase64Utf8(JSON.stringify(snapshot, null, 2)),
      branch
    };

    if (remote.sha) body.sha = remote.sha;

    await this.request(`/repos/${owner}/${repo}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });

    this.lastStableState = stableState;
    console.log(`Backed up memory to GitHub (${reason}).`);
  }
}
