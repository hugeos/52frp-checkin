// Cloudflare Worker 入口：随机时间签到 + 手动触发
// 支持多站点：52frp.com + 88frp.com
//
// - scheduled: Cron 每 15 分钟触发，每天在随机时间点执行一次签到
// - fetch:     GET /run 手动触发（可选用 ACCESS_KEY 保护），不受随机限制
//
// 随机时间原理：
//   Cloudflare Worker 有墙钟时间限制（约 10s），无法长时间 sleep。
//   改用"多频触发 + 随机命中"：Cron 每 15 分钟触发一次，
//   基于当天日期算出一个稳定的伪随机"幸运时间槽"，
//   只有命中的那次才真正签到，其余跳过。
//   每天签到时间在北京时间 8:00-22:45 之间随机，且每天不同。
//
// 多站点配置：
//   52frp: FRP_USERNAME / FRP_PASSWORD
//   88frp: FRP88_USERNAME / FRP88_PASSWORD
//   未配置某站点的账号密码时自动跳过该站点

import { runCheckIn, sendPushPlus } from './lib.js';
import { runCheckIn88 } from './frp88.js';

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

// 单站点签到封装
async function checkinSite(name, checkinFn, env) {
  const start = Date.now();
  let result;
  try {
    result = await checkinFn(env);
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
  return {
    site: name,
    ...result,
    elapsed: elapsed + 's',
    line: `【${name}】${emoji}${label}\n${result.message}\n耗时 ${elapsed}s`,
  };
}

async function handleCheckin(env) {
  const tasks = [];

  // 52frp（配置了 FRP_USERNAME 才执行）
  if (env.FRP_USERNAME) {
    tasks.push(checkinSite('52frp', runCheckIn, env));
  }

  // 88frp（配置了 FRP88_USERNAME 才执行）
  if (env.FRP88_USERNAME) {
    tasks.push(checkinSite('88frp', runCheckIn88, env));
  }

  if (tasks.length === 0) {
    return {
      status: 'error',
      message: '未配置任何签到账号。需要设置 FRP_USERNAME/FRP_PASSWORD（52frp）或 FRP88_USERNAME/FRP88_PASSWORD（88frp）',
      results: [],
    };
  }

  // 并行签到所有站点
  const results = await Promise.all(tasks);

  // 汇总推送
  const summary = results.map((r) => r.line).join('\n\n');
  const hasError = results.some((r) => r.status === 'error');
  const title = hasError ? '签到提醒（有失败）' : '签到完成';
  console.log(summary);

  let pushResult = '';
  try {
    pushResult = await sendPushPlus(env, title, summary);
  } catch (e) {
    pushResult = '推送失败: ' + e.message;
  }

  return {
    status: hasError ? 'partial' : 'success',
    results: results.map((r) => ({
      site: r.site,
      status: r.status,
      message: r.message,
      elapsed: r.elapsed,
    })),
    push: pushResult,
  };
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
      'FRP 自动签到 Worker\n' +
      '支持站点: 52frp.com / 88frp.com\n\n' +
      'GET /run   手动触发签到（签到所有已配置站点）\n' +
      'GET /lucky 查看今日随机幸运时间\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },
};
