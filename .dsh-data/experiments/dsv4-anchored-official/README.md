# DeepSeek 官方 API Git-style Anchored Standard 实验

该实验独立实现两阶段请求目录：Minimal system 全程固定；第一次模型请求只暴露 `read` 与当前 OS 的原生 shell；session 日志出现第一个持久化 `tool/call` 后，下一次模型请求恢复完整 Standard 工具。它不分析 assistant 文本/reasoning，不插入 continuation，不以 `tool/result` 或内存状态晋级，也不在主 Anchored 条件增加工具 guard。

冻结题面和官方评分器来自相邻实验中保存的 Project2 checkout：

```text
../dsv4-first-action/project2/modeltest
commit 04255b55f16c4439e538239fb9783070c4165081
```

外部 checkout 只提供题面、公开 handoff 和官方 evaluator；preset、请求过滤器、runner、评分汇总与验证器都在本目录实现。

## 安全前提

对话里出现过的 API key 必须先轮换。新 key 只通过启动 DSH Host 与 runner 的进程环境 `DEEPSEEK_API_KEY` 提供。脚本不会读取或创建 `.env`、credentials YAML，也不会把 key 写入命令参数、manifest、事件和报告。每次保存事件前执行疑似 key 检测，run 完成后再次扫描全部产物。

官方路由固定为：

```text
provider: deepseek-official
model: deepseek-v4-pro
reasoningEffort: max
baseURL: https://api.deepseek.com
```

## 生成并离线验证 preset

在本目录执行：

```powershell
node prepare-presets.mjs
node tests.mjs
node verify.mjs
node runtime-smoke.mjs
node handoff-tests.mjs
```

`prepare-presets.mjs` 从指定 DSH source commit 的 shipped Standard 配置确定性生成五个用户 preset。它不会读取 Git 分析仓库中的 preset 实现。`runtime-smoke.mjs` 使用本地假 API 真实启动 DSH，验证 25 工具 Standard、两工具首请求、持久 `tool/call` 后下一请求晋级、Minimal system 不变、Minimal Fixed 不晋级，以及探针精确停在第三条 assistant message；它不调用外网模型。

## Windows 在线矩阵

先在一个终端只为当前进程设置轮换后的 key 并启动隔离 Host：

```powershell
$env:DEEPSEEK_API_KEY = '<rotated key>'
.\start-windows-host.ps1
```

在第二个终端设置相同进程变量后执行固定五个短探针和三个 Project2 长测：

```powershell
$env:DEEPSEEK_API_KEY = '<rotated key>'
$env:DSH_EVAL_PLATFORM = 'windows-native'
$env:DSH_EVAL_BASE_URL = 'http://127.0.0.1:3090'
node reproduce.mjs live
```

Windows 长测顺序固定为 `Standard → Minimal Fixed → Minimal Anchored`。

## Linux Docker 在线矩阵

Docker Host 使用 tmpfs DSH home，不挂载 credentials 文件。宿主当前进程的 key 通过容器进程环境传入：

```powershell
$env:DEEPSEEK_API_KEY = '<rotated key>'
docker compose up -d --build
$env:DSH_EVAL_PLATFORM = 'linux-docker'
$env:DSH_EVAL_BASE_URL = 'http://127.0.0.1:3091'
$env:DSH_EVAL_DOCKER_CONTAINER = 'dsv4-anchored-official-linux'
node reproduce.mjs live
```

Linux 长测顺序固定为 `Minimal Anchored → Standard → Minimal Fixed`。

## 中断恢复、回放和验证

网络、额度或 Host 中断后，只补尚未成功的 sample；已有成功 id 不会重跑：

```powershell
node reproduce.mjs resume --run <run-directory>
```

回放不调用模型或 evaluator，并在覆盖前断言新生成的 `scores.json` 与保存版本逐字节一致：

```powershell
node reproduce.mjs replay --run <run-directory>
node verify.mjs --run <run-directory>
```

跨 OS 汇总：

```powershell
node aggregate.mjs --windows <windows-run> --linux <linux-run>
```

每个 run 保存 `manifest.json`、规范化 JSONL、`scores.json`、前三次 assistant reasoning/text/tool-call、晋级证据、官方 evaluator 目录、`project2-results.json`、`verification.json` 与 `report.md`。在线 API 没有确定性 seed，因此稳定复现指相同结构约束再次满足判据；只有离线 replay 要求字节级一致。

## 单独运行子矩阵

调试时可用 `probe-live` 或 `project2-live`。正式报告使用 `live` 的完整 8 sample/OS 矩阵；调试样本不并入正式对照。

DeepSeek V4 Pro 的模型、工具调用与计费信息以[官方模型与价格页](https://api-docs.deepseek.com/quick_start/pricing)和[Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)为准。价格快照固定在 `pricing.json`，避免 replay 因未来价格变化而漂移。
