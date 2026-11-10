# 安装指南

本文件面向使用者。开发与构建说明见仓库根 [README](../README.md)。

## 桌面挂件

**这是独立移植版，不修改、不覆盖已安装的任何挂件或 DSH 配置。**

1. 把发行 ZIP 完整解压到普通本地目录（不要放 `Program Files`、网络盘或同步目录，也不要在压缩包内直接运行）。
2. 双击 `安装独立龙娘.cmd`。默认不需要管理员权限。

安装位置：

| 项目 | 默认路径 |
|---|---|
| 程序 | `%USERPROFILE%\.dsh-gpt-companion\app` |
| 个人数据（设置、语录、角色、账本） | `%USERPROFILE%\.dsh-gpt-companion\state` |
| 登录启动 | 当前用户计划任务 + `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 快捷方式 |

只检查不安装：

```powershell
安装独立龙娘.cmd --check
```

升级：解压新版后再次运行 `安装独立龙娘.cmd`，个人设置与导入素材保留。

停用：运行 `停用独立龙娘.cmd`（停止程序、删除登录任务与快捷方式，**数据保留**）。

彻底删除：停用后删除 `%USERPROFILE%\.dsh-gpt-companion` 整个目录。

## DSH 桥接（可选，用于显示真实额度）

不安装桥接也可以使用角色、语录、图库、声音、音乐律动与桌面拖动，此时额度显示"暂不可用"。

启用条件：

1. 使用**桌面版** DSH（DeepSeek Harness），不是网页版；
2. 已启用 GPT 订阅接入插件（`dsh-codex-subscription`）；
3. 把发行包内的 `dsh-gpt-companion-bridge-<版本>.tgz` 安装到 DSH 的 `desktop` profile。

桥接的安装方式随 DSH 版本变化，请使用**你的 DSH 版本自带的插件管理入口**安装该 tgz。安装后需要让 DSH 重新加载（通常重启 DSH 生效）。

手工作业参考（仅在确认你的 DSH 使用该目录结构时采用）：

```text
1. 解压 tgz，把 package/ 下的内容放到一个独立目录，例如 %USERPROFILE%\.dsh\plugins\dsh-gpt-companion-bridge
2. 在 desktop profile 的 package.json 增加依赖：
   "dsh-gpt-companion-bridge": "link:<上一步的目录>"
3. 在 dsh.profile.bundles 末尾追加 "dsh-gpt-companion-bridge"
4. 在 profile 的 pnpm-lock.yaml 的 importers..dependencies 增加对应 3 行 link 记录
5. 让 DSH 重新加载 profile
```

**不要**把 DSH 的 Cookie、token、`auth.json` 交给挂件——桥接只通过 DSH 已认证连接生成的本机快照，不复制凭据。

也可以完全不用 DSH：在设置里把来源切换为 **Codex**，指向本机 Codex 数据目录，走原版账本。

## 未验证事项

真实账号额度端到端、真实音频设备、多显示器与高 DPI、重启后自动恢复，均未充分实机验收。详见[验证记录](VALIDATION-REPORT.md)。
