import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const encoded = process.env.GROK_AUTH_JSON_B64 || "";
if (!encoded.trim()) {
  console.log("GROK_AUTH_JSON_B64 is not set; skipping Grok auth restore.");
  process.exit(0);
}

const home = os.homedir();
const grokDir = path.join(home, ".grok");
const authPath = path.join(grokDir, "auth.json");
fs.mkdirSync(grokDir, { recursive: true });

const json = Buffer.from(encoded, "base64").toString("utf8");
JSON.parse(json);
fs.writeFileSync(authPath, json, { mode: 0o600 });
console.log(`Grok auth restored to ${authPath}.`);
