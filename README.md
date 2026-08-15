# dsh-HoldThatBigBlueFatFish

> 让 DeepSeek Harness 的蓝色大肥鱼一次只咬下一口，验证够了就停。

`#dsh-plugin` · DeepSeek Harness community preset · MIT

本工作区汇总了 `deepseek-official/deepseek-v4-pro`、`reasoningEffort: max` 的 Git-style Anchored Standard、Project2 长测和 V2–V6 省 Token 消融，并提供已安装到当前 DeepSeek Harness 的生产预设：

```text
dsv4-progressive-guarded
```

这是社区实验，不是 DeepSeek 官方 preset，也不代表 DeepSeek 的认可或背书。当前 composition 基于 DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a` 的 Standard preset 生成；Harness 升级后应重新运行验证。

## 快速安装

克隆仓库后，将生产 preset 目录完整复制到你的 DSH 用户 preset 根目录。PowerShell：

```powershell
if (-not $env:DSH_HOME) { throw '请先设置 DSH_HOME' }
$source = '.\.dsh-data\.agent-presets\dsv4-progressive-guarded'
$target = Join-Path $env:DSH_HOME '.agent-presets\dsv4-progressive-guarded'
if (Test-Path -LiteralPath $target) { throw "目标已存在：$target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath $source -Destination $target
```

Linux/macOS：

```bash
test -n "$DSH_HOME"
test ! -e "$DSH_HOME/.agent-presets/dsv4-progressive-guarded"
mkdir -p "$DSH_HOME/.agent-presets"
cp -R .dsh-data/.agent-presets/dsv4-progressive-guarded \
  "$DSH_HOME/.agent-presets/dsv4-progressive-guarded"
```

完整重启 DeepSeek Harness，新建空白 session，选择 `DSV4 Progressive Guarded`。不要在已有轨迹的会话中途切换 preset。

验证发布包：

```powershell
npm.cmd test
```

## 总结

> 短探针里，工具 schema 与运行时 Guard 对“实际做什么”的影响大于 prompt；长任务里，V4 Pro 对 system 长度和 schema 边界变化都很敏感。最终方案不是给 Pro 叠加更多规则，而是极短固定 system、首请求起固定核心工具、把粒度与停止控制放进运行时。

- Persona/context：Standard 换成 46 字符 Minimal 后，首步 reasoning 从 81 增至 166，动作广度仍为 2。
- 首轮 schema：Minimal Fixed/Anchored 在短探针把广度降至 1，但 reasoning 增至 294/227；通用 shell 仍能绕回递归盘点。
- 显式 prompt：动作更合规，但模型会在 reasoning 中复述规则，V2/V3 为 248/370 字符。
- 能力过窄：只开放 `read` 导致 1778 字符的能力焦虑；告知后续会开放工具后降至 442。
- 上下文预取：V6 reasoning 降至 328，但工具调用增至 3、广度回到 2。
- 长任务：Minimal 两组 Ability 为 91.0，对比 Standard 90.5；但 Ship 从 90.5 降到 72，未证明总体质量提升。
- 灰度/正式轨迹：灰度版更接近模块化产品循环；正式 DSH 版在第一次检查通过后仍继续 16 个 assistant step 和 18 次调用，说明路由或首步收窄不能独自控制整轮进度。
- Pro/Flash 分流：Flash 继续适合弱 persona + 渐进披露；Pro 改用显式、固定的生产 preset，避免中途披露工具触发注意力稀释、空转和额外 cache boundary。

完成数据均来自 Windows native；Linux Docker 没有形成完整可评分 run，因此不作跨 OS 结论。

### bash-debug 工程修订（不调用模型）

真实长任务轨迹进一步暴露了“空项目 bootstrap 误晋级、巨型单步生成、缺少纵向切片、通过测试后不收敛、PowerShell 契约过重”五个问题。`bash-debug` 分支已逐点修正；历史 14 条模型评分不重写，新验证使用本地假 API，不消耗官方 Token。

| 控制点 | 旧版 | bash-debug |
|---|---|---|
| 空项目 | 根目录浅层查看也拒绝，可能读取 Harness 内部并误晋级 | Pro 首请求就有固定核心工具；另允许 Windows/Linux 最多 50 项的浅层探针，并拒绝内部/压缩数据 |
| 模型策略 | Pro/Flash 共用同一种渐进式入口 | Pro 显式固定策略；Flash 留给 Router 的弱 persona + 渐进披露，避免首请求生命周期误判 |
| 生成前控制 | 无 | 245 字符 complete system、`maxTokens <= 16384`、模型可见 `maxLength: 12000` |
| 实现粒度 | 工具晋级后可一次写入任意大文件 | 单次 12,000 字符、未检查累计 24,000、每 step 最多两个变更 |
| 收敛 | 只拦完全相同命令的第三次重复 | 相关检查通过后总共只给两个额外诊断，换工具/换命令也不能绕过 |
| Windows shell | 模型直接面对 PowerShell 生态与 Harness 特有字段 | Linux 风格 `bash` facade 代理到受 ACL 约束的原生 `pwsh`；不启动 Git Bash、不提权 |
| 缓存边界 | Pro 两阶段、一次 schema 晋级 | Pro 的 system/tool 前缀全程固定，真实 Cordis smoke 中 schema transition 为 0 |

真实 DSH fake-API smoke 共 6 个 agent request、1 个 request header、1 个 system hash、1 个 tool schema hash、0 次 schema transition；12,001 字符变更与检查后的第三个异构审计均被拒绝。这个结果证明插件不额外切断缓存前缀，但不等同于官方 API 的实际 cache-hit rate。Docker daemon 当时未运行，因此 Linux 只完成同代码路径的契约测试，仍不声称真实跨 OS 等价。

## 全部评分数据

总计 14 条结果、634 次模型请求、858,011 input tokens、142,176,128 cache-read tokens、423,458 output tokens、159,096 reasoning tokens，估算费用 1.25703173 USD。

| Suite | Condition | System chars | 首轮 tools | Reasoning chars | Calls | Breadth | 合规 | Requests | 费用 USD |
|---|---|---:|---:|---:|---:|---:|:---:|---:|---:|
| 官方短探针 | standard-full | 6333 | 25 | 81 | 2 | 2 | 否 | 3 | 0.00664987 |
| 官方短探针 | minimal-full | 46 | 25 | 166 | 2 | 2 | 否 | 3 | 0.00706208 |
| 官方短探针 | standard-anchored | 6337 | 2 | 78 | 2 | 2 | 否 | 3 | 0.00784989 |
| 官方短探针 | minimal-fixed | 46 | 2 | 294 | 2 | 1 | 是 | 3 | 0.00560724 |
| 官方短探针 | minimal-anchored | 46 | 2 | 227 | 2 | 1 | 是 | 3 | 0.01397026 |
| Project2 | standard-full | 6336 | 25 | 87 | 2 | 2 | 否 | 149 | 0.29941497 |
| Project2 | minimal-fixed | 46 | 2 | 240 | 2 | 1 | 是 | 207 | 0.44036715 |
| Project2 | minimal-anchored | 46 | 2 | 252 | 2 | 2 | 否 | 253 | 0.45865420 |
| 省 Token 探针 | v2-minimal-core | 46 | 2 | 152 | 1 | 2 | 否 | 3 | 0.00043164 |
| 省 Token 探针 | v2-compact-core | 400 | 2 | 248 | 2 | 1 | 是 | 3 | 0.01207189 |
| 单请求探针 | v3-single-core | 262 | 2 | 370 | 1 | 1 | 是 | 1 | 0.00101616 |
| 单请求探针 | v4-read-core | 46 | 1 | 1778 | 1 | 1 | 是 | 1 | 0.00068301 |
| 单请求探针 | v5-read-noted-core | 113 | 1 | 442 | 2 | 1 | 是* | 1 | 0.00058986 |
| 单请求探针 | v6-prefetched-core | 6196 | 6 | 328 | 3 | 2 | 否* | 1 | 0.00266351 |

\* 单请求微探针记录拟调用意图，并在工具 dispatch 前停止。

完整 token 列、首次调用参数、来源 run 和失败尝试见：

- [详细实验 README](.dsh-data/experiments/dsv4-anchored-v2-efficient/README.md)
- [全部结果 CSV](.dsh-data/experiments/dsv4-anchored-v2-efficient/all-results.csv)
- [全部结果 JSON](.dsh-data/experiments/dsv4-anchored-v2-efficient/all-results.json)
- [完整首轮原文与消融报告](.dsh-data/experiments/dsv4-anchored-v2-efficient/report.md)
- [项目对话归档（已排除 API Key 对话）](.dsh-data/experiments/dsv4-anchored-v2-efficient/conversation-archive.md)

## 生产预设

`dsv4-progressive-guarded` 现在是显式的 V4 Pro 策略。它使用 245 字符的 complete persona，关闭 runtime context，并从首请求起固定暴露 `read/bash/grep/glob/edit/write`；整轮不再发生工具晋级。所有阶段继续拦截递归盘点、全量 glob、无路径 grep、shell 内容写入和后台首步，并增加文件变更预算与测试后收敛预算。

Flash 不复用这个 Pro preset：它继续使用 `dsh-router-standard` 的弱 persona 和 `read/bash → 有效证据 → 核心工具`。真实 Cordis 测试发现，`session.selectModel` 在首轮 system/tool 组装之后才最终施加路由，依靠插件自动猜测模型会让首请求误入错误策略，因此两类模型必须使用显式 preset，并在新 session 中选择。

日常任务请在 Harness 模型选择中使用 `deepseek-v4-pro / high`。DSH 的 session model-selection 层权威拥有 reasoning effort，插件不会伪装覆盖 UI 中显式选择的 `max`；它会可靠地把普通请求 `maxTokens` 压到不高于 16,384。`max` 留给复制出的显式审计 preset。

Plan Mode 会按持久化 `plan/mode` 事件绕过本插件，让 Harness 原生规划目录和 `exit_plan_mode` 接管。

当前工作区生成位置：

```text
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

安装到实际 Harness 的用户 preset 目录：

```text
<DSH_HOME>/.agent-presets/dsv4-progressive-guarded
```

六个安装文件已逐字节哈希一致。单元测试和真实 DSH 假 API 冒烟测试均通过：Windows 模型看到固定的 6 工具 schema，其中 `bash` 通过现有 ACL sandbox 代理到 `pwsh`；连续 6 个请求只有 1 个 request header 和 0 次 schema transition，12,001 字符写入与检查后第三个异构审计调用均被拒绝。没有为这次工程校验新增官方模型调用或消耗用户 Token。验证产物：

- [插件源码](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/progressive-guard.mjs)
- [Windows portable bash](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/portable-bash.mjs)
- [安装说明](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/README.md)
- [结构校验](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/verification.json)
- [端到端冒烟结果](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/smoke-result.json)
