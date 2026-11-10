# GPT龙娘 · DSH独立版

> **这是适配版，不是原创项目。** 龙娘挂件本体来自 **T7moris** 的 [GPT-Niang](https://github.com/T7moris/GPT-Niang/releases)（基线 `v1.4.0-beta.3`）；本仓库只做 **DeepSeek Harness（DSH）适配**与必要的独立化改造。完整署名、许可与再分发要求见[出处与署名](docs/ATTRIBUTION.md)。

独立工程 **0.1.0-beta.2**，目标是完整保留 GPT-Niang v1.4.0-beta.3 Windows 龙娘功能，并通过受信任桥接使用现有DSH GPT/Codex订阅与会话数值。不是小鲸鱼换皮，不依赖小鲸鱼，不修改任何已安装插件或DSH源码。

> 已在普通本地目录保持sandbox开启跑通真实角色、菜单和面板交互。安装、重启现有DSH、真实账号额度、音乐设备及多屏交互仍需另外确认；分层结果与尚未闭合问题见[验证记录](docs/VALIDATION-REPORT.md)，不把编译或模拟数据当作实机全部通过。
>
> 带Low完整性标签的隔离目录与Chromium子进程的映像安全策略冲突，GUI不应从这类目录直接运行。应按正常发布流程完整解压到普通本地目录后验证；不要为此改ACL/标签、提权或关闭sandbox。

## 快速开始

- 使用者：[安装指南](docs/INSTALL.md)（含 DSH 桥接可选安装方式）
- 配置与排错：[桌面端说明](desktop/README.md)
- 出处与许可：[出处与署名](docs/ATTRIBUTION.md)
- 参与开发：[贡献说明](CONTRIBUTING.md)
- 维护者发布：[发布步骤](docs/PUBLISHING.md)

> 适配层的范围仅限 DSH 集成与共存所需的独立化；上游功能保持原样。若你只想要原版，请直接去[上游发布页](https://github.com/T7moris/GPT-Niang/releases)。

## 项目结构

- [desktop](desktop/README.md)：完整独立Electron/Windows龙娘，原生音乐/窗口/图库/用量账本保留。
- [bridge](bridge/package.json)：独立DSH bundle，使用正式client transport和受鉴权Host路由；无额外HTTP监听。
- [共享协议](shared/bridge-protocol.mjs)：严格白名单schema、epoch/lease、账号/过期隔离。桌面构建副本由同步脚本生成。
- [桥接契约](docs/BRIDGE-CONTRACT.md)：数据、文件、生命周期与隐私边界。
- [出处与署名](docs/ATTRIBUTION.md)：上游链接、许可范围与再分发要求。
- [安装指南](docs/INSTALL.md)：使用者安装步骤与可选桥接部署。
- [完整功能对照](docs/FEATURE-PARITY.md)：验收清单及有意的独立化变化。
- [测试迁移说明](docs/TEST-MIGRATION.md)：上游回归测试的适用范围与环境隔离。

## 构建

需要Node 24、Windows x64、.NET Framework C#编译器、MSVC x64与Windows 10/11 SDK。Electron 45（官方 win32-x64 发行）随 `desktop/node_modules` 获取。

```powershell
cd desktop && npm ci && cd ..
node tools/sync-shared.mjs
node --test bridge/tests/*.test.mjs
node desktop/scripts/test-companion.mjs --suite=core
node desktop/scripts/test-companion.mjs --suite=non-electron
node desktop/scripts/test-companion.mjs --suite=electron
node bridge/scripts/build.mjs
node desktop/scripts/compile-native.mjs --sdk-version 10.0.26100.0
```

### 依赖本地参考物的检查（新克隆默认不跑）

以下脚本需要本仓库**不分发**的参考物，缺失时会以退出码 2 明确报错：

| 脚本 | 需要 | 用途 |
|---|---|---|
| `tools/audit-source.mjs` | `vendor/source/GPT-Niang-1.4.0-beta.3/` | 与上游源码做逐文件差异 |
| `tools/audit-runtime.mjs` | `vendor/electron45-official/` | 与官方 Electron 发行逐字节比对 |
| `tools/verify-protected.mjs` | `audit/protected-files.json` | 比对本人机器上原有安装的开发前后哈希 |

前两者请自行从[上游发布页](https://github.com/T7moris/GPT-Niang/releases)与 Electron 官方 release 取得对应版本后放入。第三个只对"保护本机既有安装不被改动"有意义，在干净克隆里没有意义。

同理，`desktop/tests/bmp-compatibility.test.mjs` 与 `desktop/tests/compatibility-audit.test.mjs` 中依赖上游 PowerShell 源码的用例会在缺少参考源时**自动 skip**；提供 `GPT_NIANG_LEGACY_ROOT`（或放入 `vendor/source/...`）后会自动恢复运行。

真实Codex CLI插件回归只允许显式提供`CODEX_CLI_PATH`，测试使用临时`CODEX_HOME`、临时用户目录和本地fixture；不会登录或调用模型。测试runner会清除凭据环境并阻止真实HTTP/系统任务操作。

桌面打包：从本目录自己的Git提交构建，输出必须是不存在的独立目录。

```powershell
node desktop/scripts/build-release.mjs --output ./dist/release-0.1.0-beta.2
```

桥接包通过DSH当前宿主支持的插件管理入口安装；不要编辑desktop profile，不能把web profile命令当桌面安装。桌面完整包通过其独立安装器部署，两者安装分别确认。

## 来源与保护

- 上游：**T7moris/GPT-Niang** [发布页](https://github.com/T7moris/GPT-Niang/releases) `v1.4.0-beta.3`，提交`285cb464ebc700be640ecc6a7be4ca3a05ba5371`。详见[出处与署名](docs/ATTRIBUTION.md)。
- 上游原安装包SHA256：`83085ec3661e654fc06d731ba2b39880412752af11fc15cc637f9b4276e70aba`。
- 未配置独立公共更新仓库，默认不会下载上游更新回装本项目；手动新版完整包升级仍保留本项目个人设置/事务恢复。
- 原有小鲸鱼、订阅插件及desktop profile关键文件的哈希对比记录不随源码仓库分发。

## 许可

代码/文档沿用上游 [MIT 许可](desktop/LICENSE) 并保留 `Copyright (c) 2026 T7moris` 与贡献者署名。桥接为本项目独立代码。龙娘图片及派生图标**不属于 MIT**，仅可作为非商业个人副本随本项目分发；保留[角色素材声明](desktop/assets/CHARACTER-NOTICE.txt)、[生成来源](desktop/assets/生成说明.md) 和 [语录许可](desktop/assets/quotes-LICENSE.txt)。未获得相应授权不得作为商业产品或独立素材包分发。再分发要求见[出处与署名](docs/ATTRIBUTION.md#如果你要再分发)。
