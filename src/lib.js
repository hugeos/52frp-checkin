// 52frp 自动签到核心逻辑（纯 API 方式，无需浏览器）
// 适用于 Cloudflare Workers 与 Node.js 22+（两者均有全局 fetch）
//
// 签到链路（逆向自 52frp 面板 API）：
//   1. GET  /user/              建立 session（拿 cookie）
//   2. POST /api/user/login      账号密码登录，返回 Bearer token
//   3. GET  /api/user/info       账户流量信息（可选，用于推送展示）
//   4. GET  /api/user/sign/info  查询今日签到状态
//   5. GET  /api/user/slider-token  获取一次性 slider_token
//   6. POST /api/user/sign       提交签到 { slider_token }

const BASE_URL = 'https://www.52frp.com/api';
const PANEL_URL = 'https://www.52frp.com/user/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------- 工具函数 ----------------

function unwrapData(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function extractMessage(payload, fallback = '请求失败') {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return fallback;
  const root = unwrapData(payload);
  const nested = unwrapData(root);
  return (
    nested?.msg || nested?.message ||
    root?.msg || root?.message ||
    payload?.msg || payload?.message ||
    fallback
  );
}

function isPayloadFailure(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.success === false) return true;
  if (typeof payload.code === 'number' && payload.code !== 200) return true;
  if (typeof payload.status === 'number' && payload.status !== 200) return true;
  return false;
}

function extractLoginToken(payload) {
  const root = unwrapData(payload);
  const nested = unwrapData(root);
  return (
    nested?.token || nested?.Token ||
    root?.token || root?.Token ||
    payload?.token || payload?.Token ||
    ''
  );
}

function extractSliderToken(payload) {
  const root = unwrapData(payload);
  const nested = unwrapData(root);
  return (
    nested?.token || nested?.slider_token ||
    root?.token || root?.slider_token ||
    payload?.token || payload?.slider_token ||
    ''
  );
}

function normalizeSignInfo(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};
  return {
    totalSignDays: toNumber(data.total_sign_days ?? data.totalsign, 0),
    totalTrafficBytes: toNumber(data.total_traffic ?? data.totaltraffic, 0),
    availableTrafficBytes: toNumber(data.available_traffic ?? data.sign_available_traffic, 0),
    signedToday: Boolean(data.signed_today ?? data.signed),
    lastSignTime: toNumber(data.signdate ?? data.last_sign_time, 0),
    minTrafficBytes: toNumber(data.min_traffic ?? data.sign_min, 0),
    maxTrafficBytes: toNumber(data.max_traffic ?? data.sign_max, 0),
  };
}

function normalizeUserInfo(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};
  const traffic = data.traffic || {};
  return {
    totalTrafficBytes: toNumber(traffic.total ?? data.total_traffic ?? data.traffic, 0),
    usedTrafficBytes: toNumber(traffic.total_used ?? data.used_traffic, 0),
    remainingTrafficBytes: toNumber(traffic.total_remaining ?? data.remaining_traffic, 0),
  };
}

function extractRewardBytes(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};
  return toNumber(
    data.reward_traffic ?? data.traffic_reward ?? data.sign_reward_traffic ??
      data.sign_traffic ?? data.traffic_bytes ?? data.last_traffic,
    0
  );
}

function isRateLimited(payload) {
  const msg = extractMessage(payload, '');
  const status = payload?.status || payload?.data?.status || 0;
  return status === 429 || msg.includes('次数已达上限') || msg.includes('请明天再试');
}

function formatBytesCompact(bytes) {
  const value = toNumber(bytes, 0);
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)}TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`;
  return `${value.toFixed(0)}B`;
}

function buildAlreadySignedMessage(info, userInfo) {
  const parts = ['52frp'];
  if (info.totalSignDays > 0) parts.push(`连续签到${info.totalSignDays}天`);
  if (info.totalTrafficBytes > 0) parts.push(`累计${formatBytesCompact(info.totalTrafficBytes)}`);
  if (userInfo && userInfo.remainingTrafficBytes > 0)
    parts.push(`剩余${formatBytesCompact(userInfo.remainingTrafficBytes)}`);
  return parts.join(' ') || '今天已经签到过了';
}

function buildSuccessMessage(info, rewardBytes, userInfo) {
  const parts = ['52frp'];
  if (info.totalSignDays > 0) parts.push(`连续签到${info.totalSignDays}天`);
  if (rewardBytes > 0) parts.push(`本次+${formatBytesCompact(rewardBytes)}`);
  if (userInfo && userInfo.remainingTrafficBytes > 0)
    parts.push(`剩余${formatBytesCompact(userInfo.remainingTrafficBytes)}`);
  return parts.join(' ') || '签到成功';
}

// ---------------- API 客户端 ----------------

function createApiClient() {
  const token = { value: '' };
  const cookies = new Map();

  function buildHeaders(extra = {}) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Referer: PANEL_URL,
      ...extra,
    };
    if (token.value) headers.Authorization = `Bearer ${token.value}`;
    if (cookies.size > 0)
      headers.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    return headers;
  }

  function storeCookies(headers) {
    let setCookies = [];
    if (typeof headers.getSetCookie === 'function') setCookies = headers.getSetCookie();
    else {
      const s = headers.get('set-cookie');
      if (s) setCookies = [s];
    }
    for (const line of setCookies) {
      const pair = String(line).split(';')[0];
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async function request(method, path, { body, headers } = {}) {
    const init = { method, headers: buildHeaders(headers) };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}/${String(path).replace(/^\/+/, '')}`, init);
    storeCookies(res.headers);
    const text = await res.text();
    let payload = text;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!res.ok || isPayloadFailure(payload)) {
      throw new Error(extractMessage(payload, `请求失败 (${res.status})`));
    }
    return payload;
  }

  async function primeSession() {
    const res = await fetch(PANEL_URL, {
      method: 'GET',
      headers: buildHeaders({ Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
    });
    storeCookies(res.headers);
    await res.text();
  }

  return {
    async login(creds) {
      if (cookies.size === 0) await primeSession();
      return request('POST', 'user/login', { body: creds });
    },
    setToken(t) {
      token.value = String(t || '').replace(/^Bearer\s+/i, '');
    },
    getSignInfo() {
      return request('GET', 'user/sign/info');
    },
    getSignSliderToken() {
      return request('GET', 'user/slider-token');
    },
    signIn(sliderToken) {
      return request('POST', 'user/sign', { body: { slider_token: sliderToken } });
    },
    getUserInfo() {
      return request('GET', 'user/info');
    },
  };
}

// ---------------- 主签到流程 ----------------

/**
 * 执行一次完整签到。env 需包含 FRP_USERNAME / FRP_PASSWORD。
 * 返回 { status: 'success' | 'already_signed' | 'error', message, details }
 */
export async function runCheckIn(env) {
  if (!env.FRP_USERNAME || !env.FRP_PASSWORD) {
    throw new Error('缺少 FRP_USERNAME / FRP_PASSWORD');
  }
  const api = createApiClient();
  const creds = { username: env.FRP_USERNAME, password: env.FRP_PASSWORD };

  // 1. 登录
  const loginRes = await api.login(creds);
  const authToken = extractLoginToken(loginRes);
  if (!authToken) {
    throw new Error('登录成功但未拿到 token（可能触发了登录滑块验证，纯 API 无法处理）');
  }
  api.setToken(authToken);

  // 2. 账户流量信息（可选）
  let userInfo = null;
  try {
    userInfo = normalizeUserInfo(await api.getUserInfo());
  } catch {
    /* ignore */
  }

  // 3. 签到状态
  const beforeInfo = normalizeSignInfo(await api.getSignInfo());
  if (beforeInfo.signedToday) {
    return {
      status: 'already_signed',
      message: buildAlreadySignedMessage(beforeInfo, userInfo),
      details: { ...beforeInfo, userInfo },
    };
  }

  // 4. 获取 slider_token
  const sliderRes = await api.getSignSliderToken();
  const sliderToken = extractSliderToken(sliderRes);
  if (!sliderToken) throw new Error('签到前未拿到 slider_token');

  // 5. 提交签到
  const signRes = await api.signIn(sliderToken);
  if (isRateLimited(signRes)) throw new Error('今日签到尝试次数已达上限，请明天再试');

  // 6. 复查签到状态
  let finalInfo = beforeInfo;
  try {
    finalInfo = normalizeSignInfo(await api.getSignInfo());
  } catch {
    /* keep before */
  }
  try {
    userInfo = normalizeUserInfo(await api.getUserInfo());
  } catch {
    /* keep previous */
  }

  const rewardBytes = extractRewardBytes(signRes) || 0;

  // 校验是否真的签到成功
  if (!finalInfo.signedToday) {
    throw new Error('签到请求已发送，但接口仍显示未签到（服务端可能要求真实滑块拖拽，纯 API 被拒绝）');
  }

  return {
    status: 'success',
    message: buildSuccessMessage(finalInfo, rewardBytes, userInfo),
    details: { ...finalInfo, rewardBytes, userInfo },
  };
}

// ---------------- PushPlus 推送 ----------------

export async function sendPushPlus(env, title, content) {
  const token = env.PUSHPLUS_TOKEN;
  if (!token) return '未配置 PUSHPLUS_TOKEN，跳过推送';
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content }),
  });
  return await res.text();
}
