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
    await this.ensureBranch();

    if (this.config.restoreMemoryFromGithub && await this.storage.isEmpty()) {
      await this.restoreLatest();
    }

    await this.backupNow("startup");

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
      const parsed = JSON.parse(fromBase64Utf8(file.content));
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
    if (remote.snapshot?.data && stableStringify(deepSort(remote.snapshot.data)) === stableState) {
      this.lastStableState = stableState;
      return;
    }

    const snapshot = {
      version: 1,
      exportedAt: new Date().toISOString(),
      reason,
      service: "telegram-minimax-companion",
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
