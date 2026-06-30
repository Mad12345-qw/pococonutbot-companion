import { truncate } from "./utils.js";

function toBase64Utf8(text) {
  return Buffer.from(String(text || ""), "utf8").toString("base64");
}

function fromBase64Utf8(text) {
  return Buffer.from(String(text || ""), "base64").toString("utf8");
}

function normalizeRepo(value = "") {
  const clean = String(value || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}

function encodePath(path = "") {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export class GitHubFileSync {
  constructor({ token = "", repo = "", branch = "main" } = {}) {
    this.token = token;
    this.repo = normalizeRepo(repo);
    this.branch = branch || "main";
  }

  get enabled() {
    return Boolean(this.token && this.repo);
  }

  async request(path, options = {}) {
    if (!this.enabled) throw new Error("GitHub file sync is not configured.");
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
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

  splitRepo() {
    const [owner, repo] = this.repo.split("/");
    if (!owner || !repo) throw new Error("GitHub repo must use owner/repo format.");
    return { owner, repo };
  }

  async ensureBranch() {
    const { owner, repo } = this.splitRepo();
    const branch = encodeURIComponent(this.branch);
    try {
      await this.request(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      return;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    const repoInfo = await this.request(`/repos/${owner}/${repo}`);
    const sourceBranch = encodeURIComponent(repoInfo.default_branch || "main");
    const sourceRef = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${sourceBranch}`);
    await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${this.branch}`,
        sha: sourceRef.object.sha
      })
    });
  }

  async getFile(path) {
    const { owner, repo } = this.splitRepo();
    const cleanPath = encodePath(path);
    const branch = encodeURIComponent(this.branch);
    try {
      const file = await this.request(`/repos/${owner}/${repo}/contents/${cleanPath}?ref=${branch}`);
      return {
        sha: file.sha || "",
        content: fromBase64Utf8(file.content || "")
      };
    } catch (error) {
      if (error.status === 404) return { sha: "", content: "" };
      throw error;
    }
  }

  async putFile(path, content, message) {
    const { owner, repo } = this.splitRepo();
    const cleanPath = encodePath(path);
    const remote = await this.getFile(path);
    if (remote.content === String(content || "")) {
      return { path, sha: remote.sha, changed: false };
    }

    const body = {
      message: message || `Update ${path}`,
      content: toBase64Utf8(content),
      branch: this.branch
    };
    if (remote.sha) body.sha = remote.sha;

    const result = await this.request(`/repos/${owner}/${repo}/contents/${cleanPath}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    return { path, sha: result?.content?.sha || "", changed: true };
  }

  async appendUnique(path, block, message) {
    const remote = await this.getFile(path);
    const current = String(remote.content || "").trimEnd();
    const nextBlock = String(block || "").trim();
    if (!nextBlock) return { path, sha: remote.sha, changed: false };
    if (current.includes(nextBlock)) return { path, sha: remote.sha, changed: false };
    const next = current ? `${current}\n\n${nextBlock}\n` : `${nextBlock}\n`;
    return this.putFile(path, next, message);
  }
}
