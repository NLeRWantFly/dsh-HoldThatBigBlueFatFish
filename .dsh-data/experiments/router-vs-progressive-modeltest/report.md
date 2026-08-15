# DSH Router Standard 与 Progressive Guarded 对比报告

## 结论

两个项目的共同核心是“首请求使用较小工具目录，持久事件触发下一请求的 schema 晋级”，但优化目标不同：

- Router Standard 是行为路由器：根据首条用户消息把任务分到 spec / mixed / react / weak，替换 persona，并在首次持久化 `tool/call` 后恢复完整 Standard 工具。它优先保证能力与推进速度。
- Progressive Guarded 是执行约束器：固定短 persona，以成功文件读取、有限 probe 或明确检查作为晋级证据，晋级后也只开放六个核心工具，并在运行时限制盘点、mutation 与验收后的继续审计。它优先保证 containment、上下文经济性与收敛。

本次官方 Modeltest 不能给出完整质量胜负：Router 完成并得到 Ability 92.5 / Ship 92.5 / B+；Progressive 在第 74 个请求、首次代码修改之前收到 DeepSeek 官方 API `402 Insufficient Balance`。其 48 / 48 / D 是破损种子上的中途快照，不是插件最终成绩。

能可靠比较的是相同的前 74 个请求。Progressive 相对 Router：

- reasoning tokens `-45.75%`；
- output tokens `-48.95%`；
- cache-miss input tokens `-12.67%`；
- 估算费用 `-27.91%`；
- 工具调用却 `+12.63%`；
- mutation 从 15 次降为 0 次。

所以当前结论是：**Progressive 的上下文与输出约束有效，但生产推进效率失败；Router 的完成能力更强，但缺少真实执行边界。** 下一版应是二者的混合，而不是继续向 system prompt 堆规则。

## 证据与可比性

### 合并统计

按照用户要求，官方 API 与 OpenCode Go 证据合并在同一数据表，但保留 provider、effort、status 与 data-quality 标记。

| 证据组 | 行数 | 状态 | 请求/step | Cache-miss input | Cache read | Output | Reasoning | 费用 |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| DeepSeek 官方 API | 16 | 15 完成、1 个 402 删失 | 873 requests | 1,216,462 | 175,125,504 | 560,561 | 212,460 | $1.65167901 |
| OpenCode Go 历史游戏轨迹 | 1 | 用户提供的近似完整样本 | 47 assistant steps | 未记录 | 未记录 | 约 103,600 | 约 65,600 | 未记录 |

官方 API 总数横跨短探针、历史 Project2 和本次 Modeltest，只用于资产盘点，不能把不同题面的 Ability 做平均。OpenCode Go 行仅用于解释工程现象，未计入官方总数。完整字段见 [combined-results.json](combined-results.json) 与 [combined-results.csv](combined-results.csv)。

### 当前正式实验冻结项

| 项目 | 值 |
|---|---|
| Endpoint | `https://api.deepseek.com` |
| Provider | `deepseek-official` |
| Model | `deepseek-v4-pro` |
| Reasoning effort | `max` |
| 平台 | Windows native |
| Modeltest commit | `04255b55f16c4439e538239fb9783070c4165081` |
| Router commit | `d4655d5874883c6994721236f0ece97499570eac` |
| Progressive 起始 commit | `bd93020ad77ee3d0b981e8b626c1bb2d5923935a` |
| DSH commit | `47f943859bef60e4160492346772ded9b24f765a` |
| 冻结题面 SHA-256 | `aae0cfddc59474ec5ff52858a47e9949ba9ee5352ea45ea3b7bfb29a99732747` |
| 顺序 | Router → Progressive；每组新 session、新 handoff |

请求头证据确认正式样本全部使用官方 provider 与 max；没有使用 OpenCode 的 DeepSeek V4 Pro。DeepSeek 官方文档明确列出 V4 Pro 的 `high` / `max` thinking effort，以及前缀缓存计费机制：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[Context Caching](https://api-docs.deepseek.com/guides/kv_cache)。

## 设计共同性

二者都：

1. 保留 DSH 原生工具注册，在 system-prompt assembly 时过滤模型可见目录。
2. 使用 session 持久事件计算阶段，重载后不依赖一次性布尔值。
3. 首请求使用 native shell：Windows 为 `pwsh`，Linux 为 `bash`。
4. schema 只发生一次晋级，system/persona 在同一 session 内保持单一 hash，有利于缓存前缀稳定。
5. 晋级只影响下一次模型请求，不在同一 assistant response 中动态变更 schema。
6. 都试图减少 Standard 首步的广域摸底，而不永久剥夺工程能力。

## 设计区别与优缺点

| 维度 | Router Standard | Progressive Guarded | 优缺点判断 |
|---|---|---|---|
| 首要目标 | 任务自适应与交付能力 | 风险 containment、粒度和停止 | Router 更适合异质任务；Progressive 更适合成本/安全边界明确的工程任务 |
| 决策方式 | build/fix 关键词计数；优势方选 react/spec，平局或无命中选 weak | 无任务分类，统一状态机 | Router 灵活但正则脆弱；Progressive 可预测但不能区分任务形态 |
| Persona | spec/mixed/react/weak 四种路由、三种行为带 | 固定 272 字符纵向切片 persona | Router 能调风格；Progressive system 更短、更稳定 |
| 其他 system sections | 只替换 persona，保留 Standard 工具说明与 plan-mode section；清空 runtime contexts | complete persona，不装入 Standard 工具说明；runtime context 关闭 | Router 信息完整但首请求仍描述隐藏工具；Progressive 输入更省且不诱导隐藏能力 |
| 首轮工具 | 随模式变化；本题 weak 为 `read/write/edit + pwsh` | 固定 `read + pwsh` | Router 可立即修改；Progressive 更安全但 Windows bootstrap 容易停滞 |
| 晋级条件 | 任意首个持久化 `tool/call`，不看结果 | 成功读取、有限浅层 probe、明确检查等语义证据 | Router 恢复快但空调用也晋级；Progressive 可信但识别器过严/会误判 |
| 晋级后目录 | 完整 Standard，本次 28 工具 | 六个核心工具 `read/pwsh/edit/write/grep/glob` | Router 能处理复杂流程；Progressive 避免编排扩散，但可能缺少必要能力 |
| 执行边界 | 无 guard | 全阶段 guard | Router 隐藏 schema 不等于权限；Progressive 能真正阻止执行 |
| 生成上限 | 继承本次 256,000 maxTokens | 固定不超过 16,384 | Router 容许大产出；Progressive 能在生成前限制损失 |
| Mutation | 无大小、step 或检查间预算 | 12k/次、2 次/step、24k/两次检查间 | Progressive 防止 71 KB 单次爆发；过紧时也会降低吞吐 |
| 收敛 | 主要靠 persona；无硬 stop | 成功检查后只给两个额外诊断调用 | Progressive 能阻止换命令继续审计；验收集合必须定义正确，否则可能过早停止 |
| Agent 自调 | `dev_router_status/mode/subagent` | 无编排/自调工具 | Router 可观测但增加目录和状态面；override 仅内存态，恢复不可靠 |
| PowerShell | 完整 4,445-byte schema，任意 shell 语法 | 首轮投影到 1,038 bytes，并解析危险命令 | Progressive schema 小 76.6%，但正则解析 PowerShell 误伤明显 |

Router 的代码可见于 [router-core.mjs](https://github.com/yjh051108/dsh-router-standard/blob/d4655d5874883c6994721236f0ece97499570eac/preset/router-core.mjs) 与 [router-bootstrap.mjs](https://github.com/yjh051108/dsh-router-standard/blob/d4655d5874883c6994721236f0ece97499570eac/preset/router-bootstrap.mjs)。Modeltest 版本冻结在 [commit 04255b5](https://github.com/xiaobright/modeltest/tree/04255b55f16c4439e538239fb9783070c4165081)。

## Router 实现审计发现

### 1. weak guide 当前实际未生效

`router-bootstrap.mjs` 的 import 列表含 `bandFor`、`isComplexTask` 等，但事件 listener 调用了未导入的 `bandOf` 和 `extractText`。直接 preflight 得到：

```text
routerModeForModeltest=weak
bootstrapEventPath=ReferenceError: bandOf is not defined
```

真实 DSH runtime 会隔离 listener 异常，所以两次模型请求仍成功，首轮为四工具、下一请求恢复 28 工具；但预期的 weak near-field guide 没有加入 inbox。换言之，本次测到的是“Router persona + schema routing”，不是 README 所描述的完整 weak guidance。

### 2. 可见 schema 不是执行 ACL

Router 首请求 header 只显示 `edit/pwsh/read/write`，模型却在同一个 response 生成了隐藏的：

```json
{"name":"glob","arguments":{"pattern":"project2_task/**/*"}}
```

运行时仍注册所有 Standard 工具且没有 guard，因此该 `glob` 被实际执行。Standard system 又保留了 glob 的说明，这会提示模型一个 schema 中不存在、执行时却可用的能力。优点是鲁棒，缺点是首轮收敛没有安全边界。

### 3. 单测覆盖核心函数，没有覆盖真实 bootstrap

`node --test router.test.mjs` 的 15 项测试全部通过，但没有捕捉上述 import 缺陷。需要增加真实 Cordis/DSH assembly、`session/event`、隐藏工具 dispatch 与会话恢复集成测试。

### 4. 分类器把本题落到 weak

Modeltest 长中文提示同时含 build/fix 词，计数未形成优势，最终进入 `weak`。weak 的 Pro persona只要求模型自己再判断 build/fix；它不是语义分类器。正则适合廉价路由，但复杂任务容易被少量词频或多目标题面改变。

## 首请求对比

| 指标 | Router | Progressive | 差异 |
|---|---:|---:|---:|
| System chars | 6,273 | 272 | Progressive `-95.66%` |
| 可见工具数 | 4 | 2 | `-50%` |
| Schema bytes | 6,735 | 1,479 | `-78.04%` |
| pwsh schema bytes | 4,445 | 1,038 | `-76.65%` |
| 首请求 cache-miss input | 3,749 | 1,267 | `-66.20%` |
| 首请求 output tokens | 130 | 197 | Progressive `+51.54%` |
| 首请求 reasoning tokens | 13 | 13 | 相同 |
| 拟调用数 | 2 | 2 | 相同 |
| 广度 | 1 | 2 | Progressive 更差 |

保存的公开 reasoning 原文：

Router：

```text
Let me start by exploring the workspace structure to understand the project.
```

首调用是根目录浅列举，第二个是隐藏 schema 的 `glob("project2_task/**/*")`。

Progressive：

```text
Let me start by exploring the workspace and reading the required docs.
```

首调用是根目录浅列举，第二个是对 `project2_task, tests, reference, tools` 的 depth-2 递归列举；两者均被 Guard 拒绝。

这次首请求没有证明短 prompt 能减少 reasoning：两组都是 13 reasoning tokens。工具约束改变了可执行风险，却没有消除“先探索 workspace”的倾向。

## 官方 Modeltest 结果

### 完整/删失总表

| 条件 | 状态 | Requests | Tools | Mutations | Output | Reasoning | Cache miss | Cache read | 费用 | Ability / Ship / Release |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Router | 完成 | 165 | 188 | 81 | 116,007 | 41,303 | 213,981 | 29,044,736 | $0.29929499 | 92.5 / 92.5 / B+ |
| Progressive | 402 删失 | 74 | 107 | 0 | 21,096 | 12,061 | 144,470 | 3,904,640 | $0.09535229 | 中途快照 48 / 48 / D，不可作最终分 |

Router 修改约 30 个文件，官方 diff 为 99,174 字符 / 2,376 行。公开 tests 与 debug probe 最终成功；ESP-IDF 真编译在激活脚本缺失处失败，并被如实记录。最终成功验收出现在 assistant 163，之后只有 1 次工具调用，说明本次 Router 的长轨迹主要来自任务规模和环境准备，并非验收后无止境审计。

Progressive 共出现 11 次 Guard 拒绝：8 次 inventory、1 次内部上下文、2 次 shell-content-write。它在第 74 步找到 uv 缓存 Python 并运行公开测试，但从未进入 mutation，随后下一模型请求即被 402 终止。因此官方 evaluator 看到的仍基本是破损种子。

### Router 官方评分细节

| 项目 | 结果 |
|---|---|
| Hidden tests | 43 / 45 |
| ESP static | 7 / 9 |
| ESP build | failed：本机无激活脚本，evidence incomplete |
| Blockers | `M-fidelity`, `E-contract`, `E-build` |
| Dimensions | final_code 10；security 9.72；migration 8；esp_deploy 6.79；process_truth 10 |

两个 hidden 失败分别是 context-policy reason 不匹配，以及旧 SQLite `ts` 未从 `created_ts` 正确回填。ESP static 失败是 MQTT publish marker 与 Wi-Fi/UID readiness contract。

### 公平的前 74 请求窗口

| 指标 | Router 前 74 | Progressive 前 74 | Progressive 相对变化 |
|---|---:|---:|---:|
| Tool calls | 95 | 107 | `+12.63%` |
| Mutations | 15 | 0 | `-100%` |
| Output tokens | 41,322 | 21,096 | `-48.95%` |
| Reasoning tokens | 22,232 | 12,061 | `-45.75%` |
| Cache-miss input | 165,421 | 144,470 | `-12.67%` |
| 估算费用 | $0.13227431 | $0.09535229 | `-27.91%` |

这说明 `maxTokens=16,384`、短 system 和较小 schema 能压低生成成本；但 Guard 拒绝造成“换一种命令继续试”的循环，节省没有转化为产出。对当前版本最准确的评价是：**token containment 有效，productive efficiency 退化。**

## PowerShell 相对 Bash 的问题

问题不在 PowerShell 天生更差，而在通用 shell 的语法面很大，而现有 Guard 用正则近似解释它：

1. `Get-ChildItem reference` 与 `Get-ChildItem tools` 是明确子目录的浅列举，也因缺少精确 `Select-Object -First <= 50` 形式被拒绝。
2. `"$p => $(Test-Path $p)"` 与 JavaScript `r=>...` 被重定向正则误判为 `>` 写文件。
3. 模型面对 Windows Python launcher、uv cache、TEMP/TMP 权限需要更多环境诊断；这些命令变体绕开 repeat guard，却没有推进代码。
4. 投影后的短 pwsh schema 减少 76.6% 上下文，但没有告诉模型一个可直接复制的、保证通过 Guard 的 bounded-list 命令。

Bash 也会遇到 shell 字符串、管道、重定向和 `find` 的解析问题，只是语法通常更接近模型训练分布。长期方案不应继续扩大 PowerShell 正则，而应把 bootstrap 改成语义工具：

```text
read_named_file(path)
list_shallow(path, max_entries <= 50)
run_named_check(check_id)
```

Windows adapter 负责选择 uv/Python、设置 workspace-local TEMP/TMP；Linux adapter 选择等价 Python。模型不再生成平台相关启动命令，schema 也更短、更容易缓存。

## 缓存分析

Router 的全程 cache hit rate 为 99.27%，Progressive 为 96.43%，但不能据此说 Router 的缓存设计更优：长 session 会反复命中越来越长的历史前缀，天然抬高比率。

结构上两者都很好：各自只有一个 system hash、两个工具 schema hash。真正的 cache break 都只发生一次：

- Router 在第 2 请求由 4 工具晋级 28 工具；该请求 cache read 为 0、cache-miss input 10,568。
- Progressive 在第 7 请求由 2 工具晋级 6 工具；该请求 cache read 为 0、cache-miss input 7,748。

Progressive 较低的整体命中率主要来自短轨迹、不断新增的 glob/read 输出和 Guard 拒绝文本，而不是 system/schema 每步漂移。下一版保持以下原则即可：

- 固定 persona，不按 step 拼动态 system 文本；
- 固定 bootstrap/promoted 两套 canonical schema；
- 阶段从持久事件计算，但不要把状态说明重复注入 prompt；
- Guard 返回短、完全相同的错误码与一个可复制的合法动作；
- OpenCode Go adapter 与官方 API adapter 使用相同 canonical schema/hash，并在事件中明确 provider，避免跨 provider 误合并。

## OpenCode Go 历史证据

用户提供的历史游戏生成轨迹现已写入 [historical-opencode.json](historical-opencode.json)，并合并进入总表。它明确标注为 `opencode-go / deepseek-v4-pro / high / reported-approximate`：

| 指标 | 值 |
|---|---:|
| Assistant steps / tools | 47 / 55 |
| Output / reasoning tokens | 约 103,600 / 65,600 |
| Reasoning 占比 | 约 63.3% |
| 首步 reasoning | 约 10,596 tokens |
| 最大单步 | 约 49,838 tokens |
| 单文件主体 | 约 71 KB / 1,792 行 |
| 首次完整模拟测试后 | 16 steps、18 calls、17,078 output、12,144 reasoning |

该轨迹证明三件与当前官方样本一致的机制问题：Guard 在 dispatch 时拒绝已经无法回收生成 Token；限制探索宽度可能把风险转移成巨型单文件 mutation；repeat guard 不等于验收后的 stop。它不能证明 Router 与 Progressive 的 Modeltest 质量差，因为题面、provider、effort 与工具环境都不同。

## 下一版建议：Hybrid v0.3

1. 修复 Router 的 `bandOf/extractText` import，并增加真实 bootstrap 集成测试；在修复前不要把 near-field guide 的收益归到 Router。
2. 把“模型可见 schema”升级为执行 ACL：未出现在该 request header 的工具一律拒绝，杜绝 Router 首轮隐藏 `glob` 被执行。
3. 保留一次 schema 晋级，但首轮改为语义化 `read_named_file/list_shallow/run_named_check`，不再让模型自己写 PowerShell/Bash bootstrap。
4. 晋级条件使用成功结果与有效项目证据，而不是任意 `tool/call`；连续两次拒绝后返回一个精确合法调用，避免重试风暴。
5. 晋级后根据任务路由恢复能力：fix/spec 开 `read/edit/grep/glob/shell`，build/react 开 `read/write/edit/shell`；需要编排时再显式解锁，不默认恢复 28 工具。
6. 保留每响应 12k–16k token 上限、write/edit schema 长度限制和跨 step mutation 预算。这些约束发生在生成前，比追加 guard 规则更能省 Token。
7. 状态机显式化为 `bootstrap → diagnose → vertical-slice → validate → done`。每次 mutation 后要求一个相关检查；没有首个纵向切片前禁止批量铺开多个模块。
8. Stop 条件不是“任一测试成功”，而是用户题面声明的验收集合全部有结果。全部通过后只允许修复 blocker 或最多两个高风险审计动作。
9. OpenCode Go 可以作为部署/兼容适配器介入，但结果必须继续记录 provider 与 effort；正式效果回归仍优先用官方 API 固定路由。

## 复现与验证

离线回放已验证 `scores.json` 逐字节一致：

```text
77e1ccb159152c8a3658e5a1396406f339d2d706c594f887f3e8768e3a66b7e3
```

本地验证结果：

- Router core：15 / 15 pass；
- Progressive production tests：pass；
- Router direct preflight：按预期暴露 `ReferenceError: bandOf is not defined`；
- Router fake-DSH runtime smoke：2 次请求、首轮 4 工具、随后 28 工具、effort 均为 max；
- 当前分析脚本：能够识别 assistant 163 的最终公开 tests + debug probe 成功，成功验收后仅 1 个工具调用。

复现命令及环境变量见 [README.md](README.md)。补跑 Progressive 必须使用新 session 和全新 handoff，并只补缺失样本；不要重跑已成功的 Router，以免浪费额度。完整质量比较需等该样本完成后再更新结论。
