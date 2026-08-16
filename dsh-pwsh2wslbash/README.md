# dsh-pwsh2wslbash

`dsh-pwsh2wslbash` 为 Windows 版 DeepSeek Harness 提供 WSL 原生 Bash
执行器。模型看到并调用 `bash`，命令实际由指定 WSL 发行版中的 `/bin/bash`
执行；`pwsh` 工具被关闭。

## 与另外两者的区别

- 主仓库的 `dsv4-pro-contract-anchor` 是 agent preset，负责 Pro 的 system 与工具
  披露；本插件不改变模型 prompt 或 preset。
- `dsh-multimodel` 是 preset 内的视觉插件；本插件不处理图片，也不提供视觉模型。
- 本插件安装在 `<DSH_HOME>/profiles/web` 或 `profiles/headless`，不要复制到某个
  preset 的 `plugins/`。三者的选择表和完整安装顺序见
  [仓库根 README](../README.md#三者区别)。

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

在 `<DSH_HOME>/profiles/web/package.json` 和
`<DSH_HOME>/profiles/headless/package.json` 中加入本地依赖，并把插件加入 bundle
列表。只使用一种入口时，只修改对应 profile：

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

`web` 和 `headless` profile 都必须保留自身原有 bundle，只追加
`dsh-pwsh2wslbash`。然后在每个修改过的 profile 目录执行 `pnpm install`。

如果三者全部安装，完成 profile 修改后再复制主 preset 和 `dsh-multimodel`，最后
只重启一次 DSH。

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
