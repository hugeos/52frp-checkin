// 88frp.com 自动签到核心逻辑（纯 API，无需验证码/滑块）
// 适用于 Cloudflare Workers 与 Node.js 22+（两者均有全局 fetch）
//
// 签到链路（逆向自 88frp 前端 API）：
//   1. POST /api/auth/login                     账号密码登录，返回 JWT token
//   2. GET  /api/users/mine                      详细信息（流量、签到状态）
//   3. POST /api/domain/value-added-rights/signIn  提交签到
//
// 环境变量：FRP88_USERNAME / FRP88_PASSWORD
//
// 健壮性设计：
//   - 所有响应先 .text() 再安全 JSON.parse，非 JSON 响应（如 CF 522 错误页）不会崩溃
//   - 5xx 错误 / 网络超时自动重试（最多 3 次，退避延迟）
//   - 请求超时控制（15s），避免 Worker 挂死

const BASE_URL = 'https://api.88frp.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 请求超时（毫秒）
const REQUEST_TIMEOUT = 15000;
// 最大重试次数
const MAX_RETRIES = 3;
// 重试基础延迟（毫秒），实际延迟 = base * attempt
const RETRY_BASE_DELAY = 1500;

// ---------------- 工具函数 ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0B';
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + 'TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + 'GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(2) + 'MB';
  if (v >= 1024) return (v / 1024).toFixed(2) + 'KB';
  return v.toFixed(0) + 'B';
}

/**
 * 安全解析响应体为 JSON。
 * 先 .text() 读取原始内容，再尝试 JSON.parse。
 * 非 JSON 响应（如 Cloudflare "error code:522"）返回 null 而非抛异常。
 */
async function safeJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 带超时的 fetch。
 * Cloudflare Workers 的 fetch 没有内置超时，用 AbortController 实现。
 */
async function fetchWithTimeout(url, options, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试的请求封装。
 * - 5xx 响应（含 522 源站超时）自动重试
 * - 网络错误（fetch reject / abort）自动重试
 * - 4xx 响应不重试，直接返回（交给业务逻辑处理）
 * - 返回 { status, data, rawText }
 */
async function request88(path, options = {}) {
  const url = BASE_URL + path;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options);

      // 5xx 错误：服务器临时故障（522/523/524 等），重试
      if (res.status >= 500) {
        const text = await res.text();
        lastError = new Error(`服务器错误 ${res.status}（${path}）：${text.slice(0, 120)}`);
        if (attempt < MAX_RETRIES) {
          console.log(`[88frp] ${path} 返回 ${res.status}，第 ${attempt} 次重试…`);
          await sleep(RETRY_BASE_DELAY * attempt);
          continue;
        }
        throw lastError;
      }

      // 成功或 4xx：读取响应体并返回
      const data = await safeJson(res);
      return { status: res.status, data, ok: res.ok };
    } catch (err) {
      // 网络错误 / 超时中止：重试
      const isAbort = err.name === 'AbortError';
      lastError = isAbort
        ? new Error(`请求超时（${path}，${REQUEST_TIMEOUT / 1000}s）`)
        : err;

      if (attempt < MAX_RETRIES) {
        console.log(`[88frp] ${path} 请求失败（${lastError.message}），第 ${attempt} 次重试…`);
        await sleep(RETRY_BASE_DELAY * attempt);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error(`请求失败（${path}）`);
}

function isAlreadySigned(data, status) {
  if (status === 400 && data && data.message && data.message.includes('已签到')) return true;
  if (data && data.success === false && data.message && data.message.includes('已签到')) return true;
  return false;
}

// ---------------- 主签到流程 ----------------

/**
 * 执行一次 88frp 签到。env 需包含 FRP88_USERNAME / FRP88_PASSWORD。
 * 返回 { status: 'success' | 'already_signed' | 'error', message, details }
 */
export async function runCheckIn88(env) {
  if (!env.FRP88_USERNAME || !env.FRP88_PASSWORD) {
    throw new Error('缺少 FRP88_USERNAME / FRP88_PASSWORD');
  }

  const authHeaders = {
    'User-Agent': UA,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.88frp.com',
    Referer: 'https://www.88frp.com/',
  };

  // 1. 登录（带重试）
  const loginRes = await request88('/api/auth/login', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ username: env.FRP88_USERNAME, password: env.FRP88_PASSWORD }),
  });

  const loginData = loginRes.data;
  if (!loginData || !loginData.success || !loginData.data || !loginData.data.token) {
    const msg = loginData ? loginData.message : `HTTP ${loginRes.status} 响应非 JSON`;
    throw new Error('登录失败: ' + (msg || '未知错误'));
  }

  const token = loginData.data.token;
  authHeaders.Authorization = 'Bearer ' + token;

  // 2. 获取用户详细信息（流量、签到状态）— 非关键，失败不阻断
  let userInfo = null;
  try {
    const meRes = await request88('/api/users/mine', { headers: authHeaders });
    if (meRes.data && meRes.data.success && meRes.data.data) {
      userInfo = meRes.data.data;
    }
  } catch {
    /* 非关键步骤，忽略 */
  }

  // 3. 签到（带重试）
  const signRes = await request88('/api/domain/value-added-rights/signIn', {
    method: 'POST',
    headers: authHeaders,
  });

  const signData = signRes.data;

  // 4. 判断签到结果
  if (signRes.status === 200 && signData && signData.success) {
    // 签到成功
    const detail = (signData.data) || {};
    const giftTraffic =
      detail.giftTraffic ||
      (userInfo && userInfo.valueAddedRight && userInfo.valueAddedRight.giftTraffic) ||
      0;
    const totalTraffic = (userInfo && userInfo.totalTraffic) || 0;

    const parts = ['88frp'];
    if (giftTraffic) parts.push('本次+' + giftTraffic + 'GB');
    if (totalTraffic) parts.push('总流量' + formatBytes(totalTraffic));
    if (userInfo && userInfo.balance) parts.push('余额¥' + userInfo.balance);

    return {
      status: 'success',
      message: parts.join(' ') || '签到成功',
      details: {
        giftTraffic: giftTraffic,
        totalTrafficBytes: totalTraffic,
        balance: userInfo ? userInfo.balance : null,
        lastSignInTime: detail.lastSignInTime || null,
      },
    };
  }

  if (isAlreadySigned(signData, signRes.status)) {
    // 今日已签到
    const valueAdded = (userInfo && userInfo.valueAddedRight) || {};
    const totalTraffic = (userInfo && userInfo.totalTraffic) || 0;

    const parts = ['88frp'];
    if (totalTraffic) parts.push('总流量' + formatBytes(totalTraffic));
    if (userInfo && userInfo.balance) parts.push('余额¥' + userInfo.balance);
    if (valueAdded.lastSignInTime) {
      const lastTime = new Date(valueAdded.lastSignInTime);
      parts.push(
        '上次签到' +
          lastTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      );
    }

    return {
      status: 'already_signed',
      message: parts.join(' ') || '今天已经签到过了',
      details: {
        totalTrafficBytes: totalTraffic,
        balance: userInfo ? userInfo.balance : null,
        lastSignInTime: valueAdded.lastSignInTime || null,
      },
    };
  }

  // 签到失败
  const failMsg = signData ? signData.message : `HTTP ${signRes.status}`;
  throw new Error('签到失败: ' + (failMsg || '未知错误'));
}
