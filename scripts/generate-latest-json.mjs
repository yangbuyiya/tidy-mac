import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const owner = "yangbuyiya";
const repo = "tidy-mac";
const sourceUpdaterAssetName = "清洁王.app.tar.gz";
const appBundleName = "清洁王.app";
const releaseAssetBaseName = `tidy-mac_${packageJson.version}_aarch64`;
const dmgAssetName = `${releaseAssetBaseName}.dmg`;
const updaterAssetName = `${releaseAssetBaseName}.app.tar.gz`;
const macosBundleDir = join(root, "src-tauri", "target", "release", "bundle", "macos");
const dmgBundleDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
const appBundlePath = join(macosBundleDir, appBundleName);
const sourceUpdaterPath = join(macosBundleDir, sourceUpdaterAssetName);
const updaterPath = join(macosBundleDir, updaterAssetName);
const signaturePath = `${updaterPath}.sig`;
const dmgPath = join(dmgBundleDir, dmgAssetName);
const dmgSourceDir = join(dmgBundleDir, "tidy-mac-dmg-src");
const outputPath = join(root, "src-tauri", "target", "release", "bundle", "latest.json");
const releaseNotesPath = join(root, "docs", "release-notes.md");
const encodedAssetName = encodeURIComponent(updaterAssetName);
const url = `https://github.com/${owner}/${repo}/releases/latest/download/${encodedAssetName}`;
const tauriBin = join(root, "node_modules", ".bin", "tauri");
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || "-";
const signerEnv = { ...process.env };
const localSigningKeyPath = join(homedir(), ".tauri", "tidy-mac.key");

if (!signerEnv.TAURI_SIGNING_PRIVATE_KEY && !signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  signerEnv.TAURI_SIGNING_PRIVATE_KEY = readFileSync(localSigningKeyPath, "utf8");
  signerEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = signerEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
}

if (!existsSync(appBundlePath)) {
  throw new Error(`Could not find app bundle at ${appBundlePath}`);
}

execFileSync("codesign", ["--force", "--deep", "--sign", signingIdentity, appBundlePath], {
  stdio: "inherit",
});

rmSync(sourceUpdaterPath, { force: true });
rmSync(`${sourceUpdaterPath}.sig`, { force: true });
rmSync(updaterPath, { force: true });
rmSync(signaturePath, { force: true });

execFileSync("tar", ["-czf", updaterPath, "-C", macosBundleDir, appBundleName], {
  stdio: "inherit",
});

execFileSync(tauriBin, ["signer", "sign", updaterPath], {
  stdio: "inherit",
  env: signerEnv,
});

rmSync(dmgSourceDir, { recursive: true, force: true });
mkdirSync(dmgSourceDir, { recursive: true });
execFileSync("cp", ["-R", appBundlePath, dmgSourceDir], { stdio: "inherit" });
symlinkSync("/Applications", join(dmgSourceDir, "Applications"));
rmSync(dmgPath, { force: true });
execFileSync(
  "hdiutil",
  ["create", "-volname", "清洁王", "-srcfolder", dmgSourceDir, "-ov", "-format", "UDZO", dmgPath],
  { stdio: "inherit" },
);
rmSync(dmgSourceDir, { recursive: true, force: true });

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
