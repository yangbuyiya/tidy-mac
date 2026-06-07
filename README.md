# tidy-mac

tidy-mac 是一个面向 macOS 的本地安全清理工具，中文名称为「清洁王」。它专注于扫描常见目录里的可清理文件，并在删除前保留人工确认流程。

## 功能

- 扫描下载、桌面、文稿和用户目录。
- 支持按后缀扫描指定类型文件。
- 按文件夹、空文件、缓存目录、日志文件、大文件、重复文件、安装包、压缩包、截图、录屏视频和旧文件分类查看。
- 标记安全、需确认和高风险文件，避免误删关键路径。
- 支持勾选扫描范围并保存到本机设置。
- 使用系统废纸篓删除文件，保留恢复余地。
- 提供 macOS 完全磁盘访问引导。
- 内置版本号、GitHub 仓库入口、作者信息和签名自动更新。

## 技术栈

- Tauri 2：macOS 桌面应用容器、打包和自动更新。
- Rust：本地文件扫描、分类、重复文件哈希、系统调用和设置持久化。
- React 18 + TypeScript：桌面端界面。
- Vite：前端开发和构建。
- lucide-react：界面图标。
- Tauri updater/process plugins：签名更新检查、下载、安装和重启。
- walkdir、blake3、chrono、trash：目录遍历、文件哈希、时间判断和废纸篓删除。

## 开发

```bash
npm install
npm run tauri dev
```

前端开发服务默认运行在：

```text
http://127.0.0.1:1420/
```

## 构建

```bash
npm run build
npm run tauri build
```

macOS 发布构建：

```bash
npm run release:mac
```

发布脚本会生成：

- `tidy-mac_<version>_aarch64.dmg`
- `tidy-mac_<version>_aarch64.app.tar.gz`
- `tidy-mac_<version>_aarch64.app.tar.gz.sig`
- `latest.json`

## 自动更新

自动更新使用 Tauri updater。发布前需要在 GitHub 仓库的 Actions Secrets 中配置：

```text
TAURI_SIGNING_PRIVATE_KEY
```

当前签名 key 没有密码，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可以不配置。

发布说明维护在：

```text
docs/release-notes.md
```

GitHub Release 和 `latest.json` 都会使用这份内容。

## 发布流程

推荐通过 PR 合并代码后再发布版本。

```bash
git checkout main
git pull
git tag v0.1.0
git push origin v0.1.0
```

推送 `v*` tag 后，GitHub Actions 会自动打包、签名并上传 Release 资产。

## 如何提交 Pull Request

欢迎通过 Pull Request 参与 tidy-mac。建议按下面的方式操作：

1. Fork 当前仓库到自己的 GitHub 账号。
2. 从 `main` 新建功能分支，分支名尽量描述清楚改动内容，例如 `fix/settings-layout` 或 `feat/custom-scan-rule`。
3. 在本地完成代码、文档或配置修改。
4. 提交前至少执行一次检查：

```bash
npm run build
```

如果修改了 Rust/Tauri 侧代码，也建议执行：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

5. 提交 commit，commit message 用简短清晰的英文或中文说明即可。
6. Push 到自己的 fork，然后在 GitHub 上向本仓库的 `main` 分支发起 Pull Request。
7. PR 描述里请写清楚：
   - 改了什么。
   - 为什么要改。
   - 是否影响扫描、删除、自动更新或打包发布。
   - 已经跑过哪些检查命令。

不要在 PR 中提交本地构建产物、私钥、`.env`、`dist`、`target` 或 `src-tauri/target`。

## 作者

- 作者：杨不易
- 主页：https://github.com/yangbuyiya/
- 联系方式：WeChat yangbuyiya
