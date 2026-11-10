# 发布到 GitHub 的操作步骤

仓库已经整理成可直接公开的状态：单一干净历史、已清除本机路径与用户名、许可与出处齐备。**适配者无法由脚本代推**——请在你自己的机器上、用你自己的 GitHub 凭据完成推送。

仓库根目录即本文件所在仓库。

## 一、创建远端仓库

在 GitHub 上新建一个**空**仓库（不要勾选 README / .gitignore / LICENSE，否则首次推送会冲突）。建议：

- 仓库名：`gpt-niang-dsh`（或你喜欢的名字）
- 可见性：Public
- 描述：`GPT-Niang 龙娘挂件的 DeepSeek Harness 适配版（非官方）。上游：T7moris/GPT-Niang`

## 二、推送

```powershell
cd <本仓库根目录>
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

首次推送会弹出 GitHub 登录窗口（本机 credential helper 是 `manager`）。也可以用 SSH：把上面的 URL 换成 `git@github.com:<用户名>/<仓库名>.git`。

## 三、推送后建议设置

**仓库 About 栏**点击齿轮，填写：

- Description：`GPT-Niang 龙娘挂件的 DSH 适配版（非官方）。上游：T7moris/GPT-Niang`
- Topics：`dsh` `deepseek-harness` `desktop-widget` `electron` `windows`

**Releases**：建议发一个 `v0.1.0-beta.2`，附件上传分发包 ZIP 与 `SHA256SUMS.txt`。分发包在：

```text
dist/gift-package/GPT龙娘-桌宠-0.1.0-beta.2.zip
dist/gift-package/GPT龙娘-桌宠-0.1.0-beta.2.zip.sha256.txt
```

（`dist/` 已被 `.gitignore` 忽略，所以要用 Release 附件发布，不能直接提交进仓库。）

## 四、发布前请自行确认

- [ ] `README.md` 顶部的"这是适配版"声明与上游链接符合你的意思
- [ ] `docs/ATTRIBUTION.md` 里的分工描述（你只做了 DSH 适配）符合事实
- [ ] 角色素材声明你已读过：**图片不得商用、不得单独作为素材包分发**
- [ ] 仓库里没有你不想公开的验证记录（`audit/`、`dist/`、`vendor/` 已排除）
- [ ] 如希望署名你自己的适配工作，可在 README 末尾加一行"DSH 适配维护：<你的名字/ID>"

## 五、如果以后要改历史

当前只有 6 个提交，且都不含个人信息。若之后误提交了隐私内容，注意**普通 `git commit` 无法清除历史**，需要用 `git filter-repo` 重写后再强推，并轮换任何已泄露的凭据。
