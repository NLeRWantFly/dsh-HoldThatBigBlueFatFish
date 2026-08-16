# DeepSeek V4 Pro Anchored v0.2

这个生产预设面向 DeepSeek V4 Pro 的 Project2 高分轨迹。它保持 46 字符 Minimal system，关闭 runtime context；第一次模型请求只暴露当前系统的原生 shell 与 `read`，session 出现第一个持久化 `tool/call` 后，下一次请求恢复当前 DSH Standard 的完整工具目录。

预设不分析 reasoning/text，不使用易失状态，不以 `assistant/message` 或 `tool/result` 晋级，不增加工具 Guard、输出上限或全程工具裁剪。共享工具直接来自 Standard 注册表，schema 不重写。

```powershell
$env:DSH_SOURCE_ROOT = 'C:\Users\顶真\Documents\Codex\2026-08-13\ba\work\deepseek-harness'
node .dsh-data\experiments\dsv4-pro-anchored-96\tests.mjs
node .dsh-data\experiments\dsv4-pro-anchored-96\install.mjs
```

部署后的 preset id 是 `dsv4-pro-anchored-96`，发布版本为 `v0.2`。推荐路由为 `opencode-go/deepseek-v4-pro`、`reasoningEffort: max`。

如果 Windows 没有 EIM，可使用随附的 `docker-espidf-activation.ps1` 对接官方 `espressif/idf:v6.0.1` 镜像。它只把评测脚本调用的 `idf.py`/`cmake` 映射到容器，不改变候选源码或评分规则：

```powershell
$env:DSH_EVAL_ESP_IDF_ACTIVATION_SCRIPT = (Resolve-Path .dsh-data\experiments\dsv4-pro-anchored-96\docker-espidf-activation.ps1)
```

## 已验证结果

2026-08-16 使用 OpenCode Go 套餐、`deepseek-v4-pro`、`reasoningEffort: max` 和冻结的 Modeltest Project2 v4.1b 题面完成两次带真实构建的正式样本：

| Run | Ability | Ship | Release | 请求 | 工具调用 | 输出 Token | 缓存命中率 | ESP-IDF |
|---|---:|---:|---|---:|---:|---:|---:|---|
| `run-win-2026-08-16_04-05-25-418` | 96 | 96 | B+ | 184 | 220 | 101,252 | 99.4507% | real pass |
| `run-win-2026-08-16_04-54-08-394` | **97** | **97** | B+ | 148 | 231 | 126,369 | 99.3384% | real pass |

97 分样本严格突破 96。官方 evaluator 归档的固件为 `stdpro.bin`，985,344 字节，SHA-256：`5551687f35305c3b8a0eca65702d3675e17137db35478d26429d6771d0782f75`。离线 replay 对 `scores.json` 的复算逐字节一致，SHA-256：`af062109efdf3b109b251459181e0bc515ed0046729e381a17a73d552d675ed9`。

完整结论、消耗和未解决问题见 [report.md](report.md)。可公开核对的精简证据位于 [evidence/run-96](evidence/run-96) 和 [evidence/run-97](evidence/run-97)。单条件只有两个带构建样本，因此这里证明“可复现地运行并取得 97”，不宣称统计意义上的稳定 97 下限。
