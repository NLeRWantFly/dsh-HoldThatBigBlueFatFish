# dsh-pwsh2wslbash

`dsh-pwsh2wslbash` 为 Windows 版 DeepSeek Harness 提供 WSL 原生 Bash
执行器。模型看到并调用 `bash`，命令实际由指定 WSL 发行版中的 `/bin/bash`
执行；`pwsh` 工具被关闭。

## 执行路径

每次命令都以 argv 方式启动，不经过额外的 Windows shell：

```text
wsl.exe -d Ubuntu-20.04 --cd <Windows cwd> --exec /usr/bin/env \
  <env...> /bin/bash -lc <command>
```

- Windows 盘符路径会映射为 `/mnt/<drive>/...`。
- `DSH_HOME`、`DSH_SESSION_JSONL` 等路径型环境变量会同步转换。
- WSL 内使用原生 Linux `PATH`，所以 `node`、`git` 和其他命令均来自 WSL。
- 前台与后台任务都复用 DSH 原有的进程、输出和超时管理。

## 前置条件

```powershell
wsl.exe --list --quiet
wsl.exe -d Ubuntu-20.04 --exec /bin/bash -lc 'uname -s; printf "%s\n" "$BASH_VERSION"'
```

如发行版名称不同，请修改 [cordis.patch.yml](cordis.patch.yml) 中的 `distro`。

## 安装到旧 DSH

在 DSH 安装目录的 `profiles/web/package.json` 和
`profiles/headless/package.json` 中加入本地依赖，并把插件加入 bundle 列表：

```json
{
  "dependencies": {
    "dsh-pwsh2wslbash": "file:C:/absolute/path/dsh-pwsh2wslbash"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pwsh2wslbash"
      ]
    }
  }
}
```

`headless` profile 保留自身原有 bundle，只追加 `dsh-pwsh2wslbash`。然后在对应
profile 目录安装依赖并完整重启 DSH。

## Bundle 变化

插件的 `cordis.patch.yml` 会：

- 关闭 Windows 原生 `bash-sandbox` 和 `pwsh-sandbox`；
- 挂载 WSL Bash executor；
- 启用模型工具 `bash` 并禁用 `pwsh`；
- 将旧 DSH 的审批策略设置为 `never`；
- 关闭与该执行路径不兼容的旧权限预设服务。

## 验证

```powershell
npm.cmd test
```

安装后可让 DSH 的 `bash` 工具执行：

```bash
printf 'WSL_BASH\n'; uname -s; pwd; node -p process.platform
```

预期包含：

```text
WSL_BASH
Linux
/mnt/...
linux
```

## 边界

该插件只把 shell 工具执行切换到 WSL。旧 DSH 的 UI、会话存储、文件工具、模型
路由和 Node 主进程仍运行在 Windows。需要整个 DSH 都运行在 Linux 时，应在 WSL
内安装并启动 DSH。

该目录仅新增独立插件，不修改仓库原有 preset、实验或验证数据。
