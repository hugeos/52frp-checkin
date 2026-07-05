// Cloudflare Worker 入口：随机时间签到 + 手动触发
// - scheduled: Cron 每 15 分钟触发，每天在随机时间点执行一次签到
// - fetch:     GET /run 手动触发（可选用 ACCESS_KEY 保护），不受随机限制
//
// 随机时间原理：
//   Cloudflare Worker 有墙钟时间限制（约 10s），无法长时间 sleep。
//   改用"多频触发 + 随机命中"：Cron 每 15 分钟触发一次，
//   基于当天日期算出一个稳定的伪随机"幸运时间槽"，
//   只有命中的那次才真正签到，其余跳过。
//   每天签到时间在北京时间 8:00-22:45 之间随机，且每天不同。

import { runCheckIn, sendPushPlus } from './lib.js';

// ---------- 随机时间槽 ----------

// FNV-1a 哈希：同一日期字符串 → 同一数值（稳定），不同日期 → 不同数值
function dailyHash(dateStr) {
  let hash = 2166136261;
  for (const c of dateStr) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// 签到时间窗口：北京时间 8:00-22:45 = UTC 0:00-14:45
// 每 15 分钟一个槽位，共 60 个槽位
const WINDOW_SLOTS = 60;

function getTodayLuckySlot(date) {
  const dateStr = date.toISOString().slice(0, 10); // UTC YYYY-MM-DD
  return dailyHash(dateStr) % WINDOW_SLOTS;
}

function getCurrentSlot(date) {
  return date.getUTCHours() * 4 + Math.floor(date.getUTCMinutes() / 15);
}

// 槽位序号 → 北京时间字符串
function slotToBeijingTime(slot) {
  const totalMinutes = slot * 15 + 8 * 60; // +8 小时转为北京时间
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------- 签到执行 ----------

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

// ---------- Worker 入口 ----------

export default {
  // 定时触发：每 15 分钟一次，只在当天随机幸运时间点执行
  async scheduled(controller, env, ctx) {
    const now = new Date();
    const luckySlot = getTodayLuckySlot(now);
    const currentSlot = getCurrentSlot(now);

    if (currentSlot !== luckySlot) {
      console.log(
        `[skip] 今日幸运时间 ${slotToBeijingTime(luckySlot)}（北京），` +
        `当前 ${slotToBeijingTime(currentSlot)}，跳过`
      );
      return;
    }

    console.log(`[hit] 命中今日幸运时间 ${slotToBeijingTime(luckySlot)}（北京），开始签到`);
    ctx.waitUntil(handleCheckin(env));
  },

  // HTTP 手动触发：不受随机时间限制，随时可触发
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
      const now = new Date();
      const luckySlot = getTodayLuckySlot(now);
      const result = await handleCheckin(env);
      // 附带今日幸运时间信息，方便排查
      result.luckyTime = slotToBeijingTime(luckySlot);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // 查看今日幸运时间（不执行签到）
    if (url.pathname === '/lucky') {
      const now = new Date();
      const luckySlot = getTodayLuckySlot(now);
      return new Response(
        JSON.stringify({
          date: now.toISOString().slice(0, 10),
          luckyTimeBeijing: slotToBeijingTime(luckySlot),
          currentTimeBeijing: slotToBeijingTime(getCurrentSlot(now)),
        }, null, 2),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    return new Response(
      '52frp 自动签到 Worker\n' +
      'GET /run   手动触发签到\n' +
      'GET /lucky 查看今日随机幸运时间\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },
};
