# dsh-HoldThatBigBlueFatFish

> 让 DeepSeek Harness 的蓝色大肥鱼一次只咬下一口，验证够了就停。

`#dsh-plugin` · **v0.2** · DeepSeek Harness community preset · MIT

本工作区汇总了 DeepSeek V4 Pro 的上下文、工具披露、缓存和停止行为实验。v0.2 提供两条明确分工的生产预设：

```text
dsv4-pro-anchored-96       Pro 高性能默认项：Minimal → 首次 shell/read → 完整 Standard
dsv4-progressive-guarded   防御项：固定核心工具 + mutation/diagnostic/stop budgets
```

这是社区实验，不是 DeepSeek 官方 preset，也不代表 DeepSeek 的认可或背书。当前 composition 基于当前机器安装的 DeepSeek Harness `@deepseek-ai/dsh@0.1.0-rc.6` 的 Standard preset 生成；Harness 升级后应重新运行验证。

## v0.2：改了什么，为什么

v0.1 的 Progressive Guard 能约束实际工具风险，却暴露了四个结构问题：Bootstrap 在空项目里容易误判证据；Guard 无法回收已经生成的巨型工具参数 Token；晋级后缺少实现粒度；重复命令检测不等于成功后的停止。继续堆 Guard 会增加拒绝循环，却不一定改善 Pro 的推理入口。

v0.2 因此把“高性能默认项”和“强 containment 防御项”拆开，并用完整 Project2 结果验证，而不是只看短探针：

| 控制面 | v0.1 / 中间方案 | v0.2 Pro 默认项 | 改动依据 |
|---|---|---|---|
| System/context | Standard 或 311 字符定制 persona；可能附带 runtime 信息 | 固定 46 字符 Minimal，`complete: true`，关闭 runtime context | Pro 对长 system 和额外运行时信息敏感；带真实构建样本达到 96、97 |
| 首次工具目录 | 固定 6 个核心工具，或依靠命令形式判断晋级 | 只投影原生 shell + `read` | 收窄初始注意力入口，同时允许空项目用 shell 建立最小证据 |
| 晋级条件 | 可能依赖“命令看起来成功”或易失状态 | 仅依据持久化 `tool/call`；下一请求恢复完整 Standard 目录 | 不把乱码、环境变量或 `tool/result` 误当有效项目证据；session reload 后结果一致 |
| 后续能力 | Guard 持续裁剪/拒绝 | 完整 Standard 工具恢复，system 仍保持 Minimal | Project2 需要编辑、搜索、测试和构建；过度裁剪会把风险从探索转成能力焦虑或绕行 |
| 构建环境 | Windows 没有原生 EIM 时误记 `E-build` | 官方 `espressif/idf:v6.0.1` Docker activation | 同一候选可真实编译；必须把宿主缺工具与模型代码失败分开 |
| 缓存 | 担心动态 schema 降低命中 | 全程 1 个 system hash、仅 2 个稳定 schema 状态 | 两次正式样本缓存命中率 99.4507% / 99.3384%，缓存不是当前瓶颈 |
| Guard | 作为所有 Pro 任务默认入口 | 高性能默认项不启用；强约束需求仍选择 Progressive | Guard 只能拦执行，拦不住调用参数生成；它也可能阻止必要的编译失败修复 |

这不是“删除约束”，而是把约束前移到模型请求组装：先稳定注意力入口，再恢复完整工程能力。运行时硬预算仍保留在 `dsv4-progressive-guarded`，供不可信仓库、严格成本上限或高风险自动执行场景选择。

### v0.2 完整评测

模型为 OpenCode Go 套餐的 `deepseek-v4-pro`，`reasoningEffort: max`；题面和评分器冻结在 Modeltest Project2 v4.1b。它们不是 DeepSeek 官方 API 样本。

| Run | Ability | Ship | Release | 请求 | 工具调用 | 输出 Token | 缓存命中率 | ESP-IDF |
|---|---:|---:|---|---:|---:|---:|---:|---|
| `04-05-25-418` | 96 | 96 | B+ | 184 | 220 | 101,252 | 99.4507% | real pass |
| `04-54-08-394` | **97** | **97** | B+ | 148 | 231 | 126,369 | 99.3384% | real pass |

97 分样本严格突破 96，并由官方 evaluator 归档 985,344 字节的 `stdpro.bin`；构建产物 SHA-256 为 `5551687f35305c3b8a0eca65702d3675e17137db35478d26429d6771d0782f75`。两次样本不足以宣称统计意义上的“稳定 97 下限”，但已证明该约束能完成真实构建并达到 97。

仍未解决的问题也必须明确：97 分样本首响应发出 4 个调用、广度 3；真实构建成功后仍消耗约 9.5k 输出 Token。v0.2 解决了初始注意力和构建证据，不声称已经解决 Pro 的全程扇出与停止判断。下一消融应只增加“首步执行预算”和“成功证据后的短 stop hint”，不能把隐藏测试答案写进 prompt。

- [v0.2 Pro 插件、安装器与测试](.dsh-data/experiments/dsv4-pro-anchored-96/)
- [完整 97 分报告](.dsh-data/experiments/dsv4-pro-anchored-96/report.md)
- [精简机器可读证据](.dsh-data/experiments/dsv4-pro-anchored-96/evidence/)

## 快速安装

克隆仓库后，将 v0.2 Pro 默认 preset 目录完整复制到你的 DSH 用户 preset 根目录。PowerShell：

```powershell
if (-not $env:DSH_HOME) { throw '请先设置 DSH_HOME' }
$source = '.\.dsh-data\.agent-presets\dsv4-pro-anchored-96'
$target = Join-Path $env:DSH_HOME '.agent-presets\dsv4-pro-anchored-96'
if (Test-Path -LiteralPath $target) { throw "目标已存在：$target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath $source -Destination $target
```

Linux/macOS：

```bash
test -n "$DSH_HOME"
test ! -e "$DSH_HOME/.agent-presets/dsv4-pro-anchored-96"
mkdir -p "$DSH_HOME/.agent-presets"
cp -R .dsh-data/.agent-presets/dsv4-pro-anchored-96 \
  "$DSH_HOME/.agent-presets/dsv4-pro-anchored-96"
```

完整重启 DeepSeek Harness，新建空白 session，选择 `DeepSeek V4 Pro Anchored v0.2`。不要在已有轨迹的会话中途切换 preset。需要持续硬预算时，改装同仓库的 `dsv4-progressive-guarded`。

验证发布包：

```powershell
npm.cmd test
```

## 总结

> 短探针里，工具 schema 与 Guard 更直接控制“实际做什么”；完整任务里，Pro 的能力上限更依赖极短固定 system、稳定的首次工具锚点和及时恢复完整能力。97 分证明两阶段 schema 可以工作，但后续停止仍需独立控制。

- Persona/context：Standard 换成 46 字符 Minimal 后，首步 reasoning 从 81 增至 166，动作广度仍为 2。
- 首轮 schema：Minimal Fixed/Anchored 在短探针把广度降至 1，但 reasoning 增至 294/227；通用 shell 仍能绕回递归盘点。
- 显式 prompt：动作更合规，但模型会在 reasoning 中复述规则，V2/V3 为 248/370 字符。
- 能力过窄：只开放 `read` 导致 1778 字符的能力焦虑；告知后续会开放工具后降至 442。
- 上下文预取：V6 reasoning 降至 328，但工具调用增至 3、广度回到 2。
- 长任务：Minimal 两组 Ability 为 91.0，对比 Standard 90.5；但 Ship 从 90.5 降到 72，未证明总体质量提升。
- 灰度/正式轨迹：灰度版更接近模块化产品循环；正式 DSH 版在第一次检查通过后仍继续 16 个 assistant step 和 18 次调用，说明路由或首步收窄不能独自控制整轮进度。
- Pro/Flash 分流：Flash 继续适合弱 persona + 渐进披露；Pro 使用显式选择的 Minimal Anchored preset，只发生一次由持久化事件决定的 schema 恢复。实际缓存命中高于 99.3%，没有出现此前担心的 cache 崩塌。
- v0.2 完整复验：Minimal Anchored 两个带真实构建样本为 96、97；缓存命中均高于 99.3%，因此当前瓶颈是后续扇出/停止，而不是 prefix cache。

完成数据均来自 Windows native；Linux Docker 没有形成完整可评分 run，因此不作跨 OS 结论。

### v0.2 防御轨道：bash-debug 工程修订

真实长任务轨迹进一步暴露了“空项目 bootstrap 误晋级、巨型单步生成、缺少纵向切片、通过测试后不收敛、PowerShell 契约过重”五个问题。`bash-debug` 分支已逐点修正；历史 14 条模型评分不重写，新验证使用本地假 API，不消耗官方 Token。

| 控制点 | 旧版 | bash-debug |
|---|---|---|
| 空项目 | 根目录浅层查看也拒绝，可能读取 Harness 内部并误晋级 | Pro 首请求就有固定核心工具；另允许 Windows/Linux 最多 50 项的浅层探针，并拒绝内部/压缩数据 |
| 模型策略 | Pro/Flash 共用同一种渐进式入口 | Pro 显式固定策略；Flash 留给 Router 的弱 persona + 渐进披露，避免首请求生命周期误判 |
| 生成前控制 | 无 | 311 字符 complete system、`maxTokens <= 8192`、模型可见 `maxLength: 12000` |
| 实现粒度 | 工具晋级后可一次写入任意大文件 | 单次 12,000 字符、未检查累计 24,000、每 step 最多两个变更 |
| 收敛 | 只拦完全相同命令的第三次重复 | 相关检查通过后总共只给两个额外诊断，换工具/换命令也不能绕过 |
| Windows shell | 模型直接面对 PowerShell 生态与 Harness 特有字段 | Linux 风格 `bash` facade 代理到受 ACL 约束的原生 `pwsh`；不启动 Git Bash、不提权 |
| 缓存边界 | Pro 两阶段、一次 schema 晋级 | Pro 的 system/tool 前缀全程固定，真实 Cordis smoke 中 schema transition 为 0 |

真实 DSH fake-API smoke 共 7 个 agent request、1 个 request header、1 个 system hash、1 个 tool schema hash、0 次 schema transition；12,001 字符变更与第三次重复检查均被拒绝。这个结果证明插件不额外切断缓存前缀，但不等同于官方 API 的实际 cache-hit rate。Docker daemon 当时未运行，因此 Linux 只完成同代码路径的契约测试，仍不声称真实跨 OS 等价。

## 历史 v0.1 消融数据

下表保留 v0.1 的 14 条官方 API/微探针结果，用来解释 v0.2 的设计来源；它不与上方 OpenCode Go 的 96/97 合并冒充同一 provider。历史数据共 634 次模型请求、858,011 input tokens、142,176,128 cache-read tokens、423,458 output tokens、159,096 reasoning tokens，估算费用 1.25703173 USD。

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

## 两个生产预设

`dsv4-pro-anchored-96` 是 v0.2 的 Pro 高性能默认项：46 字符 Minimal system、关闭 runtime context；首请求只显示原生 shell + `read`，出现第一个持久化 `tool/call` 后，下一请求恢复完整 Standard 工具。它没有动态 prompt、reasoning 分类器或工具 Guard。

`dsv4-progressive-guarded` 是防御项。它使用 311 字符 complete persona，关闭 runtime context，并从首请求起固定暴露 `read/bash/grep/glob/edit/write`；整轮不再发生工具晋级。它持续拦截根级递归盘点、全量 glob、无路径 grep、shell 内容写入和后台首步，并增加持久化阶段预算、环境失败隔离、文件变更预算与测试后收敛预算。该模式优先 containment，不以 97 分样本作为质量背书。

Flash 不复用这两个 Pro preset：它继续使用 `dsh-router-standard` 的弱 persona 和 `read/bash → 有效证据 → 核心工具`。真实 Cordis 测试发现，`session.selectModel` 在首轮 system/tool 组装之后才最终施加路由，依靠插件自动猜测模型会让首请求误入错误策略，因此两类模型必须使用显式 preset，并在新 session 中选择。

97 分评测固定使用 `deepseek-v4-pro / max`。日常任务的 reasoning effort 仍由 DSH 模型选择层决定：Anchored preset 不伪装覆盖 UI 选择，也不设置输出上限；Progressive 防御 preset 才把单次 `maxTokens` 压到不高于 8,192。需要质量上限时选择 Anchored，需要硬成本边界时选择 Progressive。

Progressive 的 Plan Mode 会按持久化 `plan/mode` 事件绕过其 Guard，让 Harness 原生规划目录和 `exit_plan_mode` 接管。

当前工作区生成位置：

```text
.dsh-data/.agent-presets/dsv4-pro-anchored-96/
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

安装到实际 Harness 的用户 preset 目录：

```text
<DSH_HOME>/.agent-presets/dsv4-pro-anchored-96
<DSH_HOME>/.agent-presets/dsv4-progressive-guarded
```

Anchored 的三文件发布目录与 97 分版本哈希一致：composition `d6957d9c…`、插件 `ea9526f…`。其单元测试、真实 DSH fake-API 冒烟、正式 Project2 和离线 replay 均通过。Progressive 的六个安装文件也逐字节哈希一致；Windows fake-API smoke 证明固定 6 工具 schema、portable `bash` 的 ACL 代理、12,001 字符写入拒绝与第三次重复检查停止均生效。验证产物：

- [插件源码](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/progressive-guard.mjs)
- [Windows portable bash](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/portable-bash.mjs)
- [安装说明](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/README.md)
- [结构校验](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/verification.json)
- [端到端冒烟结果](.dsh-data/experiments/dsv4-anchored-v2-efficient/production/smoke-result.json)
- [2026-08-16 收敛跟进报告](.dsh-data/experiments/dsv4-anchored-v2-efficient/followup-2026-08-16.md)
