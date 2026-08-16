# DeepSeek V4 Pro Anchored v0.2 评测报告

## 结论

`dsv4-pro-anchored-96`（发布版本 `v0.2`）在冻结的 Modeltest Project2 v4.1b 上取得 **Ability 97 / Ship 97 / Release B+**，达到“严格突破 96”的目标。模型通过 OpenCode Go 套餐调用 `deepseek-v4-pro`，推理深度为 `max`；不是官方 DeepSeek API 样本，报告对此明确标注。

有效组合不是复杂路由，而是一个非常窄的上下文锚点：

```text
Minimal 46-char system + no runtime context
            ↓
first request: native shell + read
            ↓ persisted tool/call
next request: full Standard tool catalog
            ↓
system remains Minimal for the whole turn
```

它控制了 Pro 的初始注意力入口，同时保留了长任务所需的完整工具能力。插件不读取 reasoning/text，不使用隐藏题答案，不修改候选代码或 evaluator，也不靠 Guard 拒绝模型已生成的调用。

## 冻结条件

| 字段 | 值 |
|---|---|
| Provider | `opencode-go` |
| Model | `deepseek-v4-pro` |
| Reasoning effort | `max` |
| Benchmark | `project2-v4.1b` |
| Modeltest commit | `04255b55f16c4439e538239fb9783070c4165081` |
| Prompt SHA-256 | `aae0cfddc59474ec5ff52858a47e9949ba9ee5352ea45ea3b7bfb29a99732747` |
| Plugin SHA-256 | `ea9526f0639d4759db68fcdbc7e2f3b37cf8c14c3407209312f0f88b785bd2ab` |
| Minimal system | `You are a helpful software engineer assistant.` |
| First tools | Windows `pwsh + read` |
| Promoted tools | 当前 Standard 完整目录，本次为 25 个 |
| ESP-IDF | `espressif/idf:v6.0.1` Docker activation |

## 三次运行

| Run | 环境说明 | Ability | Ship | Release | Blocker | 请求 | 工具 | 输出 Token | 总输入 Token | 缓存命中率 | 估算费用 |
|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|
| `02-56-11-443` | 未接通真实 ESP-IDF | 93 | 72 | B | E-build, P-report | 158 | 216 | 133,108 | 37,151,045 | 99.3634% | $0.35249 |
| `04-05-25-418` | Docker build real pass | 96 | 96 | B+ | M-fidelity, E-contract | 184 | 220 | 101,252 | 46,946,283 | 99.4507% | $0.36952 |
| `04-54-08-394` | Docker build real pass | **97** | **97** | B+ | E-contract | 148 | 231 | 126,369 | 33,241,626 | 99.3384% | $0.32531 |

93 分样本不能用于判断插件上限：同一候选随后在官方 ESP-IDF Docker 镜像中可成功构建，它的主要扣分来自宿主构建环境和报告证据。接通 Docker 后的两次可比样本为 96、97。

97 分样本的 family 分数为：F1 8、F2 12、F3 16、F4 4、F5 12、F6 10、F7 8、F8 6、F9 6、F10 8、F11 4、F12 3。真实构建产物 `stdpro.bin` 为 985,344 字节，SHA-256 `5551687f35305c3b8a0eca65702d3675e17137db35478d26429d6771d0782f75`。

## 行为结论

1. **上下文入口比复杂 Prompt 更重要。** 46 字符 Minimal system 和首请求双工具足以保留 97 分任务能力；不需要 Standard persona、runtime snapshot 或额外路由叙述。
2. **工具披露控制起点，不控制全程。** 97 分样本首响应只有 129 个可见 reasoning 字符，但一次发出 4 个工具调用、广度 3；晋级后还出现多次并行扇出。schema containment 有效，整体收敛仍未完全解决。
3. **真实构建环境是能力评测的一部分。** Docker 入口让模型自己经历两次失败、第三次成功，并让官方 evaluator 独立复验。没有它会把宿主环境缺失误判为模型能力缺失。
4. **缓存问题不是当前瓶颈。** 两个正式带构建样本的输入缓存命中率分别为 99.4507% 和 99.3384%。Minimal system 全程不变、工具 schema 只有两种稳定状态，没有发生低命中率退化。
5. **停止判断仍是下一瓶颈。** 97 分样本在真实构建成功后又消耗约 9.5k 输出 Token；总计 148 次请求、231 次工具调用。应优化“成功证据后的收敛”，而不是增加更多首轮探索规则。

## 下一步约束方向

后续改进应保持 97 分方案的 prompt 和两阶段 schema 不变，只做独立消融：

- 首请求运行时最多执行 2 个调用，但不改变模型可见 schema；用于检验首轮四调用是否导致后续高扇出。
- 只在持久化事件已出现“指定测试通过 + 真实构建通过 + 发布报告存在”后启用短 stop hint；失败后的修复/重试不得被拦截。
- stop hint 必须作为下一请求的短稳定 section，不能不断变化或携带测试输出，以维持前缀缓存。
- 不根据 reasoning 文案晋级或停止，不把 benchmark 隐藏断言写入 system prompt。

当前不建议恢复 Progressive Guard：它会把必要的编译失败修复与无效审计混在一起，而且无法回收工具参数已经生成的 Token。

## 复现

部署：

源码仓库布局：

```powershell
$env:DSH_SOURCE_ROOT = 'C:\path\to\deepseek-harness'
node .dsh-data\experiments\dsv4-pro-anchored-96\tests.mjs
node .dsh-data\experiments\dsv4-pro-anchored-96\install.mjs
```

当前全局 npm 安装布局：

```powershell
$env:DSH_SOURCE_ROOT = (Join-Path (npm root -g) '@deepseek-ai\dsh')
node .dsh-data\experiments\dsv4-pro-anchored-96\tests.mjs
node .dsh-data\experiments\dsv4-pro-anchored-96\install.mjs
```

正式运行前保证 Docker Desktop 已启动、`espressif/idf:v6.0.1` 已存在，并仅通过 DSH credential service 提供 OpenCode Go 凭据。不要把密钥写入命令、manifest 或报告。

```powershell
$env:DSH_EVAL_PROVIDER = 'opencode-go'
$env:DSH_EVAL_MODEL = 'deepseek-v4-pro'
$env:DSH_EVAL_REASONING_EFFORT = 'max'
$env:DSH_EVAL_CREDENTIAL_REF = 'OPENCODE_GO_API_KEY'
$env:DSH_EVAL_ENDPOINT_PRODUCT = 'opencode-go-subscription'
$env:DSH_EVAL_ENDPOINT = 'opencode-go'
$env:DSH_EVAL_ESP_IDF_ACTIVATION_SCRIPT = (Resolve-Path .dsh-data\experiments\dsv4-pro-anchored-96\docker-espidf-activation.ps1)
$env:DSV4_ESP_IDF_DOCKER_IMAGE = 'espressif/idf:v6.0.1'
$env:ESP_IDF_BUILD_ROOT = (Resolve-Path .).Path + '\.espidf-build-96'
node .dsh-data\experiments\router-vs-progressive-modeltest\runner.mjs live --condition pro-anchored-96
```

97 分 run 的离线复算：

```powershell
node .dsh-data\experiments\router-vs-progressive-modeltest\runner.mjs replay .dsh-data\experiments\router-vs-progressive-modeltest\runs\run-win-2026-08-16_04-54-08-394
```

结果为逐字节一致的 `scores.json`，SHA-256 `af062109efdf3b109b251459181e0bc515ed0046729e381a17a73d552d675ed9`。

为避免把约 20 MB 的原始事件轨迹放入发布包，Git 只归档两次带构建样本的 manifest、summary、scores、官方 score draft、blockers 和构建证据，见 [evidence](evidence)。原始 JSONL 保留在执行机器本地；公开仓库可通过 live runner 重新生成。
