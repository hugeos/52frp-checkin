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

// ---------- 北京时间 & 随机时间槽 ----------
// 关键：Cloudflare Worker 运行时为 UTC。所有时间判断统一转换为北京时间（UTC+8），
// 避免"服务器时区不对导致半夜签到"的问题。

function getBeijingNow() {
  // 在 UTC 时刻基础上 +8 小时得到北京时间；toISOString() 取日期、getUTCHours() 取小时
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function beijingDateStr(d) {
  return d.toISOString().slice(0, 10); // 已是 +8 后的日期
}

// 签到窗口：北京时间 08:00 - 22:45
const WINDOW_START_MIN = 8 * 60;       // 480
const WINDOW_END_MIN = 22 * 60 + 45;   // 1365
const SLOT_MINUTES = 15;
const WINDOW_SLOTS = Math.floor((WINDOW_END_MIN - WINDOW_START_MIN) / SLOT_MINUTES) + 1; // 60

// FNV-1a 哈希：同一日期字符串 → 同一数值（稳定），不同日期 → 不同数值
function dailyHash(dateStr) {
  let hash = 2166136261;
  for (const c of dateStr) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// 今日幸运槽位（北京时间），范围 0..WINDOW_SLOTS-1
function getTodayLuckySlot(beijingNow) {
  return dailyHash(beijingDateStr(beijingNow)) % WINDOW_SLOTS;
}

// 当前处于窗口内的第几个槽位；不在窗口内（深夜/凌晨）返回 -1
function getCurrentSlot(beijingNow) {
  const mins = beijingNow.getUTCHours() * 60 + beijingNow.getUTCMinutes();
  if (mins < WINDOW_START_MIN || mins > WINDOW_END_MIN) return -1;
  return Math.floor((mins - WINDOW_START_MIN) / SLOT_MINUTES);
}

// 槽位序号 → 北京时间字符串
function slotToBeijingTime(slot) {
  const total = WINDOW_START_MIN + slot * SLOT_MINUTES;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 每天每站最多重试次数（仅失败时计数）；超过则当日放弃，绝不打满"签到次数上限"
const MAX_ATTEMPTS_PER_DAY = 3;

// ---------- 签到执行 ----------

// 单站点签到封装（带 KV 去重 + 失败重试上限）
async function checkinSite(name, checkinFn, env, beijingDate) {
  const kv = env.SIGN_STATE;
  const signedKey = `signed:${name}:${beijingDate}`;
  const attemptKey = `attempts:${name}:${beijingDate}`;

  // 1) 已签到 / 已被服务端锁定（KV 记录）→ 直接跳过，绝不再调接口
  if (kv) {
    const done = await kv.get(signedKey);
    if (done === 'blocked') {
      return {
        site: name,
        status: 'error',
        message: '今日账号已被服务端锁定（签到次数超限），明日自动再试',
        elapsed: '0s',
        line: `【${name}】🔒今日已被锁定（服务端超限）`,
        noPush: true,
      };
    }
    if (done) {
      return {
        site: name,
        status: 'already_signed',
        message: '今日已签到（本地记录）',
        elapsed: '0s',
        line: `【${name}】☑️今日已签（本地记录）`,
      };
    }
    // 2) 失败重试已达上限 → 当日放弃，避免打满"签到次数上限"
    const attempts = Number((await kv.get(attemptKey)) || '0');
    if (attempts >= MAX_ATTEMPTS_PER_DAY) {
      return {
        site: name,
        status: 'error',
        message: `今日已尝试 ${attempts} 次仍失败，已达重试上限，今日不再签到（防触发次数超限）`,
        elapsed: '0s',
        line: `【${name}】❌今日重试已达上限`,
        noPush: true,
      };
    }
    await kv.put(attemptKey, String(attempts + 1), { expirationTtl: 172800 });
  }

  // 3) 真正执行签到
  const start = Date.now();
  let result;
  try {
    result = await checkinFn(env);
  } catch (err) {
    result = { status: 'error', message: err.message };
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // 成功后写 KV，确保当天不再重复调用接口
  if (kv && result.status === 'success') {
    await kv.put(signedKey, '1', { expirationTtl: 172800 });
  }

  // 明确被服务端锁定（签到次数超限）→ 当天彻底放弃，不再重试、不推送
  const blocked =
    result.status === 'error' &&
    /已达上限|次数超限|明天再试|limit/i.test(result.message || '');
  if (kv && blocked) {
    await kv.put(signedKey, 'blocked', { expirationTtl: 172800 });
    result.noPush = true;
  }

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

async function handleCheckin(env, beijingDate) {
  const tasks = [];

  // 52frp（配置了 FRP_USERNAME 才执行）
  if (env.FRP_USERNAME) {
    tasks.push(checkinSite('52frp', runCheckIn, env, beijingDate));
  }

  // 88frp（配置了 FRP88_USERNAME 才执行）
  if (env.FRP88_USERNAME) {
    tasks.push(checkinSite('88frp', runCheckIn88, env, beijingDate));
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
  const hasSuccess = results.some((r) => r.status === 'success');
  // 仅「有新签到成功」或「真实失败（非重试上限提示）」时推送，避免刷屏
  const hasBlockingError = results.some((r) => r.status === 'error' && !r.noPush);
  const shouldPush = hasSuccess || hasBlockingError;
  const title = hasBlockingError ? '签到提醒（有失败）' : '签到完成';
  console.log(summary);

  let pushResult = '本次无新签到（今日已签或无需操作），跳过推送';
  if (shouldPush) {
    try {
      pushResult = await sendPushPlus(env, title, summary);
    } catch (e) {
      pushResult = '推送失败: ' + e.message;
    }
  }

  return {
    status: hasBlockingError ? 'partial' : 'success',
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
  // 定时触发：每 15 分钟一次
  // 随机时间原理（改进版，更稳健）：
  //   - 基于当天日期算出"幸运时间槽"luckySlot（北京时间 8:00-22:45 内随机，每天不同）
  //   - 当前时间槽 currentSlot 还没到 luckySlot → 跳过（保证"随机时间点"特性）
  //   - currentSlot 到达并超过 luckySlot（且仍在 8:00-22:45 窗口内）→ 尝试签到
  //   - 若当天已签到，runCheckIn 内部会识别 already_signed 直接返回，不会重复签到
  //   - 若某次网络抖动失败，下一个 15 分钟槽会再次尝试，直到当天签上为至（自动重试）
  async scheduled(controller, env, ctx) {
    const bj = getBeijingNow();
    const luckySlot = getTodayLuckySlot(bj);
    const currentSlot = getCurrentSlot(bj);

    // 不在窗口内（深夜/凌晨）→ 跳过，绝不在半夜签到
    if (currentSlot === -1) {
      console.log(
        `[skip] 非签到窗口（北京时间 ${slotToBeijingTime(0)}~${slotToBeijingTime(WINDOW_SLOTS - 1)}），跳过`
      );
      return;
    }
    // 未到幸运时间 → 跳过
    if (currentSlot < luckySlot) {
      console.log(
        `[skip] 今日幸运时间 ${slotToBeijingTime(luckySlot)}（北京），` +
        `当前 ${slotToBeijingTime(currentSlot)}，跳过`
      );
      return;
    }

    console.log(`[run] 已进入今日幸运时间窗口 ${slotToBeijingTime(luckySlot)}（北京），尝试签到`);
    ctx.waitUntil(handleCheckin(env, beijingDateStr(bj)));
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
      const bj = getBeijingNow();
      const luckySlot = getTodayLuckySlot(bj);
      const result = await handleCheckin(env, beijingDateStr(bj));
      result.luckyTime = slotToBeijingTime(luckySlot);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // 查看今日幸运时间（不执行签到）
    if (url.pathname === '/lucky') {
      const bj = getBeijingNow();
      const luckySlot = getTodayLuckySlot(bj);
      const currentSlot = getCurrentSlot(bj);
      return new Response(
        JSON.stringify({
          date: beijingDateStr(bj),
          luckyTimeBeijing: slotToBeijingTime(luckySlot),
          currentTimeBeijing: currentSlot === -1 ? '非窗口' : slotToBeijingTime(currentSlot),
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
