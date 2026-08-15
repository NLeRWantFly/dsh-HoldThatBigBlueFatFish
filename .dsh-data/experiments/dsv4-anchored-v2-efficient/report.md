# DeepSeek V4 Pro Max 省 Token 约束实验报告

## 对话归档

完整工程对话已整理为 [conversation-archive.md](conversation-archive.md)：共 30 个已完成或中断轮次、438 条可见用户/助手消息。归档不包含内部 reasoning、工具输出和自动浏览器上下文；含真实 API Key 的 1 个对话片段已整段排除，本机路径也已脱敏。

## 结论

本轮改进能稳定约束**首步工具面或实际执行风险**，但没有减少模型的**首步 reasoning**。显式契约会诱发规则复述；完全隐藏执行/编辑能力又会诱发“当前工具是否足以完成任务”的能力焦虑。首步 reasoning 从 Standard 的 81 字符，依次变为 V2 Compact 248、V3 Single 370、V4 Read-Only 1778；给 V4 增加一句能力生命周期事实后，V5 降至 442；预取 onboarding 并恢复核心工具的 V6 降至 328，但广度又回到 2。因此结论是：

> 运行时/schema containment 有效；思考倾向未被纠正。约束文字过多和工具能力过窄都会增加 reasoning。

按照预先设定的省 Token 门槛，完整 Project2 长测没有运行。新增实验总计 10 个 agent 模型请求，估算费用 0.01745607 USD；没有为了得到更好看的样本而重跑。

## 环境与冻结输入

- 平台：Windows native
- Provider：`deepseek-official`
- Model：`deepseek-v4-pro`
- Reasoning effort：`max`
- Project2 题面 SHA-256：`aae0cfddc59474ec5ff52858a47e9949ba9ee5352ea45ea3b7bfb29a99732747`
- Standard preset 来源 SHA-256：`cb98756a9ed76ca351a45a0ba138a97bf0ab7eead4fe2f1e9d1c9f9ec97937f0`
- V2 Minimal composition：`faed684f6fc45d8e8f8c024ba44f9519edc75e6671f10906d1701516aac5d17f`
- V2 Compact composition：`2759acc550b009109814a2f2dab54b3807e290570e8569e8c69f4d70c81b9e5f`
- V3 Single composition：`d9e24b9ecb10139fff2df0b445fdb718c82086b5de896fa93a68c057314630f4`
- V4 Read-Only composition：`412d2bc9051572f8ab809abd1ff80bdc49830ce553e99e76dc021fb6ee31f5be`
- V5 Read + capability note composition：`9f298454decf44010c2408e9ed24d6bddc9b89710bc9db352befd88200e8f6c4`
- V6 Prefetched onboarding composition：`0db6abfa709761d6cea9d8def26669b8218a54cd68049e27ea51d7c319976a26`
- 凭据只由已配置的 DSH Host 持有；未检查、未写入实验产物。

## 结果总表

| 条件 | 新请求 | 首步 reasoning 字符 | reasoning tokens | 首步工具调用 | 首步广度 | 合规 | Guard 拒绝 | Input / cache / output tokens | 费用 USD |
|---|---:|---:|---:|---:|---:|---|---:|---|---:|
| 既有 Standard（复用，未计入新请求） | 3 | 81 | 23 | 2 | 2 | 否 | 0 | 14026 / 19328 / 550 | 0.00664987 |
| V2 Minimal-Core | 3 | 152 | 63 | 1 | 2 | 否 | 1 | 328 / 6272 / 306 | 0.00043164 |
| V2 Compact-Core | 3 | 248 | 103 | 2 | 1 | 是 | 0 | 26732 / 6656 / 482 | 0.01207189 |
| V3 Single-Core | 1 | 370 | 89 | 1 | 1 | 是 | 0 | 2058 / 0 / 139 | 0.00101616 |
| V4 Read-Only | 1 | 1778 | 375 | 1 | 1 | 是 | 0 | 718 / 256 / 425 | 0.00068301 |
| V5 Read + capability note | 1 | 442 | 97 | 2 | 1 | 动作意图超预算 | 0¹ | 984 / 0 / 186 | 0.00058986 |
| V6 Prefetched + core tools | 1 | 328 | 69 | 3 | 2 | 否 | 0¹ | 5673 / 0 / 225 | 0.00266351 |

¹ 单请求探针在首条 `assistant/message` 落盘后立即取消，因此 V5/V6 工具均在 dispatch 前终止；表中记录的是模型拟调用意图，不是已执行工具。并行预算顺序已由离线回归测试覆盖：首响应超预算调用会在任何晋级判断之前被拒绝。

V2 Compact 在成功读取指定文件后，下一请求从 `read + pwsh` 晋级为 `read/pwsh/edit/write/grep/glob`，证明渐进披露机制有效；禁止的 web、todo、job、subagent 和 workflow 没有进入目录。V3 则以单请求硬停止验证更严格的首步动作，不进入长任务。

## 首轮调用原文

### Standard

Reasoning：

```text
Let me start by exploring the workspace and reading the onboarding documentation.
```

拟调用：

```json
[
  {"name":"pwsh","arguments":{"command":"Get-ChildItem -Force | Select-Object Mode, Length, Name; Write-Host '---'; Get-Location","description":"List workspace root contents"}},
  {"name":"glob","arguments":{"pattern":"**/*"}}
]
```

### V2 Minimal-Core

Reasoning：

```text
We need act as engineer. Need inspect workspace. We have tools pwsh, read. Must follow process. We need be careful: workspace visible. Let's list files.
```

拟调用的递归 `Get-ChildItem` 被 guard 拒绝；模型下一步退化为根目录列表，第三步才读取 `ONBOARDING_TODO.md`。

### V2 Compact-Core

Reasoning：

```text
Let me start by exploring the workspace. First, I should read ONBOARDING_TODO.md and understand the project structure. Per the contract, begin with smallest evidence-gathering action. Let me read ONBOARDING_TODO.md and list the workspace directory.
```

拟调用：

```json
[
  {"name":"read","arguments":{"file_path":"ONBOARDING_TODO.md"}},
  {"name":"pwsh","arguments":{"command":"Get-ChildItem -Force | Select-Object Mode,Length,Name","description":"List workspace root contents"}}
]
```

动作符合两调用预算，但第二条目录列表仍不是必要证据。成功的 `read` 结果触发下一请求晋级；随后模型立即尝试递归枚举指定目录，说明首步 schema 收敛并不会自动带来后续渐进披露。

### V3 Single-Core

Reasoning：

```text
We need act as software engineer. Must follow process. First read ONBOARDING_TODO.md, reference, README, code structure. We can make bounded read or shell call. First action only: make one bounded read or shell call using user-named path or command. No preamble. Need start reading ONBOARDING_TODO.md perhaps. We need know workspace paths. Let's read ONBOARDING_TODO.md.
```

拟调用：

```json
[
  {"name":"read","arguments":{"file_path":"ONBOARDING_TODO.md"}}
]
```

动作是前四组中最精确的，但 reasoning 变长。模型明显把 system 契约当作需要逐条复述的检查清单。

### V4 Read-Only（零新增契约）

System 严格恢复为 46 字符 Minimal persona，首请求 schema 只有 `read`。拟调用准确为：

```json
[
  {"name":"read","arguments":{"file_path":"ONBOARDING_TODO.md"}}
]
```

Reasoning 的关键原文：

```text
We need act on workspace. Need inspect. We have read tool only? functions read. Need modify files but no write tool defined! We only have read. User says start modifying, but tool list only read. Hmm. We need perhaps tool supports only read; cannot write. We must be honest? But task expects modifications. Maybe hidden write via not listed? No. We can only read files. Need inspect and then maybe tell can't modify? ... Let's read ONBOARDING_TODO.md.
```

完整 reasoning 为 1778 字符。主要篇幅不是计划仓库盘点，而是在反复推演“没有 shell/edit/write 是否还能完成任务”。这证明 schema 本身也会改变内部推理负担；零新增 prompt 并不自动意味着 reasoning 更短。

### V5 Read-Only + 能力生命周期事实

System 只比 V4 多一句：

```text
Additional tools become available after the first successful read.
```

Reasoning：

```text
Let me start by exploring the workspace. I need to read ONBOARDING_TODO.md, reference/, project README, and existing code structure. Then run the two required diagnostic scripts before modifying.

Let me first list files. I can use read tool only. But I need to know file structure. Let me try reading key files. First check workspace root? The read tool requires absolute or relative path. Let me try reading ONBOARDING_TODO.md in workspace.
```

Reasoning 从 V4 的 1778 降到 442 字符，说明消除能力不确定性有效；但仍是 Standard 的 5.5 倍。模型还在同一响应生成了两个 `read`，所以不满足 V5 的单调用结构门槛。评测 stop 在工具 dispatch 前取消了这些调用；随后补充的离线回归测试确保真实执行时第二调用不会因并行完成顺序绕过预算。

### V6 运行时预取 onboarding + 首请求核心工具

Harness 在第一次模型请求前读取 `ONBOARDING_TODO.md`，将内容作为 system evidence，并从首请求开始暴露 `read/pwsh/edit/write/grep/glob`。Reasoning：

```text
Let me start by exploring the workspace and reading the key documents. I need to follow the mandated process: read ONBOARDING_TODO.md (already prefetched), reference/, project README, existing code structure, then run the public tests and debug probe before changing code.

Let me first list files and read key docs in parallel.
```

拟调用：

```json
[
  {"name":"pwsh","arguments":{"command":"Get-ChildItem -Force | Select-Object Mode,Length,Name","description":"List workspace root files"}},
  {"name":"glob","arguments":{"path":"reference","pattern":"**/*"}},
  {"name":"glob","arguments":{"pattern":"project2_task/**/*"}}
]
```

预取把 reasoning 降到 328 字符，但完整核心工具重新激活了并行摸底倾向：广度回到 2，且拟调用数为 3。输入也因 onboarding 内容增加到 5673 tokens。

## 消融判断

1. **工具/schema 与运行时 guard 对行为影响更大。** Standard 的 `glob("**/*")` 和 V2 Minimal 的递归 shell 均表明，只靠模型自律会先盘点；隐藏广域工具并拒绝递归命令后，实际动作可被收敛到指定文件。
2. **Prompt 对 reasoning 的影响方向不理想。** 从 Minimal 152 → Compact 248 → Single 370，约束越显式，首步自我叙述越长。它改善了服从形式，没有改善推理经济性。
3. **工具过窄同样会增加 reasoning。** V4 只给 read 时升至 1778；一句能力生命周期事实把它降至 442，但无法回到 Standard。模型需要既知道当前最小动作，也确信后续有能力完成任务。
4. **两工具 bootstrap 虽偏宽，但比纯 read 更自然。** Compact 同时用了 read 和根目录 shell；纯 read 可以消除目录操作，却制造明显能力不匹配。
5. **晋级条件和同响应预算必须同时保留。** 成功结果只影响下一请求的工具目录，不能解除当前 assistant response 的调用预算。
6. **递归盘点 guard 应跨阶段生效。** Compact 晋级后马上尝试递归枚举；V4/V5 已将该拒绝扩展到晋级后。
7. **预取证据不能代替工具约束。** V6 已经知道 onboarding 内容，仍选择目录列表和两个 glob；“缺信息”不是摸底倾向的唯一原因。

## 门槛与长测决定

效果门槛为：候选首步广度严格小于 Standard，且首步 reasoning 字符严格小于 Standard。

- V2 Compact：广度 1 < 2，通过；reasoning 248 < 81，不通过。
- V3 Single：广度 1 < 2，通过；reasoning 370 < 81，不通过。
- V4 Read-Only：广度 1 < 2，通过；reasoning 1778 < 81，不通过。
- V5 Read + note：广度 1 < 2，通过；reasoning 442 < 81，不通过；并且生成两个首响应调用，结构门槛也不通过。
- V6 Prefetched：reasoning 328 < 81，不通过；广度 2 < 2，也不通过；三个拟调用超过两调用预算。

所有候选均被写入 `selection.json` 为 `eligibleForLongRun: false`。`project2-live` 还会再次检查 `effectGate.passed`，因此无法误启动昂贵长测。本轮没有新的 Ability、Ship 或 Release class；可复用的既有 Standard 长测为 Ability 90.5、Ship 90.5、Release B+，但不能把它当作 V2–V6 的质量结果。

## 下一步建议

当前不建议继续为同一 Project2 题面追加微调 Prompt。工程上最稳妥的是接受“思考倾向未纠正”，采用 Git-style `Minimal + read/shell` 配合跨阶段 hard guard，把收益定义为 runtime containment。若继续研究，下一项应测试**窄语义工具**而不是通用 shell/glob：首轮只暴露 `read_named_file` 与 `run_named_check`，参数枚举直接来自题面路径和命令；成功证据后恢复核心工具。它既保留可执行能力，也不提供仓库盘点这一 affordance，但会改变工具 schema，必须作为新的实验变量单独报告。

## 稳定复现

```powershell
node prepare-presets.mjs
node tests.mjs
node runtime-smoke.mjs
node runner.mjs replay --run runs\run-win-probe-2026-08-15_06-10-23-199
node runner.mjs replay --run runs\run-win-micro-2026-08-15_06-22-58-480
node runner.mjs replay --run runs\run-win-micro-v4-2026-08-15_07-26-13-393
node runner.mjs replay --run runs\run-win-micro-v5-2026-08-15_07-29-28-445
node runner.mjs replay --run runs\run-win-micro-v6-2026-08-15_07-39-50-668
node runner.mjs gate --run runs\run-win-probe-2026-08-15_06-10-23-199 --standard-run ..\dsv4-anchored-official\runs\run-win-2026-08-15_03-12-05-652
```

五次 replay 的 `scores.json` 均逐字节一致：

- V2：`e9f7fcdc95ce4978194cf33c519f18a46f1c3fa1e7799083ec5cb9edd36839f9`
- V3：`6e2180841a2e103984b616ff459fc9ba430a5b16af851d14f032c9c262bc8d04`
- V4：`3e4721517b3e91a2f31f98536bb0f4f417fa1ee9b7321f17f3e7566aa353d7cc`
- V5：`1362aded653e797b4efcced43f6cbfdee695e73f29f7803c06cc076da8542b4b`
- V6：`19eb4f7d5e1918ac64d147822888a9b11bdc8bea0312d8b4e867657b73dddad4`
