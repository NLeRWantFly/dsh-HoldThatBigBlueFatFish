# DSV4 Pro Stable Guarded（bash-debug）

这是可直接安装到 DeepSeek Harness 的 V4 Pro 生产预设。它不再把 Router 的两阶段工具晋级直接套在 Pro 上，而是采用：

```text
极短且固定的 complete system
+ 首请求即固定的 6 工具核心目录
+ system/tool schema 全程不变
+ 运行时纵向切片与收敛 Guard
```

V4 Flash 仍适合 `dsh-router-standard` 的弱 persona 与渐进披露；本 preset 明确固定 `modelPolicy: pro`。不要在同一会话中把它从 Pro 切到 Flash。

## 为什么从“渐进披露”改成“稳定前缀”

公开保存的两组轨迹表明，灰度版更接近：

```text
产品目标 → 模块化纵向切片 → 真实环境验证 → 针对观察结果润色 → 停止
```

正式 DSH 轨迹则更接近：

```text
穷尽式设计 → 巨型单次生成 → 环境受阻 → 自建验证设施 → 系统纠错 → 过量审计
```

正式轨迹的第一步约 10,596 reasoning token；一个 step 约 49,838 output token，并生成约 71 KB、1,792 行单文件。第一次完整模拟测试通过后仍有 16 个 assistant step、18 次工具调用和 12,144 reasoning token。它的纠错能力强，但“验证足够后仍继续枚举风险”才是主要效率损失。

进一步的用户反馈指出：Pro 在零 system 或极简 system 下表现更好，却会在中途突然披露完整工具目录后出现注意力稀释和工具空转。Flash 对 prompt 规则与 schema 晋级更耐受，Pro 则对上下文内容和边界变化更敏感。因此当前策略不是继续增加 prompt 条款，而是让 Pro 的前缀从第一次请求起保持稳定。

## Pro 的固定上下文

普通模式的 complete persona 只有 245 个字符，且不加载 Harness identity 或 runtime snapshot：

```text
You are a helpful software engineer assistant.
Work only on the next runnable slice using existing evidence. Make one bounded change, run one relevant check, then finish. Never repair the harness or toolchain. If PROGRESSIVE_FINAL_REQUIRED appears, stop tool use and report evidence and remaining risk.
```

设置保持：

```yaml
complete: true
includeRuntimeContext: false
```

首请求和所有后续请求都暴露同一组工具：

```text
read + bash + grep + glob + edit + write
```

这里不采用“零工具 → 全工具”，也不采用“read/bash → 全工具”。对复杂生产任务，零工具不足以完成工作，而请求中途改变 schema 又正是 Pro 的敏感点。固定的精简核心目录是能力、注意力和缓存之间的折中。

## 五个问题的逐点修正

| 问题 | 当前行为 |
|---|---|
| 空项目与 bootstrap 冲突 | Pro 从首请求起即可 `write/edit`，同时允许最多 50 项的根目录浅层探针；读取 `DSH_*`、压缩 session 或二进制内容会被拒绝。 |
| Guard 拦不住已生成的 Token | 请求 `maxTokens` 不高于 16,384；`write.content` 与 `edit.new_string` 的模型可见 schema 加入 `maxLength: 12000`；短 system 在生成前要求只做下一个可运行切片。 |
| 晋级后出现单文件大爆发 | Pro 不再晋级；单次文件变更最多 12,000 字符、未检查累计最多 24,000 字符、每 step 最多两个变更。shell 内容重定向被拒绝。 |
| Repeat Guard 不是 Stop Guard | 最近一次相关检查成功后总共只允许两个额外诊断；第三次即使换命令或改用 `read/grep` 仍会拒绝。失败检查或实际修复会重新打开窗口。 |
| Windows shell 训练分布不匹配 | 模型看到 Linux 风格 `bash`，但执行仍代理到 DSH 原生、受 ACL 约束的 `pwsh`；不启动 Git Bash，不使用 `danger-full-access`，不绕过 sandbox。 |

Guard 仍只能阻止工具执行，不能退还模型已经生成的参数 token。因此生成前控制来自固定输出上限、短 system 和参数长度 schema；Guard 是最后一道一致性校验，而不是 token 控制器。

## Windows portable bash

Windows 适配器只提供一小组可移植开发命令：`git`、`rg`、`node`、`npm/npx/pnpm/yarn`、`python/pytest`、`cargo`、`go`、`dotnet`、`cmake/ctest/make` 与 `pwd`。它还把两个有上限的浅层探针确定性翻译为 PowerShell：

```bash
find . -maxdepth 1 -mindepth 1 -print | head -n 50
ls src | head -n 50
```

POSIX 脚本、shell 变量、重定向、任意管道、`cat/sed/awk` 和 sandbox escalation 均不支持。源码读写应优先使用 `read/grep/glob/edit/write`。这只是 Linux 风格工具入口，不是假装 Windows 已变成完整 Linux 环境。

## 缓存与真实 Cordis smoke

本地 fake-API smoke 会经过真实 Cordis preset 组装、请求 header、持久事件、工具执行和 Guard，但不调用 DeepSeek 官方 API。Windows 结果为：

| 指标 | 结果 |
|---|---:|
| 连续 agent requests | 6 |
| request headers | 1 |
| system hashes | 1 |
| tool schema hashes | 1 |
| schema transitions | 0 |
| shell schema bytes（首请求/后续） | 1,037 / 1,037 |
| 12,001 字符 mutation | 已拒绝 |
| 通过检查后的第三次异构审计 | 已拒绝 |

这证明插件自身不再制造 system/tool cache boundary；它不等于官方 API 的实际 cache-hit rate。真实命中率还取决于 provider 的缓存规则、消息前缀、会话历史和请求参数。要测实际缓存，必须另外读取官方 usage 的 cache 字段，不能从本 smoke 推断。

## 与 Flash 的边界

DSH 的 `session.selectModel` 路由在首轮 system/tool 组装之后才最终注入请求。真实 smoke 已证明，插件若只读取 `AgentOptions.model`，首请求会误判模型；依赖监听器顺序自动切 Pro/Flash 也不可靠。因此：

- 本 preset 在配置中显式固定 `modelPolicy: pro`，保证首请求可复现；
- Flash 使用独立的 Router preset，保留其弱 persona 和 `read/bash → 证据 → 核心工具`；
- 不在已有 session 中切换模型或 preset；新模型使用新 session。

这也解释了为什么“官方极简题满分”不能直接外推到生产：官方题边界清晰、工具依赖较少；生产任务需要持续编辑、真实验证、环境失败恢复和明确停止条件。Pro 的方案必须同时保留能力与稳定前缀。

## 安装

将整个目录复制到 Harness：

```text
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

然后完整重启 Harness，新建 session，选择：

```text
DSV4 Progressive Guarded
```

选择 `deepseek-v4-pro`。日常生产建议 `high`；需要显式深度审计时再选 `max`。插件不覆盖 UI/session 所选择的 reasoning effort，只把单次 `maxTokens` 压到不高于 16,384。

## 默认配置

```yaml
- id: dsv4-progressive-guard
  name: './progressive-guard.mjs'
  config:
    modelPolicy: pro
    shellTools: [bash]
    bootstrapTools: [read]
    coreTools: [read, edit, write, grep, glob]
    maxFirstStepCalls: 2
    bootstrapMaxEntries: 50
    blockBroadInventory: true
    blockInternalContext: true
    blockBootstrapWrites: true
    blockShellContentWrites: true
    maxMutationChars: 12000
    maxUnverifiedMutationChars: 24000
    maxMutationsPerStep: 2
    maxPostCheckCalls: 2
    maxPostPassMutations: 1
    maxPostPassDiagnostics: 2
    maxCallsWithoutProgress: 16
    maxEnvironmentFailuresPerCheck: 2
    maxTotalToolCalls: 80
    maxAssistantSteps: 64
    repeatLimit: 2
    requestMaxTokens: 8192
```

`bootstrapTools` 与语义晋级逻辑仅为 Flash/兼容性路径保留；在显式 Pro 策略下，从首请求起就是固定 core schema。Plan Mode 继续绕过过滤、Guard 和请求整形，由 Harness 原生规划策略接管。

## 验证

```powershell
node production\model-policy.tests.mjs
node production\portable-bash.tests.mjs
node production\tests.mjs
$env:DSH_SOURCE_ROOT='C:\path\to\deepseek-harness'
node production\install.mjs
node production\verify.mjs
node production\smoke.mjs
```

全局 npm 安装布局下：

```powershell
node production\model-policy.tests.mjs
node production\portable-bash.tests.mjs
node production\tests.mjs
$env:DSH_SOURCE_ROOT=(Join-Path (npm root -g) '@deepseek-ai\dsh')
node production\install.mjs
node production\verify.mjs
node production\smoke.mjs
```

单元测试覆盖模型策略、Windows/Linux 浅层探针、错误结果、不可信 session、变更预算、跨工具 stop、Plan Mode、请求上限和 HMR dispose。`smoke.mjs` 不消耗官方模型 token。

## 2026-08-16 收敛控制更新

OpenCode Go / V4 Pro Max 的 Project2 运行在人工截停前达到 210 次请求和 271 次工具调用。缓存稳定性已经健康（单一 system hash、单一 tool-schema hash、99.34% 输入缓存命中率）；剩余瓶颈是工作流无法收敛。

本次更新加入了完全由持久事件推导、会话重载后仍一致的控制，同时不在请求间改变工具 schema：

- 已完成但失败的检查会开启新的修复切片；Guard 拒绝不会伪装成项目证据；
- 连续十六次已执行诊断没有 mutation 或 check 时，必须推进、检查或结束；Guard/portable-bash 拒绝不消耗该预算，但仍计入绝对总调用上限；明确子目录的浅层查看和至少两级锚定的递归 glob 正常允许；
- runtime 版本、可执行文件位置和 `.venv/.pytool` 探测直接拒绝；同一检查或同一 runtime family 出现两次环境失败后，禁止继续重试；
- 禁止修改生成的 Python runtime、依赖缓存及 Harness bootstrap 文件；
- 检查通过后只允许一次直接相关的 mutation，随后必须复验或结束；
- 会话达到 80 次工具调用或超过 64 个 assistant step 后停止工具使用；
- 单次请求输出上限降至 8,192 token，reasoning effort 仍由模型路由决定。

这些规则是运行时 containment，不会把人工截停的评分变成可与自然完成样本比较的质量结果。
