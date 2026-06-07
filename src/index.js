import express from "express";
import { assertRequiredConfig, config } from "./config.js";
import { AIClient } from "./ai-client.js";
import { createStorage } from "./storage.js";
import { TelegramCompanionBot } from "./telegram.js";
import { setupAdminRoutes } from "./admin.js";
import { GitHubMemoryBackup } from "./github-backup.js";

assertRequiredConfig();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "telegram-ai-companion",
    health: "/health",
    admin: "/admin"
  });
});
app.get("/health", (_req, res) => {
  const payload = {
    ok: true,
    storage: config.databaseUrl ? "postgres" : "json-file"
  };
  if (config.exposeModelInfo) {
    payload.model = config.aiModel;
    payload.compatibility = config.aiCompatibility;
  }
  res.json(payload);
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Health server listening on 0.0.0.0:${config.port}`);
});

const storage = createStorage(config);
await storage.init();

setupAdminRoutes(app, { config, storage });

const githubBackup = new GitHubMemoryBackup({ config, storage });
await githubBackup.start();

const ai = new AIClient(config);
const telegramBot = new TelegramCompanionBot({ config, storage, ai });
await telegramBot.start();
