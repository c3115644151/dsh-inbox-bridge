# 参与开发

这是一个小型插件，改动通常只落在 `index.js`（Host 侧：轮询时机、投递、配置与路由）、`client.js`（状态行胶囊与面板）、`scripts/github-inbox.mjs`（查询 GitHub 并判定相关性）与 `scripts/inbox-bridge.mjs`（队列与 CLI）里。

## 提交之前

```powershell
npm test           # node --test，三个测试文件
npm run market:check
```

`npm test` 必须在 Windows、macOS、Linux 上都通过——CI 三平台都跑。新行为请带一个能复现旧错误的测试；只改样式或文案时不需要。

## 结构约定

- **事实只有一处。** 队列状态在 `.work/inbox-bridge/state.json`，GitHub 侧缓存状态在 `.work/github-inbox/state.json`，面板改动在 `.work/inbox-bridge/prefs.json`。不要在插件内存里另建一份真相。
- **Host 决定事实，客户端只显示。** `client.js` 不查询 GitHub，也不读会话日志；它只读 `GET /inbox-bridge/status.json`。
- **注入到上下文，不开启对话。** 除 `delivery: wakeup` 且命中 `wakeOn` 外，任何代码路径都不应让插件主动发起一轮。
- **只读 GitHub。** 新增的 GitHub 调用只允许读接口；唯一例外是 `clear`（标已读）与 `sweep`（归档），它们改变的是你自己账号的通知状态。
- **失败要说出来。** 轮询失败、清理需要登录、面板请求失败，都要在日志或面板上留一行可读的原因，不要静默。

## 发布

版本号与市场索引绑定：`docs/index.json` 里记录被安装的确切提交。

```powershell
npm test
# 改 package.json 的 version 与 CHANGELOG.md
git add -A && git commit -m "fix: … (2.x.y)"
npm run market
git add -A && git commit -m "chore: release 2.x.y in the market index"
git push origin main
```

`npm run market` 把 `docs/index.json` 的 pin 指向当前提交；必须在推送之后重新生成，或推送后追加一个只改索引的提交，否则市场里安装到的仍是旧提交。

## 报告问题

带上这三样：DSH 版本、`node -v`、以及工作目录下 `.work/inbox-bridge/` 里相关的几行日志。日志里不含凭据。
