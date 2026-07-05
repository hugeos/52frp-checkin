# FRP 自动签到（Cloudflare Worker 版）

每天定时自动签到 **52frp.com** 和 **88frp.com**，签到结果通过 PushPlus 推送到微信。
全程跑在 Cloudflare Worker 上，**电脑关机也能签到，完全免费**。

## 支持站点

| 站点 | 域名 | 登录方式 | 签到方式 | 环境变量前缀 |
|------|------|----------|----------|-------------|
| 52frp | www.52frp.com | 账号密码 + slider_token | API | `FRP_` |
| 88frp | api.88frp.com | 账号密码（无验证码） | API | `FRP88_` |

两个站点独立配置，配了哪个就签哪个，不配自动跳过。

## 工作原理

不走浏览器，直接调用各站点的 API 完成签到：

**52frp：**
```
POST /api/user/login        账号密码登录 → 拿到 Bearer token
GET  /api/user/sign/info    查询今日是否已签到
GET  /api/user/slider-token 取一次性 slider_token
POST /api/user/sign         提交签到
```

**88frp：**
```
POST /api/auth/login                      账号密码登录 → 拿到 JWT token
GET  /api/users/mine                      获取流量和签到状态
POST /api/domain/value-added-rights/signIn  提交签到
```

由 Cloudflare 的 **Cron Trigger** 每天在随机时间触发 Worker，签到后调用 PushPlus 推送结果到微信。

## 前置条件

- 52frp 和/或 88frp 账号
- 一个 Cloudflare 账号（免费即可，Worker 免费额度每天 10 万次请求足够）
- （可选）一个 [PushPlus](http://www.pushplus.plus/) Token，用于微信推送

## 第一步：本地测试（强烈建议先做）

部署前先用真实账号验证 API 签到是否走得通。

需要 Node.js 18+（自带 fetch）。在本项目目录执行：

**测试 52frp：**
```bash
FRP_USERNAME=你的账号 FRP_PASSWORD=你的密码 node test-local.js
```

**测试 88frp：**
```bash
FRP88_USERNAME=你的账号 FRP88_PASSWORD=你的密码 node test-local.js
```

**同时测试两个：**
```bash
FRP_USERNAME=a FRP_PASSWORD=b FRP88_USERNAME=c FRP88_PASSWORD=d node test-local.js
```

看到 `status: success` 或 `already_signed` 就说明 API 方案可行。

> 想顺便测试微信推送，加上 `PUSHPLUS_TOKEN=你的token`。

## 第二步：部署到 Cloudflare

### 网页端连接 GitHub 仓库（Workers Builds，推荐）

不用装任何命令行工具，全程在 Cloudflare 网页上完成。前置条件：代码已在你自己的 GitHub 仓库里。

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 左侧 **Workers & Pages** → 点 **Create**
2. 选 **Connect to Git**（连接到 Git），首次会要求授权 Cloudflare 访问 GitHub，授权后选择你的仓库
3. 按提示填写：
   - **项目名**：`52frp-checkin`
   - **生产分支**：`main`
   - **构建命令**：`npm install`
   - **部署命令**：`npx wrangler deploy`
4. 点 **Save and Deploy**，Cloudflare 会自动拉取代码、安装依赖、部署 Worker（首次约 1–2 分钟）
5. 部署完成后，进入该 Worker 的 **Settings → Variables and Secrets**，逐个添加：

   | 名称 | 值 | 类型 | 必填 |
   |------|-----|------|------|
   | `FRP_USERNAME` | 你的 52frp 账号 | Secret | 签 52frp 必填 |
   | `FRP_PASSWORD` | 你的 52frp 密码 | Secret | 签 52frp 必填 |
   | `FRP88_USERNAME` | 你的 88frp 账号 | Secret | 签 88frp 必填 |
   | `FRP88_PASSWORD` | 你的 88frp 密码 | Secret | 签 88frp 必填 |
   | `PUSHPLUS_TOKEN` | PushPlus token | Secret | 可选，所有站点共用 |
   | `ACCESS_KEY` | 自定义密钥 | Secret | 可选，保护 /run 接口 |

6. Cron 定时触发器已在 `wrangler.toml` 里配好（每 15 分钟触发，代码内部随机命中），部署后自动生效
7. 验证：浏览器访问 `https://<你的Worker>.workers.dev/run`，返回 JSON 里各站点 `status` 为 `success` 或 `already_signed` 即成功
8. 查看今日随机幸运时间：访问 `https://<你的Worker>.workers.dev/lucky`

> 以后每次 push 到 `main` 分支，Cloudflare 都会自动重新部署。

### 命令行（wrangler）

```bash
npm install
npx wrangler login
npm run deploy
```

## 随机时间机制

固定时间签到容易被识别为自动化行为。本方案采用**多频触发 + 随机命中**：

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
│   ├── lib.js        52frp 签到逻辑（API 客户端 + PushPlus 推送）
│   ├── frp88.js      88frp 签到逻辑
│   └── index.js      Worker 入口（定时触发 + HTTP 手动触发 + 多站点调度）
├── test-local.js     本地测试脚本（支持 52frp + 88frp）
├── wrangler.toml     Cloudflare Worker 配置（含 cron）
├── package.json
├── .dev.vars.example 本地开发密钥模板
└── .gitignore
```

## 常见问题

**Q：52frp 登录报错"未拿到 token / 触发滑块验证"**
52frp 偶尔会在登录环节要求滑块验证。纯 API 无法拖滑块。这种情况建议当天手动签到一次，通常次日 API 登录恢复正常。88frp 不存在此问题（无验证码）。

**Q：88frp 签到返回"今日已签到"**
正常现象，表示今天已经签过了。代码会将其识别为 `already_signed` 状态。

**Q：Cron 没触发？**
- 确认 Worker 已部署且 Cron Trigger 已生效（网页端 Settings → Triggers 可见）
- Cron 用 UTC 时间，注意时区换算
- 免费版 Cron 最小间隔 1 分钟，每天 1 次完全没问题

**Q：PushPlus 收不到推送？**
- 确认 token 正确、未过期
- PushPlus 免费版有每日推送上限
- Worker 日志里会打印推送接口返回值，可据此排查

**Q：只想签一个站点？**
只配置对应站点的账号密码即可，另一个不配会自动跳过。
