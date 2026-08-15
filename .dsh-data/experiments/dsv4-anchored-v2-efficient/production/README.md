# DSV4 Progressive Guarded（bash-debug）

这是可直接安装到 DeepSeek Harness 的生产预设。它针对真实长任务暴露出的四个控制缺口与一个 Windows shell 边界做了逐点修复，同时保持固定 system prompt 和仅一次工具目录晋级。

## 修复映射

| 问题 | 修改后的行为 |
|---|---|
| 空项目无法 bootstrap，读取压缩会话却误晋级 | 允许最多 50 项的根目录浅层探针；晋级必须来自成功的文本 `read`、有上限的浅层探针或明确检查。Harness 内部环境、压缩 session、二进制路径不算证据。 |
| Guard 拦得住执行、拦不住已经生成的 Token | 普通模式在 Harness 中选择 `high`，插件在 `agent/request` 阶段把 `maxTokens` 固定到不高于 16384；system 要求纵向切片；`write.content` / `edit.new_string` 向模型显示 `maxLength: 12000`，Guard 对完整参数再次校验。 |
| 晋级后直接出现 71 KB 单文件爆发 | 每次文件变更上限 12,000 字符，每个 step 最多两个变更；两次成功检查之间累计最多 24,000 字符。shell 内容重定向被拒绝，要求使用 `write/edit`。 |
| Repeat Guard 不是 Stop Guard | 最近一次相关检查成功后，只允许两个额外诊断调用；第三个即使换命令、换成 `read/grep` 也会拒绝。失败检查或成功修复会重新打开诊断窗口。 |
| PowerShell 暴露过多 Harness 细节且失败语义松散 | bootstrap 时用短、前台-only 的 pwsh/bash schema，隐藏后台、提权和 `DSH_*` 引导；非零 exit、timeout、sandbox denial、`FAIL/ERROR`、JavaScript/Python 异常不再算成功证据。晋级后恢复原生 shell 能力。 |

运行时拒绝只能阻止副作用，不能退还已经生成的参数 Token。因此真正限制巨型生成的是请求上限、稳定的纵向切片 system 和模型可见的参数长度；Guard 是最后一道一致性校验。

## 两阶段上下文

普通模式始终使用同一个 complete persona，不加载 Harness identity 或 runtime snapshot：

```text
You are a helpful software engineer assistant. Build the smallest runnable vertical slice first. Keep each file mutation at most 12000 characters, run one relevant check, then expand only as required. After the final check passes, stop; do not continue speculative audits.
```

工具只有两个稳定状态：

```text
bootstrap: read + projected native shell
promoted:  read + native shell + edit + write + grep + glob
```

空项目探针示例：

```powershell
Get-ChildItem -Force | Select-Object -First 50 Name,Mode,Length
```

```bash
find . -maxdepth 1 -mindepth 1 -print | head -n 50
```

未出现合格的持久化 `tool/call + tool/result` 对时不会晋级。仅命令文本包含 `Get-Content`、命令返回乱码、非零退出或异常文本都不够。

## PowerShell 与 Bash

这里没有假设 Bash 天生优于 PowerShell。DSH 的两种 shell 都把 native non-zero exit 渲染成普通 tool result，因此都必须解析结果；PowerShell 额外存在非终止错误、编码和 `$LASTEXITCODE` 被后续命令覆盖的风险。插件的处理方式是缩小 bootstrap shell 契约并统一按结果判定，而不是在 Windows 强行切到 Git Bash/WSL，避免路径、ACL、环境变量和 sandbox 语义错位。

复杂 PowerShell/Bash 能力只在取得项目证据后恢复。模型应优先使用 `read/write/edit` 处理 UTF-8 源文件，shell 用于前台检查与无法由语义工具覆盖的操作。

## 缓存行为

- system prompt 在整个 session 中逐字节不变。
- bootstrap schema 固定；首次有效证据后只发生一次 schema change。
- 晋级后的 schema 固定，不会按 audit 次数或 slice 状态动态改写。
- `maxTokens` 从第一个普通请求起固定，不造成中途 request-header 抖动；reasoning effort 由 DSH 的 session model selection 权威拥有，用户应在会话开始前选定 `high`。
- Guard 状态完全从持久 session events 重算，重载后结果一致，session 之间不共享易失状态。

所以修复增加了策略能力，但没有引入第三种工具 schema。真实 cache 命中率仍受 provider、会话前缀和用户消息变化影响，插件只保证自身不制造额外阶段切换。

Windows 真实 DSH smoke 中，bootstrap pwsh function schema 为 1,038 bytes，晋级后的完整 schema 为 4,445 bytes，首请求缩小 76.6%；整条轨迹仍只有一次 schema transition。

## 安装

将整个 `dsv4-progressive-guarded` 目录复制到 Harness：

```text
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

或从本目录生成：

```powershell
$env:DSH_SOURCE_ROOT='C:\path\to\deepseek-harness'
node production\install.mjs
```

然后在 Harness 中选择：

```text
dsv4-progressive-guarded
```

模型选择中使用 `deepseek-v4-pro / high`。插件不会暗中覆盖 session 显式选择的 effort：DSH 的 model-selection 层会在 agent preset 的 `agent/request` 监听器之后重新施加该值，强行改写会让持久 request header 与 UI 选择失真。插件能够可靠控制的是 `maxTokens` 上限。

这与 DeepSeek 当前官方契约一致：thinking mode 默认 effort 为 `high`，`high/max` 可显式选择；`max_tokens` 限制一次 completion 的生成量；tool parameters 按 JSON Schema 描述，但官方仍要求调用方校验模型生成的 arguments。参见 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。

## 默认配置

```yaml
- id: dsv4-progressive-guard
  name: './progressive-guard.mjs'
  config:
    shellTools: [bash, pwsh]
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
    repeatLimit: 2
    requestMaxTokens: 16384
```

显式高强度审计时在 Harness 模型选择中切到 `max`，并在复制的 preset 中将 `requestMaxTokens` 改为 `32768`、`maxPostCheckCalls` 适度提高。不要把审计配置作为日常默认值，否则会重新放大长 reasoning。

Plan Mode 完全绕过工具过滤、Guard 和请求整形，由 Harness 原生规划策略接管。

## 验证

```powershell
node production\tests.mjs
$env:DSH_SOURCE_ROOT='C:\path\to\deepseek-harness'
node production\install.mjs
node production\verify.mjs
node production\smoke.mjs
```

单元测试覆盖 Windows/Linux 浅层探针、错误结果、不可信 session、变更预算、跨工具 stop、Plan Mode、请求上限和 HMR dispose。smoke 使用本地假 DeepSeek API，不消耗官方 Token，但会经过真实 DSH 请求组装、持久事件、工具执行、晋级、schema cache boundary 与 Guard。
