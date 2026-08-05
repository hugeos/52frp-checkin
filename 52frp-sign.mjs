// ============================================================
// 52frp 本地 Chrome 自动签到（方案 3）
// 52frp 校验 TLS 指纹，纯 API 无法通过，必须用真实 Chrome
// 用法: node 52frp-sign.mjs
// 可选: 设置环境变量 PUSHPLUS_TOKEN 后签到结果会推送微信
// ============================================================
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'https://www.52frp.com/user/';

// ---- 凭据：优先环境变量，其次 .env 文件 ----
function loadEnv() {
  const env = {};
  const envPath = join(import.meta.dirname, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const USERNAME = process.env.FRP_USERNAME || env.FRP_USERNAME;
const PASSWORD = process.env.FRP_PASSWORD || env.FRP_PASSWORD;
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || env.PUSHPLUS_TOKEN;

async function push(title, content) {
  if (!PUSHPLUS_TOKEN) return '未配置 PUSHPLUS_TOKEN，跳过推送';
  const r = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: PUSHPLUS_TOKEN, title, content }),
  });
  return await r.text();
}

// 拖拽滑块（真实轨迹模拟）
async function dragSlider(page) {
  const holder = page.locator('text=按住滑块').first();
  await holder.waitFor({ timeout: 8000 });
  const box = await holder.evaluateHandle((el) => {
    let p = el;
    for (let i = 0; i < 8; i++) {
      if (!p.parentElement) break;
      p = p.parentElement;
      const r = p.getBoundingClientRect();
      if (r.width > 200 && r.height < 80) return p;
    }
    return p;
  });
  const b = await box.asElement().boundingBox();
  if (!b) throw new Error('滑块定位失败');
  const sx = b.x + b.width * 0.05;
  const sy = b.y + b.height / 2;
  const tx = b.x + b.width * 0.95;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(sx + ((tx - sx) * i) / 40, sy + (Math.random() - 0.5) * 3);
    await page.waitForTimeout(40 + Math.random() * 80);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.log('缺少 FRP_USERNAME / FRP_PASSWORD（可用环境变量或同目录 .env）');
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: false });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  let result = '';
  try {
    // 1. 打开登录页
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);

    // 2. 填账号密码
    const inputs = page.locator('input');
    await inputs.nth(0).fill(USERNAME);
    await inputs.nth(1).fill(PASSWORD);
    await page.waitForTimeout(500);

    // 3. 拖滑块（52frp 登录必须过滑块）
    await dragSlider(page);

    // 4. 点登录
    await page.locator('button:has-text("登录")').first().click();
    await page.waitForTimeout(6000);
    if (page.url().includes('auth/login')) {
      result = '❌ 登录失败（可能滑块没过）';
      console.log(result);
      await push('52frp 签到失败', result);
      return;
    }
    console.log('✅ 登录成功');

    // 5. 关公告弹窗（会拦截签到按钮点击）
    await page.waitForTimeout(2000);
    const dialogClose = page.locator('.announcement-fullscreen-overlay button, button:has-text("知道了"), .el-dialog__close').first();
    if (await dialogClose.count() && await dialogClose.isVisible()) {
      await dialogClose.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      console.log('已关闭公告弹窗');
    }

    // 6. 点签到
    const signBtn = page.locator('button:has-text("签到")').first();
    if (!(await signBtn.count())) {
      result = '❌ 未找到签到按钮（可能今日已签或页面异常）';
      console.log(result);
      await push('52frp 签到', result);
      return;
    }
    await signBtn.click({ force: true });
    await page.waitForTimeout(5000);

    // 7. 验证结果（监听签到按钮文字变化 / API 响应）
    await page.waitForTimeout(2000);
    // 再截个图确认
    const signText = (await signBtn.textContent().catch(() => '')) || '';
    result = signText.includes('已签') ? '✅ 52frp 今日已签到（按钮显示已签）' : '✅ 已点击签到（建议人工确认）';
    console.log(result);

    // 复查服务端状态
    try {
      const after = await page.evaluate(async ({ u, p }) => {
        const r = await fetch('https://www.52frp.com/api/user/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p }),
        });
        const lj = await r.json();
        const t = lj?.data?.token || lj?.token || '';
        if (!t) return { signed: null, err: 'no token' };
        const r2 = await fetch('https://www.52frp.com/api/user/sign/info', {
          headers: { Authorization: `Bearer ${t}` },
        });
        const si = await r2.json();
        return { signed: si?.data?.signed_today, total: si?.data?.total_sign_days };
      }, { u: USERNAME, p: PASSWORD });
      console.log('服务端确认: signed_today =', after.signed, '| 累计', after.total, '天');
      if (after.signed === true) result = `✅ 52frp 签到成功！累计 ${after.total} 天`;
      else result = '❌ 服务端确认未签上（需要人工处理）';
    } catch (e) {
      console.log('复查失败:', e.message);
    }
  } catch (e) {
    result = `❌ 异常: ${e.message}`;
    console.log(result);
  } finally {
    await push('52frp 签到结果', result);
    await browser.close();
  }
}

main();
