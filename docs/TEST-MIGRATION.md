# 独立版上游测试迁移记录

## 范围与原则

- 参考版本：GPT-Niang `v1.4.0-beta.3`，commit `285cb464ebc700be640ecc6a7be4ca3a05ba5371`。上游参考源不随本仓库分发；如需对照，请从[上游发布页](https://github.com/T7moris/GPT-Niang/releases)获取同一版本并置于 `vendor/source/`（该目录已被 `.gitignore` 忽略）。
- 上游测试/fixtures已完整复制，身份隔离脚本此前处理40个文件。本轮仅修改 [desktop/tests](<../desktop/tests>) 内上游测试与fixtures（不修改工程师独占的 `companion-runtime*` / `companion-native*`）、[独立测试runner](<../desktop/scripts/test-companion.mjs>) 和本文档。实现bug交给Lead/实现工程师修复，不改主代码、不删断言求通过。
- 测试版本号 `1.3.x` / `1.4.x` 是合成历史/未来版本数据，不是当前发布版本。当前独立包身份 `dsh-gpt-companion@0.1.0-beta.2`，更新包名仍为 `dsh-gpt-companion-widget-vX-windows-js.zip`。

## 安全审计与隔离

在执行前已检查测试内的进程启动、安装、Codex注册、个人目录及网络边界：

1. installer/rollback/crash fixtures 的程序、个人数据、快捷方式、marketplace和模拟task记录均位于 `os.tmpdir()` 新建目录。调用 `install()` 时注入 `windows`、`stop`、`verify`；不会调用真实计划任务注册/删除，不运行安装CLI入口。唯一真实Setup操作是对临时路径读写快捷方式；crash recovery的临时FakeSetup仅记录调用。
2. 原生测试使用隐藏自有窗口、局部编译产物、临时launcher/worker，不修改实际DSH、启动任务、profile或原版插件。模拟PointerEvent/DPI不等同真人桌面、多显示器或音频设备验收。
3. 真实Codex CLI测试只允许Lead明确指定的 `CODEX_CLI_PATH`。仅执行本地fixture的 `plugin marketplace/add/list/remove`，所有注册/回滚位于临时 `CODEX_HOME`；不登录、不模型调用、不下载外部插件。缺失或不支持插件CLI能力必须报告失败，不能skip。CLI功能mock与真实CLI验证在结果中区分。
4. runner为所有测试/子进程隔离 `USERPROFILE`、`HOME`、`HOMEDRIVE/HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`CODEX_HOME`、`DSH_HOME`、`DSH_PROFILE`。清除继承的DSH/Codex/GPT_NIANG配置、代理、Node/Electron启动选项，以及 `OPENAI*`、`ANTHROPIC*`、`DEEPSEEK*` 和token/secret/password/credential/auth/cookie/API-key类环境值；不读取或拷贝凭据文件。
5. [test-safety preload](<../desktop/tests/fixtures/test-safety.cjs>) 在Node/Electron进程中拒绝真实HTTP(S)、真实DSH/系统任务命令及非临时Windows任务helper调用。更新测试必须注入合成transport。此preload是额外防护，不替代fixture的Windows依赖注入；不声称它是原生CLI的操作系统网络沙箱。
6. [headless状态审计](<../desktop/tests/headless-state-audit.test.mjs>) 单独使用 [headless-guard](<../desktop/tests/fixtures/headless-guard.mjs>)，覆盖全部外部进程启动API拒绝行为，而不是略过其条件测试。音乐golden C#产物由源码内 `.generated` 改放临时目录并清理。
7. runner日志仅写入Lead批准的 `audit/test-migration-*.log` / `audit/test-migration-*.json`。不改用户已安装DSH、原版插件、原版数据、宿主依赖或安全策略；不部署、不启动额外DSH服务。

## 有意迁移的测试契约

### 稳定本地安装目录

[setup-target测试](<../desktop/tests/setup-target.test.mjs>) 不再假设查询Codex marketplace发现安装位置。新契约是稳定的 `%USERPROFILE%/.dsh-gpt-companion/{app,state}`，验证独立JavaScript包/installation身份后保留独立个人目录；foreign/旧PowerShell/冲突身份拒绝。明确断言不执行Codex、不发现或重用原版安装。

### Codex注册显式可选

[事务回滚测试](<../desktop/tests/install-update-transaction.test.mjs>) 中专门注入plugin注册失败的分支、[crash fixture](<../desktop/tests/fixtures/install-crash.mjs>) 的注册阶段、[真实CLI注册测试](<../desktop/tests/plugin-registration.test.mjs>) 均显式 `registerCodex:true`，保留原注册/缓存/版本/偏好恢复断言。

新增 [默认安装隔离测试](<../desktop/tests/install-defaults.test.mjs>) 覆盖省略、`false`、字符串 `'true'`、数值 `1`、`null` 均不捕获或调用Codex、不改无关marketplace/备份，且保存 `registerCodex:false`、默认DSH源。它曾发现实现仍读取/拒绝无关marketplace的真实bug，交由Lead修复后复核通过。

### 独立更新feed默认禁用

[更新测试](<../desktop/tests/update.test.mjs>) 与 [SemVer测试](<../desktop/tests/prerelease-version.test.mjs>) 使用 `createUpdatePolicy('fixture-owner/independent-companion-test')` 和内存release/ZIP/checksum transport，显式传入 `{policy}` / `releasePolicy`，绝不将上游仓库当可用源。

新增 [update-policy测试](<../desktop/tests/update-policy.test.mjs>) 验证默认policy字段全null、`RELEASE_API===null`，`download`在request调用之前拒绝，manual/automatic updater返回明确未配置且fetch计数为0；同时拒绝上游repo、非法repo及跨仓库URL，保留本地已校验包/事务回归。它曾发现 `createUpdatePolicy('../repo')` 被接受，交由Lead修复后复核通过。

### 可选原Codex功能与默认DSH分离

上游真实worker/refresh/quota/UsageService及functional-main/music-drag fixture明确 `hostSource:'codex'`，继续验证原可选来源和模拟app-server，不把新默认DSH源误认成旧fixture失败。新的默认DSH、snapshot/断开/ledger/shard覆盖由运行时工程师维护的 `companion-runtime*` 测试提供；本轮不修改这些测试。

### 原生身份与资源

[native-audit测试](<../desktop/tests/native-audit.test.mjs>) 的fake Bridge.cs补独立namespace闭合括号，仍编译真实音乐内部 `GptMusic*` types，不改算法基线。[resource-regressions测试](<../desktop/tests/resource-regressions.test.mjs>) 适配源感知 `isHost` / `source:image` cache，保留过期/倒时钟/256项上界/句柄释放断言，新增同PID变更为非宿主镜像必须拒绝，逐次OpenProcess断言与防PID复用安全语义一致。

### 原始PowerShell只读对照

[BMP兼容测试](<../desktop/tests/bmp-compatibility.test.mjs>)、[设置兼容审计](<../desktop/tests/compatibility-audit.test.mjs>) 默认对照目录为vendor原版源；可用 `GPT_NIANG_LEGACY_ROOT` 显式指定。只提取纯函数/片段在临时数据上运行，不启动原版挂件或迁移真实安装。

## 唯一不适用项（非skip）

[legacy-bridge测试](<../desktop/tests/legacy-bridge.test.mjs>) 原文件保留，独立runner明确从执行清单排除并在每份JSON报告写理由。它要求 `migration/legacy-bridge.mjs`、原PowerShell旧updater接受桥接包、对原版同身份升级/交接，这与独立版不得更新原版及不需要旧版自动迁移的目标冲突，且独立工程没有该migration模块。**不是已通过，不算skip，不代表具备原版升级能力。**

其余上游测试不任意排除/添加skip；例如现存独立installer crash recovery / legacy-shaped临时fixture仍有实现和独立事务价值，保留运行。

## 运行方式

在 `desktop` 目录使用 Node v24（DSH 自带的运行时可执行文件，或系统 Node），例如：

```powershell
$env:CODEX_CLI_PATH='<你的 profile>/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
node scripts/test-companion.mjs --suite=full
```

- `full`：发现全部顶层 `.test.mjs`，仅排除上面一个不适用文件，包含两位工程师新增测试。
- `core` / `integration`：稳定核心子集与其补集，方便并行实现期间定位。
- `non-electron` / `electron`：不创建Electron GUI的文件与包含Electron GUI的文件（后者包括mixed native-audit）；前者仍可使用Electron的Node模式。
- `--files=a.test.mjs,b.test.mjs`：显式针对性复核，报告会列出实际文件，不冒充full。
- runner测试并发为1、默认单项超时120秒；headless另一个preload分组计数相加。日志JSON保存实际pass/fail/cancelled/skipped/todo和失败名，清理失败也令退出码非零。

## 当前已记录执行与缺陷证据

| 批次 | 实际结果 | 说明 |
| --- | --- | --- |
| 首轮core日志（本地验证日志，未随仓库分发） | 111 tests：109 pass / 1 fail / 1既有条件skip | 非法repo被接受；已交Lead修复。随后runner改为真正启用headless guard，不再留下此条件skip。 |
| 默认安装首次日志（本地验证日志，未随仓库分发） | 针对性5 tests：0 pass / 5 fail | 默认安装错误检查无关marketplace；Lead修复。 |
| 修复复核日志（本地验证日志，未随仓库分发） | 16 pass / 1 runner导入错误 | install-defaults5、update-policy3、setup-target4、resource4均通过；headless导入使用Windows裸路径导致错误，runner已改file URL。 |
| Electron最小诊断日志（本地验证日志，未随仓库分发） | 3 tests：1 pass / 2 fail | Electron45 Node模式可启动；default GPU与`--disable-gpu`均在JS-entry前约40ms退出`0x80000003`。未启动main/installer，未放宽sandbox。最初怀疑EGL文件不完整，后由Lead核验官方exact45全部73个文件与原runtime一致、missing=[]/different=[]排除该假设。尚不能宣称GUI通过。 |
| 首次非GUI完整子集（本地验证日志，未随仓库分发） | 58 files / 395 tests：371 pass / 23 fail / 1 skip | 旧fixture仅复制runtime，缺新shared协议与package身份；已按真实依赖补齐。2个真实临时文件操作报权限错，原始错误保留。既有macOS平台条件skip未改。 |
| copied-runtime/launcher复核（本地验证日志，未随仓库分发） | 针对性6 files /21 tests：20 pass /1 fail | worker健康/长查询/stop、MCP与supervisor通过。剩余quota fixture因复制type:module改变extensionless CommonJS app-server解释方式，已仅写合成公开包身份修复，未改业务断言。 |
| 官方exact45对照（本地验证日志，未随仓库分发） | 针对性4 tests：1 pass /3 fail | Lead已双重校验官方zip SHA256 `ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47`；官方runtime同样default/disable-gpu/无NODE_OPTIONS均GUI-entry前崩溃，不能归因上游文件缺失或本实现页面。 |
| 最小环境+native logging诊断（本地验证日志，未随仓库分发） | 针对性5 tests：1 pass /4 fail | default/disable-gpu/无NODE_OPTIONS/白名单环境均`EXCEPTION_BREAKPOINT`、未进入JS、native log未创建；stack仅`(No symbol) [0x7ff69a92631a]`。没有已安装cdb/windbg/procdump，Application近期无事件；未安装调试器或更改安全策略。 |
| **最终full完整日志（本地验证日志，未随仓库分发） / JSON报告（本地验证日志，未随仓库分发）** | **69 files / 417 tests：395 pass / 21 fail / 1 skip / 0 cancelled / 0 todo，exit 1** | 清理成功 `cleanupError:null`。17项GUI进程初始化失败、4项真实临时文件权限失败；没有剩余已经触达的业务断言失败，但GUI未执行，绝不能宣称all pass。 |
| 最后一次私有profile对照（本地验证日志，未随仓库分发） | 针对性2 tests：1 pass /1 fail | Lead要求的一次性有依据诊断：预创建私有profile/crash-dumps并在.cjs前明确`--user-data-dir`、`--crash-dumps-dir`；仍约40ms pre-JS `EXCEPTION_BREAKPOINT` / `0x80000003`，log未创建，停止诊断。 |

以上早期失败日志保留，不抹除失败历史。

### 最终通过范围

最终full包括全部70个顶层测试文件中的69个（唯一不适用项为legacy-bridge，已单独解释）。395项通过覆盖：纯核心settings/布局/语录/音频/角色、ZIP/校验/独立feed默认禁用、默认安装不注册Codex、显式注册和回滚、真实临时Codex CLI插件注册/版本/缓存/启用偏好恢复、安装崩溃恢复、Node更新事务、完整原可选Codex worker/refresh/quota/账本/完成提醒及新的DSH runtime/native测试。

补齐copied-runtime的shared协议与package身份后，worker健康、长查询heartbeat、全部stop/handoff路径、MCP缓存launcher、supervisor输出/退出码、quota fallback均通过。特别是quota fixture没有因默认DSH或extensionless CommonJS语义更改而被删除/放宽断言。

1个skip是原有 [macOS missing-app平台测试](<../desktop/tests/codex-path.test.mjs#L77>) 在Windows上的条件，未新增skip。headless guard本轮真实运行通过，不再条件skip。

### 最终失败分类（21项，全部保留）

**A. GUI初始化环境限制：17项。** 所有对应子进程返回 `2147483651`（`0x80000003`），没有页面业务断言证据：

- [Electron最小health测试](<../desktop/tests/electron-health.test.mjs>) 4种GUI启动模式（默认、禁GPU、去NODE_OPTIONS、白名单环境）；Node模式通过。
- [实际main/menu全流程](<../desktop/tests/functional-main.test.mjs>)、[renderer crash生命周期](<../desktop/tests/installation-renderer-health.test.mjs>)、[鼠标不激活](<../desktop/tests/mouse-activation.test.mjs>)、[音乐拖动](<../desktop/tests/music-drag.test.mjs>)。
- [实际lamp页面](<../desktop/tests/native-audit.test.mjs#L27>)、[Electron原生region no-op](<../desktop/tests/native-noop.test.mjs>)。
- [panel显示](<../desktop/tests/panel-display.test.mjs>) 的100/125/150/200%四项、[panel功能](<../desktop/tests/panel-functional.test.mjs>)、[panel交互](<../desktop/tests/panel-interaction.test.mjs>)、[widget交互](<../desktop/tests/widget-interaction.test.mjs>)。

官方exact45与原runtime文件逐字节一致、最小安全本地fixture和私有pre-JS profile参数也失败。这证明限制不依赖本项目页面，但**没有已确定根因**；不推断成已修复，更不以禁用sandbox或替换版本掩盖。Lead保留的是待实机验收开发版，不是已验证用户可用成品。

**B. 临时文件操作权限环境限制：4项，未诊断修复。** 这些是原始文件系统/COM错误，不是captured pipe grandchild `spawn EPERM`：

| 测试 | 原始操作/路径与错误 |
| --- | --- |
| [launcher/shortcut在程序目录缺失时可达](<../desktop/tests/install-update-transaction.test.mjs#L153>) | `%TEMP%\gpt-js-transaction-14StyR\startup.lnk`，Setup COM `Save()` → `-2147024891` / `0x80070005` `E_ACCESSDENIED`。 |
| [Electron Node update-agent raw asar](<../desktop/tests/install-update-transaction.test.mjs#L319>) | `mkdir %TEMP%\gpt-js-transaction-Uk8HhI\data\update-agent-lock` → `EPERM`。 |
| [Electron Node archive staging raw asar](<../desktop/tests/native-audit.test.mjs#L33>) | `mkdir %TEMP%\gpt-native-fix-fqwHW0\updates` → `EPERM`。 |
| [Electron Node installer raw asar](<../desktop/tests/native-audit.test.mjs#L39>) | `mkdir %TEMP%\gpt-native-fix-XrTJlW\source\native` → `EPERM`。 |

已加载Windows权限诊断skill，但本会话审批不可用，且测试工程师固定范围不允许修外部Temp权限；没有运行权限修复脚本，没有手改ACL/owner/deny，没有通过换路径重试相同被拒操作。原始stderr和精确路径保存在最终full日志，临时fixture已按既有清理流程清除。是否需要受控权限诊断由用户后续授权决定。

### 证据时间边界

最终full开始于2026-11-09 09:33:07Z（北京时间17:33），此后运行时工程师按Lead要求新增“主对话列表最多200条、all/today总账不截断”的小修和相应测试。**上述417项full不能冒称是该后续小修之后的全量验证**；后续改动需以运行时工程师的针对性验证报告为证。最后私有profile诊断仅运行2个Electron health项，不代表第二次完整回归。

后置定向验证（运行时工程师回报，未由本测试工程师重复执行）：bundled Node执行 `--test tests/companion-runtime.test.mjs`，**13/13 PASS、exit 0、1474.4314ms**。新增205会话case同时验证仅公开最近200个候选、selected只能选候选、all/today仍累计全部205；修改仅为core排序后slice一行与该测试。此为[运行时测试](<../desktop/tests/companion-runtime.test.mjs>) 的后置定向证据，不改变前述完整回归417项计数或21项环境失败结论。

## 后续AUD-1..5安全补审（task-8）

前述full结果仅代表安全补审前的源码，不作为后续安全修复已关闭的证据。新回归位于[install/update安全测试](<../desktop/tests/install-update-security.test.mjs>)，不修改生产guard，不重复GUI、不触碰真实安装/计划任务/账号。

| 审查项 | 新回归的不可掩盖证据 | 状态 |
| --- | --- | --- |
| AUD-1 个人目录归属/cleanup | 原版与unknown非空数据、错误架构/绑定root、recover/cleanup/stage拒绝；调用前后完整fixture树SHA一致，并记录fs写入/删除/锁/rename及kill/helper调用必须为零。合法owner不能替代root身份。 | **8/8 PASS** |
| AUD-2 早期身份与回滚 | 错root/backup的name/architecture/binding ×normal/recover矩阵；伪恢复journal含本测试PID，测试拦截真正kill并断言零尝试；另在实际事务已授权后篡改backup身份，检查恢复rename为零且root/backup字节不变。 | **11/11 PASS** |
| AUD-3 源身份/哈希先于helper | direct install源name/architecture/version错误；提取执行真实preflight函数，对源身份/实际文件hash损坏断言先于whoami/native setup，树不变。不是仅grep字符串。 | **6/6 PASS** |
| AUD-4 选定Codex home与source | 真实capturePluginRegistration函数配本地mock CLI，对照临时ambient/custom home；foreign source必须零remove，合法source仅在选定home remove一次且文件不变。 | **2/2 PASS** |
| AUD-5 必需DLL/shared | 删除Input DLL或shared协议后重算完整自洽SHA manifest，仍须拒绝ZIP；完整独立包正向通过。 | **3/3 PASS** |

正向事务fixture使用[公共独立安装fixture helper](<../desktop/tests/fixtures/independent-install.mjs>)明确生成新包name/architecture/version、installation appDir/dataDir绑定及data owner。该helper只用于新建合成独立JS fixture；不在原版/PowerShell目录上补新身份来骗过guard。真正旧PowerShell/无归属updateAgent接管分支改为负向拒绝/零副作用；独立JS正向crash/recovery保留原全部phase和自定义内容保存断言。原交互重检/恢复失败测试改为直接调用独立installer的beforeStop/恢复hooks，原各phase断言仍在；另加legacy wrapper拒绝独立JS的零hook负向，不声明支持原版迁移。临时worker/MCP clone补复制真正的[storage guard](<../desktop/src/core/storage.mjs>)，不mock掉它；旧Codex refresh/lock/stop正向fixtures在写mock配置前用helper生成有效marker。helper自身限制写入os.tmpdir下新合成目录，拒绝原版/宿主保留目录名。

安全定向30/30日志（本地验证日志，未随仓库分发） / JSON（本地验证日志，未随仓库分发）：exit 0、无fail/skip/cancelled。初轮30项中的“无journal unknown data recover”曾暴露入口直接no-op，Lead加入口归属guard后保持原负向断言通过；另两项是新拒绝消息正则和VM缺少真实safePackagePath上下文，已补齐而非放松零副作用断言。

最终runtime菜单小修定版后的core日志（本地验证日志，未随仓库分发） / JSON（本地验证日志，未随仓库分发）：21 files、111/111 PASS，exit 0，无fail/skip/cancelled。包含真正启用的headless进程拒绝测试。菜单VM抽取边界适配新的refresh回调写法，原业务断言保留。

非GUI全量首轮438项日志（本地验证日志，未随仓库分发）：429 pass /8 fail /1既有平台skip。5项是上述旧wrapper/拒绝消息fixture适配；2项为既有临时lnk与Electron Node mkdir权限失败；另1项为quota fixture finally删除临时root时EPERM。quota现保存并重抛主异常、仅附加cleanup异常，避免finally掩盖业务bug；定向复核（本地验证日志，未随仓库分发） 16项15pass1fail显示独立crash/recovery全部通过，quota所有业务断言通过、仅teardown目录删除失败，未绕过或重试权限。

**最终non-electron统一结果：完整日志（本地验证日志，未随仓库分发） / JSON报告（本地验证日志，未随仓库分发）：60 files、440 tests = 436 PASS / 3 FAIL / 1既有macOS平台SKIP / 0 cancelled / 0 todo，exit 1。** 包含全部30项安全矩阵、111项core和运行时工程师新controls/旧Codex回归。已触达业务断言没有剩余失败；不代表未运行的GUI通过。

最终3项失败均保留原始错误：

1. 真实临时Setup快捷方式 `%TEMP%\gpt-js-transaction-8CKa3C\startup.lnk` COM Save `E_ACCESSDENIED` / `0x80070005`。
2. Electron Node update-agent `mkdir %TEMP%\gpt-js-transaction-3u33Yh\data\update-agent-lock` → `EPERM`。
3. quota fallback **所有业务断言通过**后，finally删除 `%TEMP%\gpt-niang-direct-fallback-6Lhl9H` → `EPERM`。其根因可能涉及权限/句柄资源，未确诊；仅记为teardown I/O失败，不将整项改成pass、不重试权限操作，也不让cleanup异常覆盖先前业务异常。runner自身隔离目录清理报告 `cleanupError:null` 不代表这个独立fixture的目录清理完成；该路径可能保留待用户后续授权处理。

本次没有运行GUI，原始full的21项环境失败说明不删除、不改成skip或pass。为避免未来GUI启动后被合法新guard误拦，仅给[functional-main](<../desktop/tests/functional-main.test.mjs>)、[music-drag](<../desktop/tests/music-drag.test.mjs>)、[renderer-health](<../desktop/tests/installation-renderer-health.test.mjs>) 正向临时data补owner marker，三文件仅做bundled Node `--check`成功，**不计为GUI通过**；[installer Electron fixture](<../desktop/tests/fixtures/installer-electron.mjs>) 也只补合法候选source身份，未重跑GUI。

此轮runtime菜单反馈小修完成并冻结后才执行末轮core/non-electron。运行时工程师另报controls+runtime定向26/26 PASS（2353.2702ms），其先前大回归87/87早于菜单小修；本测试工程师最终440项日志已覆盖冻结后的非GUI源码，不把工程师自报结果混入本runner计数。

## 后置证据：quota fixture正式停止协议

Lead在task-8完成后要求仅做一次有依据的fixture生命周期修正。只读审阅发现，[quota fixture](<../desktop/tests/quota-fallback-integration.test.mjs>) 原teardown是Windows `child.kill()`后只等`exit`立即删目录；[watch](<../desktop/runtime/watch.mjs>) 提供`stop.flag`协议并在正常exit清理owner/heartbeat，而[readUsage](<../desktop/runtime/usage.mjs#L112-L131>) 每次查询自行spawn app-server，结束时stdin.end/kill之后立即resolve，不等待该子进程close。当前watch没有持久agent对象或`agent.close`方法，因此不能声称调用过该方法，也不能将先前EPERM无证据认定为ACL。

本轮**仅改fixture**：MCP使用stdin EOF；向本fixture私有data写正式`stop.flag`；对两个已知fixture进程带6秒上限等待`close`并要求正常退出；断言worker owner/heartbeat消失后，路径校验、**仅调用一次**rm并断言临时目录确已删除。未重试rm、未改ACL或权限、未kill父进程/其他进程、未修改watch/usage实现；业务断言和保留主异常机制不变。

仅执行一次针对性验证：日志（本地验证日志，未随仓库分发） / JSON（本地验证日志，未随仓库分发），**1/1 PASS、0 fail/skip、exit 0**，test 2121.2618ms，runner `cleanupError:null`，fixture自己的完整删除断言也通过。这支持先前失败与fixture停止/资源释放时序有关，但不是对旧现场ACL或所有子孙进程的完整诊断；旧失败现场未被清理或更改。

这是**task-8终结后的单项证据**。没有重跑core、non-electron或GUI，也不将原440项436pass/3fail/1skip改写成另一组全量计数；原两项lnk/mkdir I/O失败与GUI限制仍未复核，旧日志完整保留。

## task-12：用户授权普通目录的隔离GUI回归

用户随后明确批准普通测试目录，使用其中已正常解压的发布包Electron/native，不再运行Low工作区exe。本轮没有修改任何安全标签、ACL或sandbox开关；没有真实安装、注册启动项、读取真实账号或采集真实音乐/音频。该授权是后续新范围，**不删除原始21项失败，也不改写旧417/440项计数**。

### 最终选定结果

统一JSON、逐进程原始stderr、截图SHA（本地验证日志，未随仓库分发）：**10个文件中的18个选定顶层测试 = 17 PASS / 1 FAIL / 0 SKIP / 0 cancelled**。这是经安全审查选出的GUI及两项private I/O，不是full suite。14个真实renderer场景中13项通过、1项旧force API故障注入未完成；其余为Node解释器/纯readiness判定/两项临时I/O。

| 分组 | 结果 | 直接证据 |
|---|---:|---|
| Electron解释器+显式隔离sandbox renderer、panel functional/interaction、widget renderer、mouse activation、native no-op/GDI | 7/7 PASS | baseline（本地验证日志，未随仓库分发） |
| panel display 100/125/150/200% **模拟raster scale** | 4/4 PASS | display（本地验证日志，未随仓库分发） |
| 真实main完整交互，含Codex旧路径与切换DSH后手动刷新 | 1/1 PASS，**79个内部业务检查** | main（本地验证日志，未随仓库分发） |
| readiness纯判定 + 真实renderer故障注入 | 1 PASS / **1 FAIL** | renderer诊断（本地验证日志，未随仓库分发） |
| 明确另行批准的private startup.lnk与Electron Node asar目录交换 | 2/2 PASS | private I/O（本地验证日志，未随仓库分发） |
| 独立sandbox preload nonce self-crash → 真实产品handler | 1/1 PASS，旧force失败不替换 | self-crash（本地验证日志，未随仓库分发） |
| 真实包目录 → default_app metadata → bootstrap → main single verify | 1/1 PASS，runtime.version=0.1.0-beta.1 | bootstrap（本地验证日志，未随仓库分发） |

main覆盖角色气泡/台词、菜单、人物缩放/图库导入移除撤销、音效文件选择与UI试听入口（输出静音、native capture stub）、语录权重/草稿/校验、跟随/桌面设置、完成提醒、synthetic Codex用量/单价/焦点/窄窗口、反复开关与退出。新DSH段通过真实host-source命令切换、菜单手动刷新打开quota、空隔离DSH_HOME没有连接时windows为空，并额外断言真实renderer DOM存在“暂无法读取”及含DSH的tooltip。**不是实际DSH连接/账号额度验证**。

### 唯一未解决的故障注入FAIL

原始阶段日志（本地验证日志，未随仓库分发）证明：`import-start → index/lamp loaded → import-done → window-found → widgetVerification true → runtime.json.rendererReady true → crash-requested`。随后原12秒deadline触发，未观察到`render-process-gone`或`before-quit`；父fixture原15秒收尾，退出断言失败。`crash-requested`记录在API调用之前，**未记录returned，不能据此证明调用已经返回或OS进程确已终止**。

仅给[故障fixture](<../desktop/tests/fixtures/renderer-crash.cjs>)补阶段日志和受原总deadline约束的最多1250ms executeJavaScript等待；原12秒、rendererReady、退出0、错误log断言均保留，没有换offscreen或延timeout，没有修改main/native。已报Lead并交task-13只读核对。运行时工程师随后报告Electron45 Windows强制崩溃路径可能有最长10秒dump等待和异步Gone事件；这只是后续区分方向，**不把本项改成通过，也不据现有日志断言main的handler本身有错**。

### 后置观测：实测不支持10秒dump耗尽原预算

Lead根据[Electron45 native](https://github.com/electron/electron/blob/v45.0.0/shell/browser/api/electron_api_web_contents.cc#L3707-L3730)、[固定Chromium156 Windows最长10000ms等待](https://github.com/chromium/chromium/blob/156.0.8078.48/chrome/browser/hang_monitor/hang_crash_dump_win.cc#L14-L28)及[异步Gone发布](https://github.com/electron/electron/blob/v45.0.0/shell/browser/api/electron_api_web_contents.cc#L2433-L2493)，批准一轮仅观测包络，要求保留原12秒超出事实、不冒原契约通过。

观测报告（本地验证日志，未随仓库分发） / 完整最终state（本地验证日志，未随仓库分发）显示：

- startup/runtime-ready **1349ms**，调用前 **1350ms**，距旧12秒尚 **10650ms**。
- API returned **1351ms**，native调用实耗 **1ms**，不是本轮10秒dump等待。windowId/webContentsId均1；调用前metric目标PID为38572、Tab、sandboxed=true/untrusted（正常renderer sandbox，不是修改exe标签）。调用后getOSProcessId仍返回38572、wrapper未destroy，**这些getter不能证明此时renderer OS进程仍活**，本轮没有OS定点活性探测。
- 至25秒观测包络仍无app/wc Gone、无before-quit；旧12秒超出标记true。主runtime heartbeat仍更新至相对启动约24513ms，不支持此前main整体死锁的猜测。child在25007ms记录app.exit(7)路径，父28秒收尾实际code=null/signal=SIGTERM，目标error log未出现。包络没有被计为通过。

因此“本轮只是10秒native调用耗尽12秒”**未获实证支持**；不能据此拆预算或延时改绿。已将逐phase/state交runtime-engineer/Lead继续只读区分API silent return、Shutdown未达终止等方向，不断言main cleanup有错。没有再自动开窗口或改产品。原默认12秒/15秒仍在，额外25秒/28秒仅由显式observation flag启用并另列。

另按[Electron v45固定文档](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md#L1346-L1357)，error-log预期合法reason已由仅`crashed`订正为`crashed|killed`；仍必须真实Gone、rendererReady、退出0、实际错误日志。**当前失败尚未到达该regex，故此合理预期修复并不关闭本次FAIL，未因此再跑/宣称通过**。

### 独立self-crash真实验证产品handler（不替换旧force）

Lead另行批准的[独立fixture](<../desktop/tests/fixtures/renderer-self-crash.cjs>)采用公开[session.registerPreloadScript](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md#sesregisterpreloadscriptscript)附加[测试preload](<../desktop/tests/fixtures/renderer-self-crash-preload.cjs>)，不修改真实product preload文件或webPreferences参数。preload只在本widget exact fileURL/主frame运行，nonce一次性；driver再次验证senderFrame===mainFrame/URL/目标WC，原gpt bridge、真实image/runtime.ready及sandbox/contextIsolation/nodeIntegration后才发送一次nonce，隔离preload通过公开[process.crash](https://github.com/electron/electron/blob/v45.0.0/docs/api/process.md#processcrash)崩溃自己的renderer。未在page主world eval process、未手工emit事件、未kill任意renderer PID、未用私有binding。

完整self state（本地验证日志，未随仓库分发）：registered25ms → 主frame armed249ms → image1254×1254/runtimeReady及隔离flags确认1322ms → 单nonce发送1322ms、preload同步确认1323ms → **真实app与WC Gone(reason=crashed)1331ms → 产品before-quit1332ms → OS exit0/无signal1341ms**，真实renderer-errors日志存在。独立1/1 PASS证明这条真实renderer死亡路径下产品handler和正常退出有效，**旧force API 1ms/noGone FAIL仍存在，二者不能合并说旧case已修复**。

初次只到armed的fixture失败（本地验证日志，未随仓库分发）因为getLastWebPreferences不返回preload字段，额外debug检查TypeError且nonce未发。仅改为真实product preload SHA未变、原gpt/image握手证明，严格隔离flags不变；未将此基础设施错误伪称产品handler失败或删除历史。

### 真实bootstrap单verify（非suite）

真实入口最终state（本地验证日志，未随仓库分发）来自Electron直接以包目录为app入口，参数只有candidate/bench/hidden-test/`--verify`/显式私有data-dir等，不用`--verify-suite`（该分支会setMusic）。[Node早期/loaded guard](<../desktop/tests/fixtures/bootstrap-entry-safety.cjs>)使用公开[process loaded事件](https://github.com/electron/electron/blob/v45.0.0/docs/api/process.md#event-loaded)，仅browser主线程安装Electron策略；Node/worker模式不误装。归档的bootstrap-loaded标记证明app可用、窗口数0、beforeAnyWindow=true、guardInstalled=true。

真实default_app读取原package metadata并加载原bootstrap/main，无getVersion/mock/setVersion：**verification.ok=true、image1254×1254、runtime.version=0.1.0-beta.1、runtime.rendererReady=true、panels=[]、music=false、OS退出0、stderr为空**。角色PNG已实际读取核对。动态import-main旧fixture的45.0.0是default_app脚本载体元数据边界，不能当成此真实包入口的版本结果。全部产品受保护文件hash仍未改变。

### 可打开的实际图像

均为自己BrowserWindow的真实`webContents.capturePage`，不是AI生成或整个用户桌面截图；已读取核对下列关键图像。图片中的用量/单价来自明确合成的临时日志，不代表真实订阅数据。

- 真实bootstrap单verify角色（本地验证日志，未随仓库分发）。
- 角色与DSH不可用额度气泡（本地验证日志，未随仓库分发） / sandbox与窗口metadata（本地验证日志，未随仓库分发）。
- 真实main角色图库（本地验证日志，未随仓库分发）。
- 独立版菜单（本地验证日志，未随仓库分发）。
- 合成日志的用量/记账窄窗口（本地验证日志，未随仓库分发）；明暗/模拟raster图像及其他图片见统一JSON中的26张PNG及SHA。

较早main中途截图（本地验证日志，未随仓库分发）处于动画并仍选中图库导入的合成紫色sprite，不作为DSH文字显示/真实角色证据；后置用真实character-select切回builtin，等待真实DOM反馈与动画，再捕获上面的最终图。没有涂改截图或调整产品渲染代码。

### 隔离与fixture修复

- 所有实际测试子进程的USERPROFILE/HOME/APPDATA/LOCALAPPDATA/CODEX_HOME/DSH_HOME/TEMP/TMP均在普通测试root内；env剥离secrets/proxy/既有DSH/Codex配置。使用普通目录内Electron作Node测试解释器，源模块与native组件也来自该包。
- [Node/process guard](<../desktop/tests/fixtures/gui-safety.cjs>)阻Node HTTP/fetch/TCP、真实DSH/Codex/schtasks、安装/Start入口；native bridge stdin的`op:start`硬拒。已读[Bridge入口](<../desktop/native/Bridge.cs#L25-L36>)确认只有该op会构造真实capture。GUI entry在创建任何窗口前安装[Electron权限/网络/静音guard](<../desktop/tests/fixtures/gui-electron-safety.cjs>)，拒media权限及Chromium HTTP/WS；14份GUI policy及1份bootstrap loaded-before-window标记已归档。额外guard记录的blocked operation为0，case没有靠被阻断后的降级伪装业务成功。
- [截图helper](<../desktop/tests/fixtures/gui-artifacts.mjs>)只允许本fixture拥有的local file/data页面窗口，输出限制在授权root。发布包src/runtime/shared/native/ui/Electron/manifest执行前后hash均未改变。
- private I/O只按精确name pattern运行两项。Windows task操作全mock；实际Setup仅执行private `.lnk` write/info，更新助手只交换新临时合成app并终止身份匹配的fixture进程，**不是部署或真实安装**。没有重试失败权限操作。
- 源比较更正：4个JS source与当前项目一致，**包内Start/Setup exe SHA与当前项目不同**（原始JSON均保存两端hash）；未判明是否编译差异，不能宣称二进制字节相同或仅位置差异的完整因果证明。两项在本发布包普通目录里通过、本包运行前后未改动的事实不受影响。
- 合理fixture修复已同步项目：functional-main用明确missing Codex路径，stub当前activateHost以免激活真实宿主；新source radio加入后按明确桌面/跟随label而非旧索引点击，原真假断言不变。早期baseline基础设施失败（本地验证日志，未随仓库分发）、Chromium argv误作root的失败（本地验证日志，未随仓库分发）和旧radio索引失败（本地验证日志，未随仓库分发）完整保留；不把这些attempt叠加进最终18个unique cases，也不隐藏失败史。

**未运行**：music-drag（明确禁止真实/不确定音乐采集）、native-audit混合安装/采集suite（不执行其安装/录音路径，仅另行许可的两项private I/O精确复核）、真实DSH连接/账号登录、真实音频采集/扬声器回环、部署/开机启动、物理多显示器/系统DPI切换。模拟raster与隐藏renderer检查通过不替代这些验收。task-11的105/105定向证据和旧non-electron440项各保持独立时序，不混为一次full通过。

### task-12收尾冻结

最终按18 selected / 17 PASS / 原force API 1 FAIL交付，不再扩大case或自动运行测试。16个本任务后台jobs均已collect且completed；最后只读按TestRoot ExecutablePath过滤Win32_Process返回 **TestRootProcessCount=0**，未额外kill任何进程，收尾记录（本地验证日志，未随仓库分发）。测试/fixture与报告在此冻结；测试子进程已收尾，私有profile及证据目录保留以便复核，不代表安装。产品src/runtime/native/UI未修改，后续发布包重打由Lead单独处理。

## 不可由本回归宣称的验收

临时文件/进程/隐藏窗口成功不代表真实DSH连接、真实登录账号、多显示器/系统DPI切换、扬声器回环音乐捕获或真实部署/开机启动成功；这些须后续另行授权和人工验证。默认更新源无配置是明确不可在线更新，不是“已验证在线升级”。
