# dsh-multimodel

`dsh-multimodel` 是 DeepSeek Harness 的按需多模态桥接插件。主模型仍由
DSH 路由；仅当会话出现图片时，插件才暴露 `perceive_media`，并通过独立的
Codex CLI 或 Claude Code CLI 读取图片。

## 与另外两者的区别

- 主仓库的 `dsv4-pro-contract-anchor` 是 agent preset，负责 Pro 的 system 与工具
  披露；本插件只增加按需视觉能力，不替换 DSH 主模型。
- `dsh-pwsh2wslbash` 是宿主 profile bundle，负责把 shell 工具送进 WSL；本插件
  不修改 shell，也不要安装到 `<DSH_HOME>/profiles/`。
- 本插件应复制到某个 preset 的 `plugins/dsh-multimodel/`。三者的选择表和完整安装
  顺序见 [v4preview README](https://github.com/NLeRWantFly/dsh-HoldThatBigBlueFatFish/tree/v4preview#三者区别)。

## 能力

- 在 provider 请求组装前将 `ImageBlock` 改写为可追溯的文本附件引用，避免
  `messages[*].image_url` 被纯文本 provider 拒绝。
- 同时净化用户图片和嵌套在 `tool/result` 中的图片。
- 从 DSH `AttachmentStore` 读取原始字节，并只在一次性目录中交给视觉 CLI。
- 可选 `readImageBridge: true`，由插件提供与纯文本 provider 兼容的 `read_image`，
  不需要修改 DSH 安装目录中的 `tool-fs` 包。
- 支持多轮覆盖检查、完成边界、会话恢复以及 Codex/Claude 后端切换。
- Codex 调用使用 `--` 终止可变长 `--image` 参数，避免提示词被吞掉。

## 安装

将整个目录复制到目标 preset：

```text
<preset>/plugins/dsh-multimodel/
```

然后把 [examples/agent.cordis.snippet.yml](examples/agent.cordis.snippet.yml)
中的服务行加入 `agent.cordis.yml`。使用 HoldThatBigBlueFatFish 的 Pro preset 时，
应以本插件替换原有的工具投影行，避免同时加载两套首轮投影器。

启用 `readImageBridge: true` 时，将同一 preset 的 `tool-fs.config.readImage` 设为
`false`，避免两个插件同时注册 `read_image`。`v4preview` 已完成这项配置，无需
修改 `<DSH_HOME>/profiles/node_modules`。

完整重启 DSH，并在新 session 中选择对应 preset。

如果三者全部安装，先安装 `dsh-pwsh2wslbash` profile bundle，再安装主 preset，
最后执行本节。所有修改完成后只需重启一次 DSH。

## 后端

默认使用 Codex。也可以在启动 DSH 前设置：

```powershell
$env:DSH_VISION_BACKEND = 'codex' # 或 claude
```

插件默认不覆盖 provider、model 或 profile，因此会继承当前 CLI 配置。Windows
下 Node 子进程必须能直接启动原生 `.exe`；Microsoft Store 的 WindowsApps
别名可能返回 `spawn EPERM`，这时应在配置中填写 npm 包内的原生 Codex 路径：

```yaml
codex:
  command: C:/Users/<user>/AppData/Roaming/npm/codex-real.exe
  configOverrides: []
```

该路径只是示例。也可使用任意可直接执行的原生 `codex.exe`。
`v4preview` 将复杂视觉任务的 `timeoutMs` 设为 `600000`；DSH 工具边界会自动
额外保留 5 秒完成清理与结构化结果封装。

## 验证

```powershell
npm.cmd test
```

测试覆盖桥接自带 `read_image`、动态工具投影、用户/工具结果图片净化、历史迁移、
`messages[*].image_url` 回归、多轮完成边界、Codex/Claude 参数构造，以及两个
假 CLI 的真实子进程往返。协议和结构化回包格式见 [PROTOCOL.md](PROTOCOL.md)。

## 边界

当前版本完整支持 DSH 的 PNG、JPEG、WebP 和 GIF 附件。音频和视频的协议字段
已经保留，但仍需要 DSH 上游提供持久化附件适配器。

## 来源

该目录在 `v4preview` 中以 `0.2.0-preview.1` 发布；preview preset 已内置同一份
代码，顶层副本用于接入其他 DSH preset。
