# Git-style Anchored Standard 实现验证报告

日期：2026-08-15

## 当前结论

实验代码、五条件 preset、官方 API 路由、冻结 Project2 runner、官方 evaluator 投影、replay、verify、Windows/Linux 容器配置均已实现。在线 DeepSeek 矩阵尚未运行，因为当前宿主进程没有轮换后的 `DEEPSEEK_API_KEY`；对话中曾出现的 key 没有被使用、复制或保存。因此本文件只报告结构与本地假 API 验证，不伪造在线 reasoning 或 Project2 成绩。

## 已验证结果

| 验证 | 结果 |
|---|---|
| Minimal system 固定字符串 | 通过，46 字符 |
| provider/model/effort | `deepseek-official/deepseek-v4-pro/max` |
| 首阶段晋级依据 | 仅持久化 `tool/call`；`tool/result` 与 assistant 文本均不触发 |
| 同 response 不切 schema | 通过；完整目录只在后续请求组装出现 |
| Windows 真实 DSH + 本地假 API | 通过 |
| Standard 工具数 | 25 |
| `standard-full` 请求目录 | 25 |
| `minimal-full` 请求目录 | 25 |
| `standard-anchored` 请求目录 | 2 → 25 |
| `minimal-fixed` 请求目录 | 2 → 2 |
| `minimal-anchored` 请求目录 | 2 → 25，system 始终为 Minimal |
| 探针停止 | 精确停在第 3 条 assistant message |
| Windows/Linux 原生 shell 选择 | Windows `pwsh + read`、Linux `bash + read` 单元测试通过 |
| 冻结 handoff 两次生成 | 哈希相同：`50470bbdbfcfe39d88ddf2f14dccba64209c349a9edf7314fbe3971e3d0a395d` |
| 无凭据 live preflight | 在创建 run/发送请求前以 `MISSING_CREDENTIAL` 失败 |
| Docker Compose | 配置解析通过；Docker Engine 29.6.2 可达 |
| Linux 主容器 | 相同 DSH commit 的本地镜像 smoke 可启动；Minimal Anchored preset 创建 session 与官方 max 路由选择成功 |

Windows 本地假 API smoke 的实际请求数为：

```json
{
  "standard-full": 1,
  "minimal-full": 1,
  "standard-anchored": 2,
  "minimal-fixed": 2,
  "minimal-anchored": 2,
  "probe-stop-check": 3
}
```

## 尚未完成的在线证据

以下项目必须等用户设置轮换后的进程环境凭据后，由 `reproduce.mjs live` 产生：

- Windows 与 Linux 各五个 Project2 首三次 assistant 短探针；
- 六次完整 Project2 长测的 Ability、Ship、Release、family/dimensions/blockers 与 ESP-IDF 构建；
- 官方 API 的 reasoning/output/cache token、TTFT、耗时和费用；
- Standard 与 Anchored 的真实首轮 reasoning 原文与最终质量差值；
- 跨 OS 描述性汇总。

新 Dockerfile 的正式 build 曾停在 Docker Desktop 拉取 `moby/buildkit:buildx-stable-1`，连续无进度后被安全停止。为了验证容器布线，随后只复用了本机已有的同 DSH commit/同 Project2 依赖镜像做无模型 smoke，并在完成后删除了新镜像标签与容器/网络。正式 Linux 在线运行仍应执行 README 中的 `docker compose up -d --build`，不能把该 smoke 当作新镜像构建成功。

## 稳定复现入口

- `node prepare-presets.mjs`
- `node tests.mjs`
- `node runtime-smoke.mjs`
- `node handoff-tests.mjs`
- `node verify.mjs`
- `node reproduce.mjs live`
- `node reproduce.mjs resume --run <run-directory>`
- `node reproduce.mjs replay --run <run-directory>`
- `node verify.mjs --run <run-directory>`
- `node aggregate.mjs --windows <windows-run> --linux <linux-run>`

在线 run 的完整结果会写入自己的 `report.md`；前三次 reasoning/text/tool-call JSON 同时保存于 `trajectories/` 与规范化事件 JSONL。
