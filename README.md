# 52frp 自动签到（Cloudflare Worker 版）

每天定时自动签到 [52frp.com](https://www.52frp.com)，签到结果通过 PushPlus 推送到微信。
全程跑在 Cloudflare Worker 上，**电脑关机也能签到，完全免费**。

## 工作原理

不走浏览器，直接调用 52frp 面板的 API 完成签到：

```
GET  /user/                 建立 session
POST /api/user/login        账号密码登录 → 拿到 Bearer token
GET  /api/user/sign/info    查询今日是否已签到
GET  /api/user/slider-token 取一次性 slider_token
POST /api/user/sign         提交签到
```

由 Cloudflare 的 **Cron Trigger** 每天定时触发 Worker，签到后调用 PushPlus 推送结果到微信。

## 前置条件

- 一个 52frp 账号（手机号 / 邮箱 + 密码）
- 一个 Cloudflare 账号（免费即可，Worker 免费额度每天 10 万次请求足够）
- （可选）一个 [PushPlus](http://www.pushplus.plus/) Token，用于微信推送

## 第一步：本地测试（强烈建议先做）

部署前先用你的真实账号验证 API 签到是否走得通。

需要 Node.js 18+（自带 fetch）。在本项目目录执行：

**bash / Git Bash：**
```bash
FRP_USERNAME=你的账号 FRP_PASSWORD=你的密码 node test-local.js
```

**PowerShell：**
```powershell
$env:FRP_USERNAME='你的账号'; $env:FRP_PASSWORD='你的密码'; node test-local.js
```

看到 `status: success` 或 `already_signed` 就说明 API 方案可行，可以继续部署。
若看到 `error`，把报错信息发我，我们再调整或换方案。

> 想顺便测试微信推送，加上 `PUSHPLUS_TOKEN=你的token`。

## 第二步：部署到 Cloudflare

### 方式 A：命令行（wrangler，推荐）

1. 安装依赖：
   ```bash
   npm install
   ```

2. 登录 Cloudflare：
   ```bash
   npx wrangler login
   ```
   会打开浏览器授权。

3. 部署：
   ```bash
   npm run deploy
   ```
   部署成功后会输出一个 `https://52frp-checkin.<你的子域>.workers.dev` 地址。

### 方式 B：网页端连接 GitHub 仓库（Workers Builds，推荐）

不用装任何命令行工具，全程在 Cloudflare 网页上完成。前置条件：代码已在你自己的 GitHub 仓库里。

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 左侧 **Workers & Pages** → 点 **Create**
2. 选 **Connect to Git**（连接到 Git），首次会要求授权 Cloudflare 访问 GitHub，授权后选择你的 `52frp-checkin` 仓库
3. 按提示填写：
   - **项目名**：`52frp-checkin`
   - **生产分支**：`main`
   - **构建命令**：`npm install`
   - **部署命令**：`npx wrangler deploy`
4. 点 **Save and Deploy**，Cloudflare 会自动拉取代码、安装依赖、部署 Worker（首次约 1–2 分钟）
5. 部署完成后，进入该 Worker 的 **Settings → Variables and Secrets**，逐个添加：
   | 名称 | 值 | 类型 |
   |------|-----|------|
   | `FRP_USERNAME` | 你的 52frp 账号 | Secret |
   | `FRP_PASSWORD` | 你的 52frp 密码 | Secret |
   | `PUSHPLUS_TOKEN` | PushPlus token（可选） | Secret |
   | `ACCESS_KEY` | 自定义密钥，保护 /run 接口（可选） | Secret |
6. Cron 定时触发器已在 `wrangler.toml` 里配好（每 15 分钟触发，代码内部随机命中），部署后自动生效，无需手动添加
7. 验证：浏览器访问 `https://52frp-checkin.<你的子域>.workers.dev/run`（若设了 ACCESS_KEY，则访问 `/run?key=你的密钥`），返回 JSON 里 `status` 为 `success` 或 `already_signed` 即成功，微信也会收到推送
8. 查看今日随机幸运时间：访问 `https://52frp-checkin.<你的子域>.workers.dev/lucky`

> 以后每次 push 到 `main` 分支，Cloudflare 都会自动重新部署，改完代码推上去即可，无需手动操作。

## 第三步：配置 Secrets

账号密码等敏感信息必须用 Secret 配置，**不要写进代码或 wrangler.toml**。

```bash
npx wrangler secret put FRP_USERNAME      # 输入你的 52frp 账号
npx wrangler secret put FRP_PASSWORD      # 输入你的 52frp 密码
npx wrangler secret put PUSHPLUS_TOKEN    # 输入 PushPlus token（可选）
npx wrangler secret put ACCESS_KEY        # 自定义一个密钥，保护 /run 接口（可选）
```

或在网页端 Worker 的 Settings → Variables and Secrets 里添加。

## 第四步：验证

部署并配好 Secret 后，浏览器访问：

```
https://52frp-checkin.<你的子域>.workers.dev/run
```

（若设了 ACCESS_KEY，则访问 `/run?key=你的密钥`）

返回 JSON 里 `status` 为 `success` 或 `already_signed` 即成功，微信也会收到推送。

之后**每天在北京时间 8:00-22:45 之间的一个随机时间点自动签到一次**，每天的时间不同。

### 随机时间机制

为什么不固定时间？固定时间签到容易被识别为自动化行为。本方案采用**多频触发 + 随机命中**：

- Cron 每 15 分钟触发一次 Worker（每天 96 次）
- 代码内部根据当天日期算出一个稳定的伪随机"幸运时间槽"
- 只有命中的那次才真正执行签到，其余直接跳过（几乎不消耗额度）
- 每天签到时间在北京时间 8:00-22:45 之间随机，且每天不同
- 手动访问 `/run` 不受随机限制，随时可触发
- 访问 `/lucky` 可查看今天的幸运时间

> 免费版 Worker 每天 10 万次请求额度，96 次触发完全无压力。

## 文件说明

```
.
├── src/
│   ├── lib.js        核心签到逻辑（API 客户端 + PushPlus），Worker 和本地测试共用
│   └── index.js      Worker 入口（定时触发 + HTTP 手动触发）
├── test-local.js     本地测试脚本
├── wrangler.toml     Cloudflare Worker 配置（含 cron）
├── package.json
├── .dev.vars.example 本地开发密钥模板
└── .gitignore
```

## 常见问题

**Q：登录报错“未拿到 token / 触发滑块验证”**
52frp 偶尔会在登录环节要求滑块验证。纯 API 无法拖滑块。这种情况建议当天手动签到一次，通常次日 API 登录恢复正常。若频繁出现，需改用浏览器自动化方案（见下）。

**Q：签到报错“接口仍显示未签到”**
说明 52frp 服务端可能要求真实的滑块拖拽轨迹，纯 API 提交被拒绝。这种情况下 Worker 方案不可行，需要改用浏览器自动化（Playwright + GitHub Actions）方案。

**Q：Cron 没触发？**
- 确认 Worker 已部署且 Cron Trigger 已生效（网页端 Settings → Triggers 可见）
- Cron 用 UTC 时间，注意时区换算
- 免费版 Cron 最小间隔 1 分钟，每天 1 次完全没问题

**Q：PushPlus 收不到推送？**
- 确认 token 正确、未过期
- PushPlus 免费版有每日推送上限
- Worker 日志里会打印推送接口返回值，可据此排查

## 备选方案

如果纯 API 方案因滑块验证不可行，可改用浏览器自动化方案：
Fork [doubletree6/52frp-checkin](https://github.com/doubletree6/52frp-checkin)，配置 `FRP_USERNAME`、`FRP_PASSWORD`、`PUSHPLUS_TOKEN` 三个 Secret，启用 GitHub Actions 即可，每天自动用 Playwright 模拟真人拖滑块签到。缺点是依赖 GitHub Actions、代码量更大。
