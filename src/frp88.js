// 88frp.com 自动签到核心逻辑（纯 API，无需验证码/滑块）
// 适用于 Cloudflare Workers 与 Node.js 22+（两者均有全局 fetch）
//
// 签到链路（逆向自 88frp 前端 API）：
//   1. POST /api/auth/login                     账号密码登录，返回 JWT token
//   2. GET  /api/users/me                        账户信息（余额等）
//   3. GET  /api/users/mine                      详细信息（流量、签到状态）
//   4. POST /api/domain/value-added-rights/signIn  提交签到
//
// 环境变量：FRP88_USERNAME / FRP88_PASSWORD

const BASE_URL = 'https://api.88frp.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------- 工具函数 ----------------

function formatBytes(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0B';
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + 'TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + 'GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(2) + 'MB';
  if (v >= 1024) return (v / 1024).toFixed(2) + 'KB';
  return v.toFixed(0) + 'B';
}

function isAlreadySigned(payload, status) {
  if (status === 400 && payload && payload.message && payload.message.includes('已签到')) return true;
  if (payload && payload.success === false && payload.message && payload.message.includes('已签到')) return true;
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
  };

  // 1. 登录
  const loginRes = await fetch(BASE_URL + '/api/auth/login', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ username: env.FRP88_USERNAME, password: env.FRP88_PASSWORD }),
  });
  const loginData = await loginRes.json();

  if (!loginData.success || !loginData.data || !loginData.data.token) {
    throw new Error('登录失败: ' + (loginData.message || JSON.stringify(loginData)));
  }

  const token = loginData.data.token;
  authHeaders.Authorization = 'Bearer ' + token;

  // 2. 获取用户详细信息（流量、签到状态）
  let userInfo = null;
  try {
    const meRes = await fetch(BASE_URL + '/api/users/mine', { headers: authHeaders });
    const meData = await meRes.json();
    if (meData.success && meData.data) {
      userInfo = meData.data;
    }
  } catch {
    /* 非关键步骤，忽略 */
  }

  // 3. 签到
  const signRes = await fetch(BASE_URL + '/api/domain/value-added-rights/signIn', {
    method: 'POST',
    headers: authHeaders,
  });
  const signText = await signRes.text();
  let signData;
  try {
    signData = JSON.parse(signText);
  } catch {
    signData = { raw: signText };
  }

  // 4. 判断签到结果
  if (signRes.status === 200 && signData.success) {
    // 签到成功
    const detail = signData.data || {};
    const giftTraffic = detail.giftTraffic || (userInfo && userInfo.valueAddedRight && userInfo.valueAddedRight.giftTraffic) || 0;
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
    const valueAdded = userInfo && userInfo.valueAddedRight ? userInfo.valueAddedRight : {};
    const totalTraffic = (userInfo && userInfo.totalTraffic) || 0;

    const parts = ['88frp'];
    if (totalTraffic) parts.push('总流量' + formatBytes(totalTraffic));
    if (userInfo && userInfo.balance) parts.push('余额¥' + userInfo.balance);
    if (valueAdded.lastSignInTime) {
      const lastTime = new Date(valueAdded.lastSignInTime);
      parts.push('上次签到' + lastTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
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
  throw new Error('签到失败: ' + (signData.message || signText.slice(0, 200)));
}
