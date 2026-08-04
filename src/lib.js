// 52frp 自动签到（纯 API）
// 链路：GET /user/ → POST /user/login → GET /user/sign/info → GET /user/slider-token → POST /user/sign
// 注意：52frp 有反爬请求特征校验（TLS 指纹 + 请求头组合），纯 API 请求必须尽量模拟真实 Chrome 请求头。

const BASE = 'https://www.52frp.com/api';
const PANEL = 'https://www.52frp.com/user/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ---- 工具 ----

function unwrap(p) {
  if (!p || typeof p !== 'object') return p;
  return p.data ?? p;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function msg(payload, fallback = '请求失败') {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return fallback;
  const r = unwrap(unwrap(payload));
  return r?.msg || r?.message || payload?.msg || payload?.message || fallback;
}

function isFail(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.success === false) return true;
  if (typeof payload.code === 'number' && payload.code !== 200) return true;
  if (typeof payload.status === 'number' && payload.status !== 200) return true;
  return false;
}

function bytes(v) {
  const b = num(v);
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + 'TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + 'GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + 'MB';
  if (b >= 1024) return (b / 1024).toFixed(2) + 'KB';
  return b + 'B';
}

// ---- API 客户端 ----

function api() {
  let token = '';
  let csrf = '';
  const jar = new Map();

  const hdrs = (extra = {}) => {
    const h = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Priority: 'u=1, i',
      Origin: 'https://www.52frp.com',
      Referer: PANEL,
      ...extra,
    };
    if (token) h.Authorization = `Bearer ${token}`;
    if (csrf) h['X-CSRF-Token'] = csrf;
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return h;
  };

  const saveCookies = (resp) => {
    const sc = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : [resp.headers.get('set-cookie')].filter(Boolean);
    for (const c of sc) {
      const p = String(c).split(';')[0];
      const i = p.indexOf('=');
      if (i > 0) {
        const k = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        jar.set(k, v);
        // 52frp 登录后下发的 CSRF token（POST 必须带 X-CSRF-Token 头，否则 400）
        if (k === 'hzfrp_user_csrf') csrf = v;
      }
    }
  };

  const call = async (method, path, body) => {
    const init = { method, headers: hdrs() };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(`${BASE}/${path.replace(/^\/+/, '')}`, init);
    saveCookies(res);
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* raw */ }
    if (!res.ok || isFail(data)) {
      const e = new Error(msg(data, `HTTP ${res.status}`));
      e.payload = data;
      e.status = res.status;
      throw e;
    }
    return data;
  };

  return {
    async prime() {
      const r = await fetch(PANEL, { headers: hdrs({ Accept: 'text/html,*/*' }) });
      saveCookies(r);
    },
    async login(u, p) {
      if (!jar.size) await this.prime();
      return call('POST', 'user/login', { username: u, password: p });
    },
    setToken(t) { token = String(t || '').replace(/^Bearer\s+/i, ''); },
    signInfo() { return call('GET', 'user/sign/info'); },
    slider() { return call('GET', 'user/slider-token'); },
    sign(st) { return call('POST', 'user/sign', { slider_token: st }); },
    userInfo() { return call('GET', 'user/info'); },
  };
}

// ---- 签到 ----

export async function runCheckIn(env) {
  const u = env.FRP_USERNAME;
  const p = env.FRP_PASSWORD;
  if (!u || !p) throw new Error('缺少 FRP_USERNAME / FRP_PASSWORD');

  const a = api();

  // 1. 登录
  const login = await a.login(u, p);
  const t = unwrap(unwrap(login))?.token || login?.token || '';
  if (!t) throw new Error('登录未拿到 token');
  a.setToken(t);

  // 2. 签到状态
  const si = unwrap(await a.signInfo());
  const info = unwrap(si) || {};
  if (info.signed_today) {
    const days = num(info.total_sign_days);
    const remain = bytes(num(info.available_traffic || info.total_traffic));
    return { status: 'already_signed', message: `52frp 今日已签（连续${days}天，剩余${remain}）` };
  }

  // 3. 滑块 token（浏览器实测会连续获取两次、用最后一次，尽量贴近）
  let sToken = '';
  for (let i = 0; i < 2; i++) {
    const st = unwrap(await a.slider());
    const tk = unwrap(st)?.token || st?.token || '';
    if (tk) sToken = tk;
  }
  if (!sToken) throw new Error('未拿到 slider_token');

  // 4. 签到
  await a.sign(sToken);

  // 5. 验证
  const after = unwrap(await a.signInfo());
  const ai = unwrap(after) || {};
  if (!ai.signed_today) {
    throw new Error('签到请求已发送但未生效（可能需真人滑块验证）');
  }

  const days = num(ai.total_sign_days);
  const bytes = num(ai.available_traffic || ai.total_traffic);
  return { status: 'success', message: `52frp 签到成功！连续${days}天，剩余${bytes > 0 ? formatBytesCompact(bytes) : '--'}` };
}

function formatBytesCompact(bytes) {
  const value = num(bytes, 0);
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)}TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`;
  return `${value.toFixed(0)}B`;
}

// ---- PushPlus 推送 ----

export async function sendPushPlus(env, title, content) {
  const token = env.PUSHPLUS_TOKEN;
  if (!token) return '未配置 PUSHPLUS_TOKEN';
  const r = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content }),
  });
  return await r.text();
}
