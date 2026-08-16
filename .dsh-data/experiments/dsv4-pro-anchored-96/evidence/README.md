# v0.2 精简评测证据

这里归档两个 OpenCode Go / DeepSeek V4 Pro / Max、Windows native、真实 ESP-IDF Docker 构建样本的机器可读结果：

- `run-96`：Ability 96、Ship 96、Release B+。
- `run-97`：Ability 97、Ship 97、Release B+。

每个目录包含输入/插件哈希 manifest、轨迹聚合 scores、官方 evaluator summary、family/dimension 结果、blockers、完整 score draft 和 ESP-IDF 构建证据。约 20 MB/次的原始事件 JSONL 和候选工作区不进入发布包，避免仓库膨胀；它们可由 live runner 重新生成。

这些文件不含 API key。Provider 被明确记录为 `opencode-go`，不能当作 `deepseek-official` 样本。
