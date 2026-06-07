import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const owner = "yangbuyiya";
const repo = "tidy-mac";
const sourceUpdaterAssetName = "清洁王.app.tar.gz";
const releaseAssetBaseName = `tidy-mac_${packageJson.version}_aarch64`;
const dmgAssetName = `${releaseAssetBaseName}.dmg`;
const updaterAssetName = `${releaseAssetBaseName}.app.tar.gz`;
const macosBundleDir = join(root, "src-tauri", "target", "release", "bundle", "macos");
const dmgBundleDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
const sourceUpdaterPath = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  sourceUpdaterAssetName,
);
const sourceSignaturePath = `${sourceUpdaterPath}.sig`;
const updaterPath = join(macosBundleDir, updaterAssetName);
const signaturePath = `${updaterPath}.sig`;
const outputPath = join(root, "src-tauri", "target", "release", "bundle", "latest.json");
const releaseNotesPath = join(root, "docs", "release-notes.md");
const encodedAssetName = encodeURIComponent(updaterAssetName);
const url = `https://github.com/${owner}/${repo}/releases/latest/download/${encodedAssetName}`;
const sourceDmgName = readdirSync(dmgBundleDir).find(
  (name) => name.endsWith(".dmg") && !name.startsWith("tidy-mac_"),
);

if (!sourceDmgName) {
  throw new Error(`Could not find generated DMG in ${dmgBundleDir}`);
}

copyFileSync(join(dmgBundleDir, sourceDmgName), join(dmgBundleDir, dmgAssetName));
copyFileSync(sourceUpdaterPath, updaterPath);
copyFileSync(sourceSignaturePath, signaturePath);

const signature = readFileSync(signaturePath, "utf8").trim();
const releaseNotes = readFileSync(releaseNotesPath, "utf8").trim();

const latest = {
  version: packageJson.version,
  notes: releaseNotes,
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
