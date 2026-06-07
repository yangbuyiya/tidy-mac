# AGENTS.md

## 项目约定

- 项目仓库名是 `tidy-mac`，应用中文名称保持为「清洁王」。
- 这是 Tauri 2 + React + TypeScript + Rust 的 macOS 桌面应用。
- 不要使用 Homebrew 安装工具，除非用户明确再次要求。尤其不要为了查看 GitHub Actions 安装 `gh`；优先用 GitHub API、网页链接或现有 GitHub 连接器确认状态。
- 不要提交本地构建产物、私钥、`.env`、`dist`、`target` 或 `src-tauri/target`。

## 发版要求

- 发布通过 GitHub Actions 的 `.github/workflows/release.yml` 完成。
- 推送 `v*` tag 会触发 Release workflow。
- GitHub Release 上传权限使用 Actions 自动提供的 `GITHUB_TOKEN` / `${{ github.token }}`，不需要本地配置个人 token。
- Tauri 自动更新必须使用签名私钥。仓库 Actions Secrets 里必须存在：
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 当前可以不配置，因为当前 key 没有密码。
- 私钥文件只允许保存在本机 `~/.tauri/tidy-mac.key` 或 GitHub Actions Secret，绝不能提交到仓库。

## Release Notes

- 更新简介维护在 `docs/release-notes.md`。
- `scripts/generate-latest-json.mjs` 会把 `docs/release-notes.md` 写入 `latest.json` 的 `notes` 字段。
- GitHub Release 的正文也必须使用 `docs/release-notes.md`，不要再写成 `清洁王 vX.Y.Z` 这种空简介。
- 每次发版前要更新 `docs/release-notes.md`，写清楚主要功能、修复、打包/更新变化。

## 发布资产命名

Release 资产必须使用专业、稳定、ASCII 的文件名，避免中文文件名在 GitHub Release 上传或自动更新下载时被截断或转义异常。

当前 macOS Apple Silicon 资产命名格式：

- `tidy-mac_<version>_aarch64.dmg`
- `tidy-mac_<version>_aarch64.app.tar.gz`
- `tidy-mac_<version>_aarch64.app.tar.gz.sig`
- `latest.json`

`latest.json` 中的下载 URL 必须指向：

```text
https://github.com/yangbuyiya/tidy-mac/releases/latest/download/tidy-mac_<version>_aarch64.app.tar.gz
```

不要让 updater 指向 Tauri 默认生成的中文名 `清洁王.app.tar.gz`。

## 本地验证

发版相关改动至少运行：

```bash
npm run build
```

如果改了 Tauri/Rust 配置或发布脚本，优先运行：

```bash
npm run release:mac
```

验证点：

- `src-tauri/target/release/bundle/latest.json` 存在。
- `latest.json` 的 `notes` 来自 `docs/release-notes.md`。
- `latest.json` 的 updater URL 使用 `tidy-mac_<version>_aarch64.app.tar.gz`。
- 本地生成了 `tidy-mac_<version>_aarch64.dmg`。
- 本地生成了 `tidy-mac_<version>_aarch64.app.tar.gz` 和 `.sig`。

## 发布流程

常规发布新版本时：

1. 更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号。
2. 更新 `docs/release-notes.md`。
3. 运行本地验证。
4. 提交并推送 `main`。
5. 创建并推送新 tag，例如：

```bash
git tag v0.1.1
git push origin v0.1.1
```

已有 tag 原则上不要强推覆盖。只有在首次发布校正、且用户明确同意修正同一个版本时，才可以 `git tag -f` 和 `git push --force origin <tag>`。

## 发布后检查

发布后用 GitHub API 或网页确认，不要为了检查状态安装 `gh`。

需要确认：

- GitHub Actions workflow 成功完成。
- Release 资产包含：
  - `latest.json`
  - `tidy-mac_<version>_aarch64.dmg`
  - `tidy-mac_<version>_aarch64.app.tar.gz`
  - `tidy-mac_<version>_aarch64.app.tar.gz.sig`
- Release 正文来自 `docs/release-notes.md`。
- `main` 和对应 tag 指向预期提交。

## README 要求

- README 顶部必须保留 Logo、项目名、中文简介、下载入口、更新日志、Issues 入口和徽章。
- README 必须说明技术栈、核心功能、开发命令、构建命令、自动更新要求和如何提交 Pull Request。
