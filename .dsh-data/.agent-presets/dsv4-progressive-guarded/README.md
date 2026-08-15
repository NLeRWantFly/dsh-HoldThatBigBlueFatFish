# DSV4 Progressive Guarded

这是可直接安装到 DeepSeek Harness 的生产预设，不含实验 stop 或评分逻辑。

## 行为

- System 固定为 `You are a helpful software engineer assistant.`，不加载 Standard persona 或 runtime snapshot。
- 尚未取得合格证据时，只向模型显示 `read + native shell`。
- 成功完成指定文件读取、明确测试命令或窄范围诊断后，下一次请求显示 `read/shell/edit/write/grep/glob`。
- 晋级从持久化 `tool/call + 成功 tool/result` 重新计算，不依赖易失内存。
- 所有阶段均阻止递归或根目录仓库盘点、后台 shell、无路径 grep 和全量 glob。
- bootstrap 阶段阻止写操作；首 step 最多两个工具调用。
- 没有 `edit/write` 时，第三次重复同一 shell 命令会被拒绝。
- Plan Mode 按持久化 `plan/mode` 事件识别并绕过本插件，由 Harness 原生规划策略和工具目录接管。

该设计的目标是限制实际工具风险。现有实验没有证明它能减少模型内部 reasoning。

## 安装

将整个 `dsv4-progressive-guarded` 目录复制到 Harness 的：

```text
.dsh-data/.agent-presets/dsv4-progressive-guarded/
```

或从实验目录生成：

```powershell
$env:DSH_SOURCE_ROOT='C:\path\to\deepseek-harness'
node production\install.mjs
```

然后在 Harness 中选择：

```text
dsv4-progressive-guarded
```

## 核心配置

```yaml
- id: dsv4-progressive-guard
  name: './progressive-guard.mjs'
  config:
    shellTools: [bash, pwsh]
    bootstrapTools: [read]
    coreTools: [read, edit, write, grep, glob]
    maxFirstStepCalls: 2
    blockBroadInventory: true
    blockBootstrapWrites: true
    repeatLimit: 2
```

## 验证

```powershell
node production\tests.mjs
$env:DSH_SOURCE_ROOT='C:\path\to\deepseek-harness'
node production\smoke.mjs
```

冒烟测试使用本地假 DeepSeek API，不消耗官方 token，但会通过真实 DSH 组装、事件持久化、tool guard 和晋级路径。
