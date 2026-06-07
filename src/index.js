import express from "express";
import { assertRequiredConfig, config } from "./config.js";
import { MiniMaxClient } from "./minimax.js";
import { createStorage } from "./storage.js";
import { TelegramCompanionBot } from "./telegram.js";
import { setupAdminRoutes } from "./admin.js";

assertRequiredConfig();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "telegram-minimax-companion",
    health: "/health",
    admin: "/admin"
  });
});
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: config.minimaxModel,
    storage: config.databaseUrl ? "postgres" : "json-file"
  });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Health server listening on 0.0.0.0:${config.port}`);
});

const storage = createStorage(config);
await storage.init();

setupAdminRoutes(app, { config, storage });

const minimax = new MiniMaxClient(config);
const telegramBot = new TelegramCompanionBot({ config, storage, minimax });
await telegramBot.start();
