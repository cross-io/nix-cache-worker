import { readFileSync, writeFileSync } from "node:fs";

const templatePath = process.argv[2] ?? "wrangler.integration.jsonc";
const outputPath = process.argv[3] ?? "wrangler.integration.generated.jsonc";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.D1_DATABASE_ID;

if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!databaseId) throw new Error("D1_DATABASE_ID is required");

const rendered = readFileSync(templatePath, "utf8")
  .replaceAll("__CLOUDFLARE_ACCOUNT_ID__", accountId)
  .replaceAll("__D1_DATABASE_ID__", databaseId);

if (rendered.includes("__CLOUDFLARE_") || rendered.includes("__D1_DATABASE_ID__")) {
  throw new Error("The integration Wrangler template still contains placeholders");
}

writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
