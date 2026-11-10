# 功能对照与验收边界

基线为 GPT-Niang `v1.4.0-beta.3/windows-js`，源码提交 `285cb464ebc700be640ecc6a7be4ca3a05ba5371`。本工程是独立移植，不是小鲸鱼换皮，不依赖小鲸鱼运行。保留 T7moris、GPT-Niang contributors 与上游语录署名。此表是验收目标，不是未经验证的实机通过声明；实际结果以交付验证报告为准。

| 功能 | 原版能力与独立版要求 | 主要实现 |
|---|---|---|
| 官方额度 | 实际窗口、套餐、个人限额、剩余百分比、>=75/90%警示、重置倒计时/本机时间；无数据/过期/未登录真实提示；不以tokens算百分比 | desktop/runtime、src/core/quota.mjs、shared协议 |
| 账号隔离 | 换账号/身份不明清旧快照，窗口不存在不猜5h/周；同账号失败也标注旧数据 | DSH client status→usage→status bracket，host epoch/lease/TTL，runtime双读host |
| 刷新 | 可见定时查询、隐藏节流、手动刷新、合并并发；桥接不绕过订阅插件缓存 | 现有subscription只读RPC+新bridge；离线不伪装实时 |
| 形象图库 | 内置龙娘1；PNG/JPG/BMP/GIF首帧导入、20MiB/4096边/1600万像素限制、2048边缩小、选择/删除/撤销/损坏回退 | 保留characters.mjs/gallery.mjs与sharp/native解码 |
| 外观 | 人物/气泡各0.6–2.5倍，三档预设，隐藏按钮、悬停、左右镜像但文字正向，alpha穿透 | 原Electron界面、原生区域和鼠标补丁 |
| 语录 | 全部39句及权重/quote-layouts；编辑/备份恢复/非连续重复；两个独立角色点击模式；5秒收起 | 保留quotes/scene/UI，语录数量以实际JSON而非旧许可33句文案为准 |
| 自动语录 | 60/300/900秒预设，自定义10秒至24小时，可输入小数分钟；忙/隐藏/音乐不补播 | 保留auto-quote-interval与main计时 |
| 变色 | mixed默认0.5%全体、3%仅文字；其他原后端模式及暂停保留，低额警示不被覆盖 | 保留colors及settings，不误宣称原菜单有全部颜色开关 |
| 点击声音 | press/release独立WAV、内置/自定义/无声、导入/试听/音量、快速连点取消不排队 | 原audio/ClickSequence，WAV<=10MiB且<=5秒 |
| 音乐律动 | 真WASAPI回放采集、播放器优先/系统回退、节拍/能量/道具/抓放惯性，停用即释放 | 原music-audio.cs+motion/art；无麦克风采集/落盘/上传 |
| 跟随模式 | 严格DSH主窗身份；可切回Codex；移动/遮挡/最小化/DPI/边缘吸附/不抢焦点 | 独立NativeWindows host身份层+原原生实现 |
| 桌面模式 | 跨屏自由拖动、位置独立保存、可选置顶、恢复右下角 | 保留原窗口和布局逻辑 |
| 完成提醒 | 仅live正常完成的主会话，失败/取消/子代理不提醒；提示不抢前台，主动点击返回宿主 | DSH官方session生命周期+独立监控；Codex源保留原监控 |
| 用量四卡 | 主对话累计、最近一轮、今日、总账；子代理计入账本但不合并进主卡 | 原UsageLedger+DSH数值适配器；未知明确显示 |
| 手动定价 | provider/model精确和*通配；普通输入/缓存读/缓存写/输出单价；CNY/USD分开；缺价不按零元 | 保留原BigInt计价引擎与规则UI；provider/model无法证明则unknown |
| 数据语义 | 缓存包含于输入、推理包含于输出；重试替换/重复事件不双计，fork仅新增 | DSH官方tokenUsage投影校验；分模型数值导出，修正替换对应shard |
| 数据目录 | DSH默认数值数据源，可手选Codex根目录/恢复自动；无聊天正文/密钥复制 | 桥接白名单文件+独立worker，明确最近活动≠当前选中 |
| 控制/MCP | query/show/quote/menu/characters/music/stop/status及独立MCP用量查询 | 保留runtime命令，仅独立命名空间，默认不改Codex注册 |
| 安装启动 | 独立目录/APPID/launcher/任务/快捷方式/锁；重复启动单实例，个人数据分离 | .dsh-gpt-companion/{app,state}，DSHDragon.* helpers |
| 停用恢复 | 主窗口会话pause/桌面pause，守护有冷却和PID创建时间校验，退出释放worker/hooks/audio | 保留lifecycle/supervisor/事务恢复 |
| 更新 | 独立完整性清单、唯一程序根/路径/SHA256校验、事务锁/回滚/崩溃恢复、保留个人内容 | 严拒原GPT-Niang更新身份；未配置独立线上feed时只手动升级并明确提示 |

## 有意改变的原版行为

- 默认跟随/查询对象为DSH，仍可显式选择Codex模式。
- 默认安装不执行Codex marketplace/plugin注册，不查询或接管原版安装。仅显式`--codex-plugin`才注册本项目的独立Codex工具身份。
- 不自动迁移原版个人数据/旧PowerShell版本。双方并存是安全要求，不是缺少原版升级入口。
- 尚无独立公共发行仓库，不会假装存在在线更新，也不会回装原版。升级可运行新版的完整校验安装包；在线更新机制允许构建维护者显式设置独立可信feed。
- DSH已认证页面不活跃/桥接断开时，额度会过期并显示未知。不会以偷读cookie或OAuth维持后台刷新。
- 默认本机白名单快照不保存原会话标题、正文、路径或账号id；界面用固定脱敏会话标签。可选原Codex源沿用本地只读索引标题。

## 必须区分的证据级别

自动测试可验证协议/schema/去重/计价/导入/窗口mock/事务恢复；只有实际安装后才能验证当前账号实时额度、DSH最小化/返回、多屏混合DPI、真实音乐设备、注销重登自启、长时间负载。本项目不以静态编译通过替代这些实机验收。

## 素材范围

代码/文档MIT不等于角色图片授权。保留 [角色声明](../desktop/assets/CHARACTER-NOTICE.txt)、[生成来源](../desktop/assets/生成说明.md)、[语录许可](../desktop/assets/quotes-LICENSE.txt) 和 [MIT代码许可](../desktop/LICENSE)。含原龙娘图片的包仅作为本项目非商业个人副本，不作为独立素材包或商用产品分发。
