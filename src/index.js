// Cloudflare Worker 入口：定时签到 + 手动触发
// - scheduled: 由 Cron Trigger 每天定时触发
// - fetch:     GET /run 手动触发（可选用 ACCESS_KEY 保护）

import { runCheckIn, sendPushPlus } from './lib.js';

async function handleCheckin(env) {
  const start = Date.now();
  let result;
  try {
    result = await runCheckIn(env);
  } catch (err) {
    result = { status: 'error', message: err.message };
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const emoji =
    result.status === 'success' ? '✅' : result.status === 'already_signed' ? '☑️' : '❌';
  const label =
    result.status === 'success'
      ? '签到成功'
      : result.status === 'already_signed'
        ? '今日已签'
        : '签到失败';
  const fullMessage = `【52frp签到】${emoji}${label}\n${result.message}\n耗时 ${elapsed}s`;
  console.log(fullMessage);

  let pushResult = '';
  try {
    pushResult = await sendPushPlus(env, '52frp签到', fullMessage);
  } catch (e) {
    pushResult = `推送失败: ${e.message}`;
  }

  return { ...result, elapsed: `${elapsed}s`, push: pushResult };
}

export default {
  // 定时触发
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleCheckin(env));
  },
  // HTTP 手动触发
  async fetch(request, env) {
    const url = new URL(request.url);

    // 可选鉴权：配置了 ACCESS_KEY 时，/run 需要 ?key=xxx
    if (env.ACCESS_KEY) {
      const key = url.searchParams.get('key');
      if (key !== env.ACCESS_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    if (url.pathname === '/run' || url.pathname === '/') {
      const result = await handleCheckin(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response('52frp 自动签到 Worker\nGET /run 触发签到', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
