// 52frp + 88frp 自动签到 Worker
// 每天北京时间 8:00-20:00 内随机时间签到一次
// 失败后 30 分钟重试一次，再失败则放弃（用户会人工签到）

import { runCheckIn, sendPushPlus } from './lib.js';
import { runCheckIn88 } from './frp88.js';

// ========== 北京时间 ==========

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function todayStr(d) {
  return d.toISOString().slice(0, 10);
}

function timeMin(d) {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ========== 随机时间槽（8:00-20:00，每15分钟一个槽） ==========

const WIN_START = 8 * 60;   // 480 (08:00)
const WIN_END = 20 * 60;    // 1200 (20:00)
const SLOT = 15;
const TOTAL_SLOTS = (WIN_END - WIN_START) / SLOT; // 48

function dailySeed(dateStr) {
  let h = 2166136261;
  for (const c of dateStr) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function luckySlot(dateStr) {
  return dailySeed(dateStr) % TOTAL_SLOTS;
}

function slotTime(slot) {
  const m = WIN_START + slot * SLOT;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ========== 签到执行 ==========

async function doCheckin(env, bjNow) {
  const date = todayStr(bjNow);
  const kv = env.SIGN_STATE;
  const results = [];
  let shouldPush = false;

  // ---- 52frp ----
  if (env.FRP_USERNAME) {
    const doneKey = `s52:${date}`;
    const retryKey = `s52r:${date}`;
    const done = await kv.get(doneKey);
    const retryAt = await kv.get(retryKey);

    // 已完成或已放弃 → 跳过
    if (done === 'ok') {
      results.push({ site: '52frp', status: 'already_signed', message: '今日已签' });
    } else if (done === 'x') {
      results.push({ site: '52frp', status: 'error', message: '今日签到失败（已重试），请人工签到' });
    }
    // 等待重试中
    else if (retryAt && Date.now() < Number(retryAt)) {
      const waitMin = Math.ceil((Number(retryAt) - Date.now()) / 60000);
      results.push({ site: '52frp', status: 'waiting', message: `等待 ${waitMin} 分钟后重试` });
    }
    // 执行签到（首次或重试）
    else {
      let result;
      try {
        result = await runCheckIn(env);
      } catch (e) {
        result = { status: 'error', message: e.message };
      }

      if (result.status === 'success') {
        await kv.put(doneKey, 'ok', { expirationTtl: 86400 });
        results.push({ site: '52frp', status: 'success', message: result.message });
        shouldPush = true;
      } else if (result.status === 'already_signed') {
        await kv.put(doneKey, 'ok', { expirationTtl: 86400 });
        results.push({ site: '52frp', status: 'already_signed', message: result.message });
      } else {
        // 失败处理
        if (retryAt) {
          // 这是重试，又失败了 → 放弃
          await kv.put(doneKey, 'x', { expirationTtl: 86400 });
          await kv.delete(retryKey);
          const msg = result.message.includes('已达上限')
            ? '52frp 签到次数已达上限，明天自动重试'
            : '52frp 签到失败（已重试），请人工签到';
          results.push({ site: '52frp', status: 'error', message: msg });
          shouldPush = true;
        } else {
          // 首次失败 → 30 分钟后重试
          const retryTime = Date.now() + 30 * 60 * 1000;
          await kv.put(retryKey, String(retryTime), { expirationTtl: 3600 });
          results.push({
            site: '52frp',
            status: 'retry',
            message: `52frp 签到失败: ${result.message}，将在 30 分钟后重试`,
          });
          shouldPush = true;
        }
      }
    }
  }

  // ---- 88frp（主账号 + 附加账号 _2.._5）----
  const frp88acts = [];
  if (env.FRP88_USERNAME) frp88acts.push({ label: '88frp', user: env.FRP88_USERNAME, pass: env.FRP88_PASSWORD });
  for (let i = 2; i <= 5; i++) {
    const u = env[`FRP88_USERNAME_${i}`];
    const p = env[`FRP88_PASSWORD_${i}`];
    if (u && p) frp88acts.push({ label: `88frp-${i}`, user: u, pass: p });
  }

  for (const act of frp88acts) {
    const key = `s88_${act.label}:${date}`;
    if (await kv.get(key)) {
      results.push({ site: act.label, status: 'already_signed', message: '今日已签' });
      continue;
    }
    let result;
    try {
      result = await runCheckIn88(env, { username: act.user, password: act.pass });
    } catch (e) {
      result = { status: 'error', message: e.message };
    }
    if (result.status === 'success') {
      await kv.put(key, '1', { expirationTtl: 86400 });
      results.push({ site: act.label, status: 'success', message: result.message });
      shouldPush = true;
    } else if (result.status === 'already_signed') {
      await kv.put(key, '1', { expirationTtl: 86400 });
      results.push({ site: act.label, status: 'already_signed', message: result.message });
    } else {
      results.push({ site: act.label, status: 'error', message: result.message });
      shouldPush = true;
    }
  }

  // ---- 推送 ----
  const lines = results.map(r => `【${r.site}】${r.status === 'success' ? '✅' : r.status === 'already_signed' ? '☑️' : r.status === 'waiting' ? '⏳' : r.status === 'retry' ? '🔄' : '❌'} ${r.message}`);
  const summary = lines.join('\n');
  console.log(summary);

  let pushMsg = '';
  if (shouldPush) {
    try {
      pushMsg = await sendPushPlus(env, '签到通知', summary);
    } catch (e) {
      pushMsg = '推送失败: ' + e.message;
    }
  }

  return { results, push: pushMsg, summary };
}

// ========== Worker 入口 ==========

export default {
  async scheduled(_ctrl, env, ctx) {
    const bj = beijingNow();
    const mins = timeMin(bj);
    const date = todayStr(bj);

    // 非窗口时间 → 跳过
    if (mins < WIN_START || mins > WIN_END) {
      console.log(`[skip] ${slotTime(0)}前/后，跳过`);
      return;
    }

    // 检查是否已到今天的随机时间槽
    const slot = luckySlot(date);
    const currentSlot = Math.floor((mins - WIN_START) / SLOT);

    // 查看是否有待重试
    const retryAt = await env.SIGN_STATE.get(`s52r:${date}`);
    const hasRetry = retryAt && Date.now() >= Number(retryAt);

    // 如果没到幸运槽位且没有待重试 → 跳过
    if (currentSlot < slot && !hasRetry) {
      console.log(`[skip] 今日签到时间 ${slotTime(slot)}，当前 ${slotTime(currentSlot)}，跳过`);
      return;
    }

    // 已过幸运槽位（或到重试时间）→ 执行签到
    console.log(`[run] 签到时间 ${slotTime(slot)}，当前 ${slotTime(Math.floor(currentSlot))}`);
    ctx.waitUntil(doCheckin(env, bj));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // 手动触发签到
    if (url.pathname === '/run' || url.pathname === '/') {
      const bj = beijingNow();
      const mins = timeMin(bj);
      if (mins < WIN_START || mins > WIN_END) {
        return new Response(JSON.stringify({ skipped: true, reason: `非签到窗口（${slotTime(0)}-${slotTime(TOTAL_SLOTS - 1)}）` }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      const result = await doCheckin(env, bj);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // 查看今日签到时间
    if (url.pathname === '/lucky') {
      const bj = beijingNow();
      const s = luckySlot(todayStr(bj));
      return new Response(JSON.stringify({
        date: todayStr(bj),
        time: slotTime(s),
        window: `${slotTime(0)}-${slotTime(TOTAL_SLOTS - 1)}`,
      }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    return new Response('FRP签到\n/run 手动签到\n/lucky 查看签到时间', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
