# DeepSeek V4 Pro Max 首步约束实验汇总

本目录汇总 DeepSeek 官方 API 上已经完成的 Git-style 消融、Project2 长测和 V2–V6 省 Token 探针，并提供可直接放入 DeepSeek Harness 的生产预设 `dsv4-progressive-guarded`。

## 结论先行

1. **工具目录和运行时 guard 对实际行为的影响大于 prompt。** 仅把 Standard persona 换成 46 字符 Minimal persona，并未抑制仓库盘点；短探针 reasoning 反而从 81 增至 166 字符，广度仍为 2。
2. **缩小首轮工具面能 containment，但不等于缩短思考。** Minimal Fixed/Anchored 在短探针把广度从 2 降至 1，但首步 reasoning 分别升至 294/227 字符；长测中的 Minimal Anchored 又通过通用 shell 做递归盘点，说明只隐藏工具不够。
3. **约束文字越详细，模型越容易复述规则。** V2 Compact 与 V3 的动作更精确，但 reasoning 分别为 248、370 字符，均长于 Standard 的 81。
4. **工具过窄也会增加推理负担。** 只给 `read` 的 V4 达到 1778 字符；告知“成功读取后会开放工具”的 V5 降至 442，但仍显著高于 Standard。
5. **预取上下文不能代替运行时约束。** V6 已预取 onboarding，reasoning 降至 328，但模型重新生成 3 个广域调用，广度回到 2。
6. **长任务质量没有证明 Anchored 优于 Standard。** Ability 从 90.5 到 91.0，但 Ship 从 90.5 降到 72，Release 都是 B+，而请求数和费用明显增加。

因此，当前最可靠的产品结论是：

> 运行时 schema containment 有效；内部“先全面摸底”的思考倾向尚未被充分纠正。生产方案应使用短 Minimal persona、分阶段工具目录和跨阶段 hard guard，不应继续堆叠首步规则文字。

## 数据范围

- Provider：`deepseek-official`
- Model：`deepseek-v4-pro`
- Reasoning effort：`max`
- 已评分结果：14 条
- 模型请求：634 次
- Input tokens：858,011
- Cache-read tokens：142,176,128
- Output tokens：423,458
- Reasoning tokens：159,096
- 估算总费用：1.25703173 USD
- 完成环境：Windows native
- Linux Docker：本轮没有形成完整可评分 run，不能据此声称跨 OS 一致
- 两个早期启动尝试没有评分数据：`run-win-2026-08-15_03-10-55-462` 为空，`run-win-2026-08-15_03-11-19-451` 只有 preflight

机器可读总表见 [all-results.csv](all-results.csv) 和 [all-results.json](all-results.json)。前者适合表格分析，后者保留来源 run、失败尝试和总计。

项目讨论过程见 [conversation-archive.md](conversation-archive.md)。该归档保留可见用户/助手消息，排除内部 reasoning、工具输出、自动浏览器上下文和含真实 API Key 的对话片段，并对本机路径脱敏。

## 全部结果总表

`R chars/tok` 为第一条 assistant message 的 reasoning 字符数/本次 run 的 reasoning tokens；`I/C/O` 为 input/cache-read/output tokens；`Breadth` 越低越收敛。

| Suite | Condition | System chars | 首轮 tools | R chars/tok | Calls | Breadth | 合规 | Requests | I / C / O | 费用 USD |
|---|---|---:|---:|---:|---:|---:|:---:|---:|---:|---:|
| 官方短探针 | standard-full | 6333 | 25 | 81 / 23 | 2 | 2 | 否 | 3 | 14,026 / 19,328 / 550 | 0.00664987 |
| 官方短探针 | minimal-full | 46 | 25 | 166 / 186 | 2 | 2 | 否 | 3 | 14,850 / 16,640 / 623 | 0.00706208 |
| 官方短探针 | standard-anchored | 6337 | 2 | 78 / 45 | 2 | 2 | 否 | 3 | 16,974 / 11,008 / 490 | 0.00784989 |
| 官方短探针 | minimal-fixed | 46 | 2 | 294 / 89 | 2 | 1 | 是 | 3 | 11,207 / 8,064 / 808 | 0.00560724 |
| 官方短探针 | minimal-anchored | 46 | 2 | 227 / 247 | 2 | 1 | 是 | 3 | 30,261 / 24,064 / 827 | 0.01397026 |
| Project2 | standard-full | 6336 | 25 | 87 / 41,246 | 2 | 2 | 否 | 149 | 206,356 / 27,410,432 / 126,767 | 0.29941497 |
| Project2 | minimal-fixed | 46 | 2 | 240 / 71,538 | 2 | 1 | 是 | 207 | 254,806 / 51,558,272 / 163,940 | 0.44036715 |
| Project2 | minimal-anchored | 46 | 2 | 252 / 44,926 | 2 | 2 | 否 | 253 | 273,038 / 63,115,136 / 127,690 | 0.45865420 |
| 省 Token 探针 | v2-minimal-core | 46 | 2 | 152 / 63 | 1 | 2 | 否 | 3 | 328 / 6,272 / 306 | 0.00043164 |
| 省 Token 探针 | v2-compact-core | 400 | 2 | 248 / 103 | 2 | 1 | 是 | 3 | 26,732 / 6,656 / 482 | 0.01207189 |
| 单请求探针 | v3-single-core | 262 | 2 | 370 / 89 | 1 | 1 | 是 | 1 | 2,058 / 0 / 139 | 0.00101616 |
| 单请求探针 | v4-read-core | 46 | 1 | 1778 / 375 | 1 | 1 | 是 | 1 | 718 / 256 / 425 | 0.00068301 |
| 单请求探针 | v5-read-noted-core | 113 | 1 | 442 / 97 | 2 | 1 | 是* | 1 | 984 / 0 / 186 | 0.00058986 |
| 单请求探针 | v6-prefetched-core | 6196 | 6 | 328 / 69 | 3 | 2 | 否* | 1 | 5,673 / 0 / 225 | 0.00266351 |

\* V5/V6 是首条 assistant message 落盘即停止的微探针，记录的是模型拟调用意图，工具未实际 dispatch。

### Project2 官方评分

| Condition | Ability | Ship | Release | Blockers | 相对 Standard |
|---|---:|---:|:---:|---|---|
| standard-full | 90.5 | 90.5 | B+ | S-ambient; E-contract; E-build | 基线 |
| minimal-fixed | 91.0 | 72.0 | B+ | E-contract; E-build; P-report | Ability +0.5，Ship -18.5，+58 requests |
| minimal-anchored | 91.0 | 72.0 | B+ | E-contract; E-build; P-report | Ability +0.5，Ship -18.5，+104 requests |

Project2 说明了 containment 与最终交付质量是两个不同目标。Minimal 两组没有降低 Release class，但 Ship 明显退化；Minimal Anchored 相对 Standard 请求数增加约 70%，费用增加约 53%。单次长测只能作描述性复现，不代表统计显著。

## 各部分消融结论

### 1. Persona / runtime context

`standard-full → minimal-full` 保持 25 个工具不变，只缩短 system/context。广度没有变化，reasoning 从 81 增至 166。由此不能认为 Minimal prompt 本身能让模型渐进披露；它主要减少输入上下文，而非修正动作偏好。

### 2. 首轮工具 schema

两工具启动使 Minimal Fixed/Anchored 的短探针广度降至 1，证明 schema 能改变模型可表达的动作。但通用 shell 仍可承载递归枚举，且模型可能生成未暴露工具意图。因此 schema 是第一道 containment，不是完整安全边界。

### 3. Prompt 约束文字

V2 Compact 与 V3 明确写出“小动作、少调用、不要铺垫”后，动作更合规，但模型在 reasoning 中逐条复述契约。约束文本改善了外部形式，没有改善推理经济性。

### 4. 能力不确定性

V4 只暴露 `read`，模型花大量 reasoning 判断如何完成需要修改代码的任务。V5 仅增加一句后续会开放工具，就把 1778 降至 442，说明模型必须知道能力生命周期；但工具过窄的成本仍然存在。

### 5. 预取证据

V6 将 onboarding 预先注入并恢复核心工具，减少了能力焦虑，却重新激活目录盘点和并行扇出。信息更多不自然等于渐进披露，甚至会扩大首请求输入。

### 6. 长任务恢复能力

Git-style Anchored 确实能在持久化首个 `tool/call` 后恢复目录，但“产生调用”不是“取得有价值证据”。生产插件改为只有成功的指定文件读取、明确测试或窄范围诊断结果才能晋级，并在晋级后继续拦截广域盘点。

## 生产插件

生成目录：

```text
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

Preset ID：

```text
dsv4-progressive-guarded
```

它保留 Harness 原生工具注册，但按请求过滤模型可见目录：

```text
未取得合格证据：Minimal system + read + native shell
        成功窄读取/测试/诊断
取得合格证据后：Minimal system + read/shell/edit/write/grep/glob
```

全程运行时 guard 会拒绝：根目录或递归仓库盘点、全量 glob、无路径 grep、后台 shell、bootstrap 阶段写操作、首 step 第三个工具调用，以及没有修改时第三次重复同一 shell 命令。晋级由持久化 `tool/call + 成功 tool/result` 重算，会话重载不会丢失状态；插件不包含评测 stop，不会在真实任务前三条消息后退出。

Plan Mode 通过持久化 `plan/mode` 事件识别并绕过插件过滤，由 Harness 原生规划策略和 `exit_plan_mode` 工具接管。

实现与说明见 [production/progressive-guard.mjs](production/progressive-guard.mjs) 和 [production/README.md](production/README.md)。

## 安装与验证

在实验目录执行：

```powershell
$env:DSH_SOURCE_ROOT='C:\path\to\deepseek-harness'
node production\install.mjs
node production\tests.mjs
node production\smoke.mjs
```

`install.mjs` 从当前 Harness 的 Standard preset 复制原生工具注册和 schema，只替换 persona/context 并加入插件。假 API 端到端冒烟测试已验证：首请求工具为 `pwsh + read`，成功 read 后恢复 6 个核心工具，两个广域盘点调用均返回 `PROGRESSIVE_INVENTORY_BLOCKED`。结果保存在 [production/smoke-result.json](production/smoke-result.json)。

## 复现

重新生成总表：

```powershell
node aggregate-results.mjs
```

离线 replay 不调用模型：

```powershell
node runner.mjs replay --run runs\run-win-probe-2026-08-15_06-10-23-199
node runner.mjs replay --run runs\run-win-micro-2026-08-15_06-22-58-480
node runner.mjs replay --run runs\run-win-micro-v4-2026-08-15_07-26-13-393
node runner.mjs replay --run runs\run-win-micro-v5-2026-08-15_07-29-28-445
node runner.mjs replay --run runs\run-win-micro-v6-2026-08-15_07-39-50-668
```

V2–V6 均未同时满足“breadth 严格低于 Standard 且 reasoning 严格短于 Standard”的预设门槛，因此没有额外消耗 token 启动新的 Project2 长测。详细首轮原文和评分过程仍保存在 [report.md](report.md)。
