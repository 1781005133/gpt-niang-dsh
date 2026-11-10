# 贡献与开发说明

本仓库是 **GPT-Niang 的 DSH 适配版**，上游为 [T7moris/GPT-Niang](https://github.com/T7moris/GPT-Niang/releases)。改动请遵守以下边界。

## 上游优先

- 龙娘本体行为以上游为准。若你的改动会改变上游既有行为（语录、图库、缩放、音效、音乐律动、跟随/桌面、提醒、账本），请在 PR 里说明理由，并优先考虑放回上游。
- 上游更新优先从上游获取；本仓库不代替上游发版。
- 不要声称获得上游作者背书。

## 硬性边界

以下均为设计约束，不是建议：

1. **不修改已安装的东西。** 不得写入或替换已安装的 DSH profile、小鲸鱼、原版 GPT娘、订阅插件、用户凭据或 DSH 安装目录。
2. **不复制凭据。** 桥接只能通过 DSH 已认证连接取得数据；不得读取 Cookie、token、`auth.json` 或聊天正文，不得另开监听端口，不得绕过 DSH 授权。
3. **不弱化安全。** 不要为了"跑起来"而关闭 sandbox、放宽 CSP、提权、改 ACL/完整性标签或加 `--no-sandbox`。
4. **失效数据不得伪装成新数据。** 空/断开/过期的额度必须显式显示为未知，不能沿用旧值冒充刚查询成功。
5. **账号隔离。** 账号切换或鉴权失败时，不得把上一个账号的快照继续暴露给新账号。

## 环境

- Windows 10/11 x64，Node 24，.NET Framework C# 编译器，MSVC x64 + Windows 10/11 SDK（原生组件）。
- Electron 45 已包含在 `desktop/node_modules`（需要 `npm ci` 或从发行包获取运行依赖）。
- 上游参考源码不放仓库；需要时自行从上游取得放到 `vendor/source/`（已 gitignore）。

## 跑测试

```powershell
node tools/sync-shared.mjs
node --test bridge/tests/*.test.mjs
node desktop/scripts/test-companion.mjs --suite=core
node desktop/scripts/test-companion.mjs --suite=non-electron
```

真实 Codex CLI 相关回归需要显式设置 `CODEX_CLI_PATH`；测试会使用临时 `CODEX_HOME` 和临时用户目录，不会登录模型。详见[测试迁移说明](docs/TEST-MIGRATION.md)。

**注意**：若你的工作目录处于带 Low 完整性标签的位置（例如某些受管/沙箱目录），Electron GUI 会因 Chromium 的映像安全策略在进入 JS 前失败。这是环境问题，不要通过改标签或关安全策略解决；把仓库放到普通本地目录再跑 GUI 测试。

## 提交要求

- 一个 PR 聚焦一件事；不要顺手大范围重排格式。
- 涉及额度语义、桥接字段或快照格式的改动，同步更新 [桥接契约](docs/BRIDGE-CONTRACT.md) 与 `shared/bridge-protocol.mjs`。
- 新增/修改测试时，不要在未说明原因的情况下删除断言或加 skip；如果某项是环境限制，请在 PR 描述里写清证据。
- 不要提交个人路径、用户名、机器名、截图里的私人内容或任何凭据。

## 许可

提交即表示你同意以本仓库的 MIT 许可发布你的代码贡献。角色素材不在此列，请勿提交来源不明的图片素材。
