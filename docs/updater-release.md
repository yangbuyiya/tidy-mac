# 自动更新发布清单

更新时间：2026-06-07

## 当前状态

- 已安装 Tauri updater 插件：`tauri-plugin-updater`、`@tauri-apps/plugin-updater`。
- 已安装重启插件：`tauri-plugin-process`、`@tauri-apps/plugin-process`。
- 设置页已预留“自动更新”区域和“检查更新”入口。
- 尚未启用更新包生成，因为还没有签名密钥和 GitHub Release 元数据。

## 后续要补的配置

1. 生成 Tauri updater 签名密钥。

```bash
npm run tauri signer generate -- -w ~/.tauri/tidy-mac.key
```

2. 把生成的 public key 写入 `src-tauri/tauri.conf.json`。

```json
{
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLIC KEY",
      "endpoints": [
        "https://github.com/yangbuyiya/tidy-mac/releases/latest/download/latest.json"
      ]
    }
  }
}
```

3. 本机发布版本时运行签名发布命令。

```bash
npm run release:mac
```

4. GitHub Actions 发布前需要配置仓库 Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：`~/.tauri/tidy-mac.key` 文件内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；当前本机生成的是空密码，可以不填。

5. 自动发布 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

6. GitHub Release 需要包含：

- macOS DMG 安装包。
- macOS updater bundle。
- 对应 `.sig` 签名文件。
- `latest.json` 更新元数据。

## 注意事项

- 私钥不能提交到仓库。
- `.env` 不适用于 Tauri updater 签名私钥，发布时要使用真实环境变量。
- 没有 GitHub Release 里的 `latest.json` 之前，应用内检查更新会提示发布配置未完成。
