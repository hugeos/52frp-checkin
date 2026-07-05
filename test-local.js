// 本地测试脚本：验证 52frp 和 88frp 的 API 签到流程
// 部署到 Cloudflare 前先跑这个，确认能签到成功再上线。
//
// 用法（bash）:
//   测试 52frp: FRP_USERNAME=账号 FRP_PASSWORD=密码 node test-local.js
//   测试 88frp: FRP88_USERNAME=账号 FRP88_PASSWORD=密码 node test-local.js
//   同时测试:   FRP_USERNAME=a FRP_PASSWORD=b FRP88_USERNAME=c FRP88_PASSWORD=d node test-local.js
// 可选 PUSHPLUS_TOKEN=xxx 顺带测试微信推送
// 用法（PowerShell）:
//   $env:FRP_USERNAME='账号'; $env:FRP_PASSWORD='密码'; node test-local.js

import { runCheckIn, sendPushPlus } from './src/lib.js';
import { runCheckIn88 } from './src/frp88.js';

const env = {
  FRP_USERNAME: process.env.FRP_USERNAME,
  FRP_PASSWORD: process.env.FRP_PASSWORD,
  FRP88_USERNAME: process.env.FRP88_USERNAME,
  FRP88_PASSWORD: process.env.FRP88_PASSWORD,
  PUSHPLUS_TOKEN: process.env.PUSHPLUS_TOKEN,
};

if (!env.FRP_USERNAME && !env.FRP88_USERNAME) {
  console.error('✗ 请至少设置一组账号密码');
  console.error('  52frp: FRP_USERNAME=账号 FRP_PASSWORD=密码 node test-local.js');
  console.error('  88frp: FRP88_USERNAME=账号 FRP88_PASSWORD=密码 node test-local.js');
  process.exit(1);
}

const sites = [];
if (env.FRP_USERNAME) sites.push({ name: '52frp', fn: runCheckIn });
if (env.FRP88_USERNAME) sites.push({ name: '88frp', fn: runCheckIn88 });

console.log('开始测试签到流程...\n');
console.log('测试站点: ' + sites.map(s => s.name).join(', ') + '\n');

const results = [];
for (const site of sites) {
  const start = Date.now();
  let result;
  try {
    result = await site.fn(env);
  } catch (err) {
    result = { status: 'error', message: err.message };
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const emoji =
    result.status === 'success' ? '✅' : result.status === 'already_signed' ? '☑️' : '❌';
  console.log(`====== ${site.name} 签到结果 ${emoji} ======`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`耗时: ${elapsed}s\n`);

  results.push({ name: site.name, ...result, elapsed });
}

// 推送测试
if (env.PUSHPLUS_TOKEN) {
  const summary = results.map(r => {
    const emoji = r.status === 'success' ? '✅' : r.status === 'already_signed' ? '☑️' : '❌';
    return `【${r.name}】${emoji}\n${r.message}\n耗时 ${r.elapsed}s`;
  }).join('\n\n');
  try {
    console.log('PushPlus 推送结果:', await sendPushPlus(env, '签到测试', summary));
  } catch (e) {
    console.log('推送失败:', e.message);
  }
} else {
  console.log('（未设置 PUSHPLUS_TOKEN，跳过推送测试）');
}

const hasError = results.some(r => r.status === 'error');
process.exit(hasError ? 1 : 0);
