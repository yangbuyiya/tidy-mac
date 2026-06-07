import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const owner = "yangbuyiya";
const repo = "tidy-mac";
const updaterAssetName = "清洁王.app.tar.gz";
const signaturePath = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  `${updaterAssetName}.sig`,
);
const outputPath = join(root, "src-tauri", "target", "release", "bundle", "latest.json");
const encodedAssetName = encodeURIComponent(updaterAssetName);
const url = `https://github.com/${owner}/${repo}/releases/latest/download/${encodedAssetName}`;
const signature = readFileSync(signaturePath, "utf8").trim();

const latest = {
  version: packageJson.version,
  notes: `清洁王 v${packageJson.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature,
      url,
    },
    "darwin-aarch64-app": {
      signature,
      url,
    },
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Generated ${outputPath}`);
