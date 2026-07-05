// 本地测试脚本：用你的 52frp 账号验证 API 签到流程是否可行
// 部署到 Cloudflare 前先跑这个，确认能签到成功再上线。
//
// 用法（bash）:
//   FRP_USERNAME=你的账号 FRP_PASSWORD=你的密码 node test-local.js
// 可选 PUSHPLUS_TOKEN=xxx 顺带测试微信推送
// 用法（PowerShell）:
//   $env:FRP_USERNAME='你的账号'; $env:FRP_PASSWORD='你的密码'; node test-local.js

import { runCheckIn, sendPushPlus } from './src/lib.js';

const env = {
  FRP_USERNAME: process.env.FRP_USERNAME,
  FRP_PASSWORD: process.env.FRP_PASSWORD,
  PUSHPLUS_TOKEN: process.env.PUSHPLUS_TOKEN,
};

if (!env.FRP_USERNAME || !env.FRP_PASSWORD) {
  console.error('✗ 请先设置环境变量 FRP_USERNAME 和 FRP_PASSWORD');
  console.error('  示例: FRP_USERNAME=账号 FRP_PASSWORD=密码 node test-local.js');
  process.exit(1);
}

console.log('开始测试 52frp API 签到流程...\n');
const start = Date.now();
let result;
try {
  result = await runCheckIn(env);
} catch (err) {
  result = { status: 'error', message: err.message };
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log('====== 52frp 签到测试结果 ======');
console.log(JSON.stringify(result, null, 2));
console.log(`\n耗时: ${elapsed}s`);

if (env.PUSHPLUS_TOKEN) {
  const emoji =
    result.status === 'success' ? '✅' : result.status === 'already_signed' ? '☑️' : '❌';
  const msg = `【52frp签到测试】${emoji}\n${result.message}\n耗时 ${elapsed}s`;
  try {
    console.log('\nPushPlus 推送结果:', await sendPushPlus(env, '52frp签到测试', msg));
  } catch (e) {
    console.log('推送失败:', e.message);
  }
} else {
  console.log('\n（未设置 PUSHPLUS_TOKEN，跳过推送测试）');
}

process.exit(result.status === 'error' ? 1 : 0);
