# dsh-HoldThatBigBlueFatFish

> 让 DeepSeek Harness 的蓝色大肥鱼先拿一条证据，再动整片池塘。

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

> 工具 schema 与运行时 guard 对实际动作的影响大于 prompt；它们能约束仓库盘点风险，但当前实验没有证明能同步缩短模型内部 reasoning。

- Persona/context：Standard 换成 46 字符 Minimal 后，首步 reasoning 从 81 增至 166，动作广度仍为 2。
- 首轮 schema：Minimal Fixed/Anchored 在短探针把广度降至 1，但 reasoning 增至 294/227；通用 shell 仍能绕回递归盘点。
- 显式 prompt：动作更合规，但模型会在 reasoning 中复述规则，V2/V3 为 248/370 字符。
- 能力过窄：只开放 `read` 导致 1778 字符的能力焦虑；告知后续会开放工具后降至 442。
- 上下文预取：V6 reasoning 降至 328，但工具调用增至 3、广度回到 2。
- 长任务：Minimal 两组 Ability 为 91.0，对比 Standard 90.5；但 Ship 从 90.5 降到 72，未证明总体质量提升。

完成数据均来自 Windows native；Linux Docker 没有形成完整可评分 run，因此不作跨 OS 结论。

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

`dsv4-progressive-guarded` 使用短 Minimal persona。未取得证据时只暴露 `read + native shell`；成功的指定文件读取、明确测试或窄诊断后，下一请求恢复 `read/shell/edit/write/grep/glob`。所有阶段继续拦截递归/根目录盘点、全量 glob、无路径 grep、后台 shell 和无修改的重复命令。

Plan Mode 会按持久化 `plan/mode` 事件绕过本插件，让 Harness 原生规划目录和 `exit_plan_mode` 接管。

当前工作区生成位置：

```text
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

安装到实际 Harness 的用户 preset 目录：

```text
<DSH_HOME>/.agent-presets/dsv4-progressive-guarded
```

四个安装文件已逐字节哈希一致。单元测试和真实 DSH 假 API 冒烟测试均通过：首请求只有 `pwsh + read`，成功 read 后恢复 6 个核心工具，递归 shell 与 `**/*` glob 均被拒绝。验证产物：

- [插件源码](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/progressive-guard.mjs)
- [安装说明](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/README.md)
- [结构校验](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/verification.json)
- [端到端冒烟结果](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/smoke-result.json)
