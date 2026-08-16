# DeepSeek V4 Pro Contract Anchor v0.3：99 分实验报告

## 结论

`dsh-pro-contract-anchor-v0.3` 在冻结的 Modeltest Project2 v4.1b 上得到 **Ability 99、Ship 99、Release A**。ESP-IDF 是真实构建通过，不是静态替代；官方评分器没有 blocker 或 behavior blocker。正式 v0.3.0 由已评测的 RC5 晋升，`contract-anchor.mjs` 内容及 SHA-256 均未改变。

这是一个完整、描述性的 99 分样本，不等同于“多次运行都稳定不低于 99”。它证明当前短提示词和两阶段工具入口能够达到 99 分，但尚未证明统计稳定性，也尚未解决长任务中的调用扇出。

## 实验配置

| 项目 | 值 |
|---|---|
| Run | `run-win-2026-08-16_13-28-24-373` |
| 平台 | Windows native；ESP-IDF 使用 `espressif/idf:v6.0.1` Docker activation |
| Provider | OpenCode Go 套餐（不是 DeepSeek 官方 API） |
| 模型 | `opencode-go/deepseek-v4-pro` |
| 推理深度 | `max` |
| Benchmark | Modeltest Project2 v4.1b |
| 条件 | `pro-contract-anchor` |
| 评测时 Harness | `dsh-pro-contract-anchor-v0.3-rc5` |
| 正式版本 | `dsh-pro-contract-anchor-v0.3` / `v0.3.0` |
| 终止原因 | `completed`，无预算截断 |

第一请求严格使用 46 字符 Minimal system：

```text
You are a helpful software engineer assistant.
```

首次只披露原生 shell 与 `read`。首个持久化 `tool/call` 后，下一请求恢复完整 Standard 工具，并附加固定的 491 字符工程契约：

```text
Security, migration, API/protocol, and release constraints are invariants. Use verified slices. Preserve legacy rows; backfill replacement fields before indexing. Never rename/remove existing identifiers, even static/private; if logic moves, leave exact-name wrappers. Keep protocol strings and dependency/API names literal. Use clean build roots; never replace integrations for toolchain failures. Complete requested reports before docs; skip optional docs. Stop after required checks pass.
```

这段契约只描述通用工程不变量，没有写入隐藏测试名称、答案或具体失败值。评分器只在候选完成后用于评分。

## 评测结果

| 指标 | 结果 |
|---|---:|
| Ability | **99** |
| Ship | **99** |
| Release class | **A** |
| Blockers | 0 |
| Behavior blockers | 0 |
| ESP-IDF | real pass |
| F9 | 6/6 |

| Family | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 | F12 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 得分 | 8 | 12 | 16 | 4 | 12 | 10 | 8 | 8 | 6 | 8 | 4 | 3 |
| 满分 | 8 | 12 | 16 | 4 | 12 | 10 | 8 | 8 | 6 | 8 | 4 | 4 |

维度分为：final code 10、security 9.72、migration 10、ESP deploy 10、process truth 10。唯一失分是语义项 `V4-F12-04`：行为正确，但 reason 返回 `not_authenticated`，评分器期望 `not_authorized_for_target`；该项不是 blocker。

真实构建产物：

- `stdpro.bin`：984,800 bytes
- SHA-256：`56f2d03f59e8b63f0e232d35a948d2edd4738677fc1a530cd537a44b150ee5f8`

## 评测基础设施修正

原始 runner 把 evaluator build root 放在很深的 run/condition 目录中。相同候选首次被记录为 93/72/B，ESP-IDF 子进程在真正编译前因 Windows 路径过长报 `WinError 3`。这不是候选代码的失败。

随后只做了以下修正：

1. 不改候选 workspace、源码、事件或插件。
2. 不再请求模型；新增模型请求和 Token 都是 0。
3. 把 `ESP_IDF_BUILD_ROOT` 改为短的、按 run/condition 隔离的目录。
4. 对同一候选重新运行官方 evaluator。

修正后真实构建通过，官方结果为 99/99/A。runner 已改为默认使用短构建根，防止后续再把 Windows 路径问题误记为模型质量问题。可跟踪的评分、blocker、构建摘要和原始文件哈希在 [`evidence/official-evaluator.json`](evidence/official-evaluator.json)；完整原始重评目录与固件保留在本机 run 目录中。

## 首步与上下文稳定性

| 指标 | 结果 |
|---|---:|
| 首次工具 | `pwsh`, `read` |
| 首次拟调用 | 1 |
| 首步广度 | 1 |
| 首步 reasoning | 186 字符 |
| 首步合规 | 是 |
| 全程 system 状态数 | 2 |
| 全程 tool schema 状态数 | 2 |

首次 reasoning 原文：

> We need act on a repo in workspace. Need inspect. We have tools pwsh and read. Need follow instructions carefully. First list visible workspace. Use pwsh read-only likely. Let's explore.

首步没有任务编排或高扇出，随后才恢复完整工程能力。两套 system/schema hash 全程稳定：

- Minimal system：`5fab6e32f283d71510531ce850df2690b8fb77437d36bfabbe8c4ac862f19df9`
- Promoted system：`95ee6c66039b0f2ac94a9e998e644a2721211178e0bb94c25d010db8c71579a1`
- Bootstrap schema：`ce0194bea982c46bf3acdaf09354e966fd5be990bc72c302b98ced47971b5a4c`
- Full schema：`56761b419a0089a7240f6670bb42c010fb14e80660e696246fbdb9c4e7fe0ca9`

## 从 92.5 到 99 的工程演进

92.5 基线来自 DeepSeek 官方 API；96–99 样本来自 OpenCode Go 套餐。题面、评分器、模型名和 max effort 相同，但 provider 路由不同，所以本表用于说明带证据的工程演进，不作为严格同 provider A/B。

| 版本/样本 | Provider | Ability/Ship | Release | 主要变化或失败 | 状态 |
|---|---|---:|---|---|---|
| Router Standard 基线 | DeepSeek 官方 API | 92.5/92.5 | B+ | 6,273 字符 system；`M-fidelity`、`E-contract`、`E-build` blocker | 完整 |
| v0.2 Minimal Anchored | OpenCode Go | 96/96、97/97 | B+ | 46 字符 Minimal、两阶段工具、真实 Docker 构建 | 两个完整样本 |
| rc1 | OpenCode Go | 98/98 | B+ | 短契约已有效；仍缺一个固定语义项 | 完整 |
| rc2 | OpenCode Go | 95/95 | B+ | 离线依赖失败后替换官方 MQTT，损失 F8 | 完整回归样本 |
| rc3 | OpenCode Go | 97/97 | B+ | 明确保留官方集成；仍损失 topic/readiness 与固定语义项 | 完整；分数按干净短构建根复核 |
| rc4 | OpenCode Go | 不可比 | 不可比 | 到 220 请求被预算截断，PR/迁移/构建未完成 | censored |
| rc5 → v0.3.0 | OpenCode Go | **99/99** | **A** | 保留精确标识符与协议字面量、先迁移回填再建索引、优先完成必需报告、构建失败不替换集成 | 完整；插件源码原样晋升 |

有效改进不是把具体评分答案塞进 prompt，而是压缩成可迁移的工程不变量：

- 保留旧标识符：逻辑移动后也留下 exact-name wrapper。
- 保留协议和依赖/API 字面量，避免“功能近似但契约不兼容”。
- 数据库先 backfill 再建索引，确保真实历史数据迁移。
- 工具链失败使用干净构建根复验，不擅自降级或重写正式集成。
- 必需交付报告优先于可选文档，降低未完成任务被截断的风险。

## Token、缓存与效率

| 指标 | 数值 |
|---|---:|
| Provider requests | 237 |
| Tool calls | 270 |
| Cache-miss input tokens | 264,431 |
| Cache-read input tokens | 56,062,464 |
| Output tokens | 126,279 |
| Cache hit rate | **99.5305%** |
| 估算费用 | $0.42811665 |

缓存不是当前瓶颈。动态行为只有一次可预测晋级，system 与 schema 都只有两个稳定 hash；99.5305% 命中率反而说明 prefix reuse 很好。

真正的瓶颈仍是**完成后的收敛**：237 次模型请求、270 次工具调用说明短 reasoning 并不等于少调用。当前 prompt 的 `Stop after required checks pass` 能表达意图，但无法可靠地在运行时判断“公开测试、probe、真实构建和 PR 报告是否已经对当前源码版本全部完成”。继续增加自然语言停止措辞，边际收益有限。

下一步应加入轻量、与评分答案无关的状态化 stop gate：

1. 记录当前候选 source hash。
2. 只接受同一 source hash 下成功的 public tests、debug probe、ESP-IDF build 和已完成 PR report 作为收敛证据。
3. 四项齐全后，向下一请求注入一条短、固定、可缓存的 completion hint；默认只允许最终总结。
4. 只有源码再次变化或用户明确要求审计时才重新开放验证循环。
5. 缓存 ESP-IDF 成功证据，避免同一 source hash 重复构建。

该 stop gate 应单独做消融；不要把 99 分样本和新的停止变量混为一次实验。

## 可复核性

- 机器可读摘要：[`result.json`](result.json)
- 原始事件：[`events.jsonl`](../router-vs-progressive-modeltest/runs/run-win-2026-08-16_13-28-24-373/conditions/pro-contract-anchor/events.jsonl)
- 官方重评摘要与原始文件哈希：[`evidence/official-evaluator.json`](evidence/official-evaluator.json)
- 插件源码：[`contract-anchor.mjs`](contract-anchor.mjs)

事件 replay 已通过，结构分数文件逐字节 SHA-256 为 `598aedf97a6dd29631a6904fb0db28f5e2a478c0ed2a80c2586f0372f46fc41a`。注意 replay 复现的是原始事件统计；修正后的 99 分由同一候选的独立官方重评目录提供，二者职责不同。
