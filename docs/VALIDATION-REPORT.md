# GPT龙娘 · DSH独立版 — 开发版验证记录

版本：0.1.0-beta.1。**独立Beta测试版：普通目录的真实界面与隔离数据链路已验证，尚未安装部署。** 不代表真实账号、音频设备、跨屏与登录启动全部实机验收通过。本报告保留各轮失败，不把不同层级的通过相互替代。

## 已实现

- 以GPT-Niang v1.4.0-beta.3完整龙娘为底座，不是小鲸鱼换皮；保留39句语录、图库/编辑/缩放、WAV/真实WASAPI音乐、桌面/跟随、提醒、账本与事务恢复代码。
- 独立程序/AppId/原生组件/个人目录；默认不注册Codex，不改DSH配置，不使用原版更新源。
- 正式已认证DSH客户端桥接订阅额度，账号/epoch/TTL隔离；桌面不读取Cookie/OAuth。已核验并修复Desktop代理删除Origin头的适配，未绕过DSH owner admission。
- GUI显式刷新请求真实RPC及对应新观测回执；隐藏暂停额度查询。DSH MCP/headless查询只读带时效投影，不冒称强刷；Codex原CLI路径保留。
- 同账号数值档案按originEpoch持久化，面板关闭、活动日志淘汰与宿主重启后可逐批补读；重复/修正/模型路由tombstone不重复计费。容量/I/O/初始化/观测缺口有警告。只代表桥接启用并在线期间已观测记录，不是平台完整账单。

## 自动验证证据

| 项目 | 实际结果 | 范围 |
|---|---|---|
| 最终非图形完整套件 | 62文件，457项：454通过、2失败、1既有平台skip | 包含运行时/原生/安装更新/真实临时Codex插件注册；非全绿 |
| 桥接最终 | 61/61通过 | 真实SDK schema + mock鉴权链、原子文件、控制/数值档案/传输边界 |
| Runtime/档案/UI定向 | 105/105通过 | 真实文件/SQLite与mock RPC；跨段、重启、修正、账号、预算、四卡一致性 |
| 原生组件 | 12/12通过 | 隐藏Win32窗口84组GDI范围、无抢焦点、1000次资源3→3、只读宿主识别 |
| 安装更新安全矩阵 | 30/30通过 | 原版数据拒写、错误身份零回滚、源验证先于helper、选定Codex home、ZIP必需依赖 |
| 核心单独套件 | 111/111通过 | 以各自日志记录的代码时点为准 |
| 配额fallback清理后置验证 | 1/1通过 | 正常stop协议及close后仅删除一次，消除fixture生命周期race |

最终非图形记录：日志与 JSON 报告（本地验证产物，未随仓库分发）。完整历史与时序见[测试迁移报告](TEST-MIGRATION.md)。桥接的档案验证与 Desktop 传输核对报告同为本地验证产物，未随仓库分发；可复现步骤见 [bridge README](../bridge/README.md)。不同轮次有重复用例，不把这些数字相加冒充总数。

### 普通目录后置GUI与I/O验证

选定的18个case最终17通过、1个旧force API故障注入失败；未将旧失败改名或用新增case覆盖。这里不包括未获准的真实账号/音频设备/启动注册场景。

- 真实包目录入口single verify 1/1通过：Electron按发行包目录读取真实package metadata→bootstrap→main，runtime.version=0.1.0-beta.1、rendererReady=true、verification.ok=true、原图1254×1254、非suite、music=false、exit0；未mock版本或修改产品。真实入口证据（本地验证日志，未随仓库分发）、角色截图（本地验证日志，未随仓库分发）。
- 真实main：78项界面交互检查通过，包括角色/图库导入撤销、语录/声音设置、跟随与桌面保存、提醒、模拟Codex账本/单价，以及默认DSH离线状态与刷新菜单反馈。无真实账号/音频采集。main记录（本地验证日志，未随仓库分发）记录该轮74项；后增DSH检查详见[迁移报告](TEST-MIGRATION.md)。
- 安全选定baseline：7/7通过（含Node/沙箱health、panel、widget、mouse、native shape）；panel display模拟100/125/150/200%四档4/4通过，不等于真实跨屏测试。DPI记录（本地验证日志，未随仓库分发）。
- 之前工作区失败的两项private I/O在发行包普通目录复核2/2通过：临时快捷方式COM保存/读取、临时目录launcher可达性，以及Electron Node asar更新助手的隔离目录交换；任务操作全mock，无真实启动注册。I/O记录（本地验证日志，未随仓库分发）。4个相关JS文件与源码相同；native EXE为发行时新编译，SHA与工作区旧二进制不同，不声称6个文件都字节相同，也不据此将所有历史错误归为唯一原因。
- 原forcefullyCrashRenderer故障注入仍FAIL：API约1ms返回，但未观察到Gone，不能把未证实的终止等同于产品handler失效，也不能用延时改绿。原始独立观测（本地验证日志，未随仓库分发）。
- 新增独立真实self-crash验证1/1通过：使用Electron45公开session附加fixture preload与sandbox允许的process.crash()，不替换产品preload、不改其参数；精确主frame/一次性nonce、真实image/runtimeReady后，观察到app+WC Gone crashed→产品before-quit→exit0，真实错误日志存在。严格证据（本地验证日志，未随仓库分发）。它证明产品崩溃处理链在此组合有效，但不覆盖原force API失败，也不是Root/bootstrap入口验证。

所有历史失败保留，未改Windows标签/ACL、未关闭sandbox、未以skip掩盖。安装器实际注册登录启动及真实安装仍未执行。

## 图形启动阻断

原包Electron45与官方exact win32-x64发行的73个文件逐字节相同，官方ZIP SHA256：`ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47`。

在开发工作区中，原包及官方版本的工具启动均出现进入JS之前的`0x80000003 / EXCEPTION_BREAKPOINT`。原完整图形轮17项未进入业务断言，历史结果保留，不能算通过，也不能据退出码推断显卡故障。

后置诊断修正：首次手动脚本错误地用固定argv位置取profile，把Chromium原生参数当成路径，已改为显式命名/env参数并加回归测试；批处理输出也已修正。修正后工作区的管理员启动可进入app-ready，但实际日志显示sandbox子进程创建失败18、真正Windows错误5。普通权限的工作区启动仍在JS前失败。只读检查发现工作区Electron及DLL继承Low完整性标签，而Chromium子进程启用NoLowMandatoryLabelImages策略；未更改这些标签/权限。

**2026-11-09 21:46后置对照通过：**在普通本地目录解压已校验完整包后，隐藏窗口报告记录broker为Medium、renderer-loaded、sandbox=true、visible=false、exit=0。没有换Electron、关sandbox、改标签/ACL或运行安装器。此结果证明发布包的Electron在正常目录可运行；带Low完整性标签的隔离工作区不适合作为该GUI映像的运行位置。

同一普通目录随后做了非安装界面自测；角色/菜单/面板/交互的后置结果另记，不把最小窗口通过冒充完整龙娘验收。真实账号、真实音乐采集与正式部署仍未执行。

## 原有安装保护与部署状态

- 记录的6个小鲸鱼/现有GPT订阅关键代码文件哈希未变。
- Desktop profile清单本身与开发前哈希不同：期间增加了`ds-harness-remote@0.6.4`依赖/条目，文件时间17:18:27。本任务未执行其安装，不回滚可能来自其他窗口的变化；**不声称整个profile字节未变**。详见原始哈希核对（本地验证日志，未随仓库分发）。
- 本任务未安装独立龙娘或桥接，未创建真实登录任务，未重启DSH；实际用户目录`~/.dsh-gpt-companion`、正式bridge state与desktop bridge package安装位置均未创建。
- 真实GPT账号/DSH鉴权端到端、可见窗口交互、跨屏DPI、真实音频设备、登录后启动与恢复仍待用户另外批准部署后验收。

## 交付定位

这是可在普通本地目录试用的独立Beta，不是所有真实环境已全面验收的稳定版。完整程序包与独立桥接包需分别安装，**尚未正式安装或连接真实账号**；部署仍需后续明确确认。源码提交与上游来源记录在包内构建记录，每文件SHA256写入完整性清单；发行校验值随最终包提供。角色素材仅供非商业个人副本，许可与上游贡献记录随包保留。
