# Router Standard vs Progressive Guarded

本目录比较两个 DSH 预设，并使用 Modeltest Project2 做官方 API 实测：

- 对照：[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)
- 被测插件：本仓库 `dsv4-progressive-guarded`（bash-debug v0.2）
- 题库与评分器：[modeltest](https://github.com/xiaobright/modeltest)
- 正式路由：`deepseek-official / deepseek-v4-pro / max`

## 一句话结论

Router 是“按任务选择行为风格、尽快恢复完整能力”，Progressive 是“压缩上下文、以成功证据晋级、持续执行约束”。Router 在本次 Project2 完成了任务并取得 Ability/Ship 92.5；Progressive 明显减少了生成 Token 和费用，但 Windows bootstrap 被 Guard 与 PowerShell 细节卡住，并在首次修改前遇到官方 API 402，因此其 48 分只能视为中途快照，不能作为最终质量分与 92.5 直接比较。

最值得继续做的不是二选一，而是组合：保留 Router 的任务路由与生产推进能力，换成 Progressive 的“可见 schema 即执行 ACL”、语义化 bootstrap 工具、mutation 上限和验收后收敛。

## 数据状态

| 数据层 | Provider / effort | 状态 | 用途 |
|---|---|---|---|
| 既有消融与 Project2 | DeepSeek 官方 API / max | 14 个完成样本 | 历史上下文与工具消融 |
| 本次 Router | DeepSeek 官方 API / max | 完成 | 当前 Router 质量与轨迹 |
| 本次 Progressive | DeepSeek 官方 API / max | 402 删失 | 同长度前缀、containment 与失败模式 |
| 历史游戏轨迹 | OpenCode Go / high | 用户提供的约数 | Token-before-guard、巨型 mutation、停止控制证据 |

合并后的机器可读数据见 [combined-results.csv](combined-results.csv) 与 [combined-results.json](combined-results.json)。OpenCode Go 行已合并展示但带 `reported-approximate` 标记，不计入官方 API 总计。

详细设计、首轮公开 reasoning、官方评分、缓存分析、PowerShell 问题及改进方案见 [report.md](report.md)。

## 复现

只读验证与离线回放不调用模型：

```powershell
node preflight.mjs
node router-runtime-smoke.mjs
node runner.mjs replay runs/run-win-2026-08-15_12-34-39-162
node analyze.mjs runs/run-win-2026-08-15_12-34-39-162
node merge-results.mjs
```

`preflight.mjs` 当前预期报告 Router `bandOf is not defined`，这是上游 commit `d4655d5` 的真实 bootstrap 缺陷；`router-runtime-smoke.mjs` 同时证明 DSH 会隔离该 listener 异常，persona 与两阶段工具目录仍能工作。

补跑唯一缺失的 Progressive 正式样本前，先确认 DeepSeek 官方余额足以覆盖一次完整 Project2；随后运行：

```powershell
node runner.mjs live --condition progressive-guarded
```

Runner 从 DSH credential service 取凭据，仅检查是否已配置，不读取、打印或写入密钥。可用环境变量：

```text
DSH_SOURCE_ROOT     已构建且含配置凭据的 DeepSeek Harness 源码目录
DSH_HOME            可选，默认 DSH_SOURCE_ROOT/.dsh-data
COMPARISON_WORKSPACE 包含 modeltest 与 dsh-router-standard 的目录
MODELTEST_SOURCE    可选，覆盖 Modeltest 本地 checkout
ROUTER_SOURCE       可选，覆盖 Router 本地 checkout
DSH_EVAL_PYTHON     官方 evaluator 使用的 Python
```

正式 runner 把 endpoint 固定为 `https://api.deepseek.com`，并在 request header 验证 `provider=deepseek-official`、`model=deepseek-v4-pro`、`reasoningEffort=max`。OpenCode Go 不参与这组正式请求。
