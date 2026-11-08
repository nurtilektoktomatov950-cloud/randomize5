// (c) 2026 @m1_plugins. Бот «Рандомайзер»: розыгрыши в Telegram. Cloudflare Worker + D1.
// Переменные: BOT_TOKEN (секрет), WEBHOOK_SECRET (латиница и цифры), WEBAPP_URL. Привязка D1: DB.

const SUB_OK = new Set(['member', 'administrator', 'creator']);
const enc = new TextEncoder();
const CAP = [['🐱', 'кота'], ['🚗', 'машину'], ['🍎', 'яблоко'], ['⚽', 'мяч'], ['🌳', 'дерево'], ['🔑', 'ключ'], ['🎈', 'шарик'], ['🐟', 'рыбу'], ['☂️', 'зонт']];
let ME = null;

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function rid(n) { const a = new Uint8Array(n || 8); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); }
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const kb = rows => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

async function tg(env, method, body) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
async function me(env) { if (!ME) { const r = await tg(env, 'getMe'); if (r.ok) ME = r.result; } return ME; }
const say = (env, chat, text, extra) => tg(env, 'sendMessage', Object.assign({ chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, extra || {}));
const nameOf = u => u.username ? '@' + u.username : (u.first_name || 'Участник');
function fmt(env, ts) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: env.TZ || 'Asia/Bishkek', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

/* ---------- storage ---------- */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS giveaways(id TEXT PRIMARY KEY, owner_id INTEGER, text TEXT, entities TEXT, photo TEXT, button TEXT, chat_id INTEGER, chat_title TEXT, chat_username TEXT, message_id INTEGER, winners INTEGER, ends_at INTEGER, status TEXT, seed TEXT, commit_hash TEXT, boosts INTEGER, captcha INTEGER, created_at INTEGER, result TEXT)',
  'CREATE TABLE IF NOT EXISTS participants(gid TEXT, user_id INTEGER, name TEXT, w INTEGER, joined_at INTEGER, PRIMARY KEY(gid, user_id))',
  'CREATE TABLE IF NOT EXISTS sessions(user_id INTEGER PRIMARY KEY, step TEXT, data TEXT, updated INTEGER)',
  'CREATE TABLE IF NOT EXISTS channels(owner_id INTEGER, chat_id INTEGER, title TEXT, username TEXT, PRIMARY KEY(owner_id, chat_id))',
];
let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK) return;
  for (const q of SCHEMA) await env.DB.prepare(q).run();
  for (const col of ['conds TEXT', 'title TEXT', 'prize TEXT', 'max_p INTEGER']) { try { await env.DB.prepare('ALTER TABLE giveaways ADD COLUMN ' + col).run(); } catch (e) { /* уже есть */ } }
  SCHEMA_OK = true;
}
const listChannels = async (env, uid) => (await env.DB.prepare('SELECT chat_id, title, username FROM channels WHERE owner_id=? ORDER BY rowid').bind(uid).all()).results;
const addChannel = (env, uid, c) => env.DB.prepare('INSERT OR REPLACE INTO channels(owner_id, chat_id, title, username) VALUES(?,?,?,?)').bind(uid, c.id, c.title, c.username || null).run();
async function getS(env, uid) {
  const r = await env.DB.prepare('SELECT step, data FROM sessions WHERE user_id=?').bind(uid).first();
  return r ? { step: r.step, data: JSON.parse(r.data || '{}') } : null;
}
const setS = (env, uid, step, data) => env.DB.prepare('INSERT OR REPLACE INTO sessions(user_id, step, data, updated) VALUES(?,?,?,?)').bind(uid, step, JSON.stringify(data || {}), Date.now()).run();
const clearS = (env, uid) => env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid).run();
const count = async (env, gid) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM participants WHERE gid=?').bind(gid).first()).n;

/* ---------- menus ---------- */
async function welcome(env, chat) {
  const rows = env.WEBAPP_URL ? [[{ text: 'Открыть приложение', web_app: { url: env.WEBAPP_URL } }]] : [];
  return say(env, chat, '<b>Рандомайзер</b>\nСоздавайте розыгрыши и участвуйте в них. Победителя выбирает барабан, а честность можно проверить.', rows.length ? { reply_markup: kb(rows) } : {});
}

/* ---------- provably fair draw ---------- */
async function pickWinners(seed, parts, k) {
  const pool = parts.map(p => ({ id: String(p.user_id), w: p.w || 1, name: p.name })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const out = [];
  for (let i = 0; i < Math.min(k, pool.length); i++) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    const h = await sha256(seed + '|' + (i ? i + '|' : '') + pool.map(p => p.id + ':' + p.w).join(','));
    let pick = Number(BigInt('0x' + h) % BigInt(total)), acc = 0, idx = 0;
    for (let j = 0; j < pool.length; j++) { acc += pool[j].w; if (pick < acc) { idx = j; break; } }
    out.push({ id: pool[idx].id, name: pool[idx].name, w: pool[idx].w, hash: h });
    pool.splice(idx, 1);
  }
  return out;
}

async function finish(env, gid) {
  const lock = await env.DB.prepare("UPDATE giveaways SET status='done' WHERE id=? AND status='open'").bind(gid).run();
  if (!lock.meta || !lock.meta.changes) return false;
  const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(gid).first();
  const parts = (await env.DB.prepare('SELECT user_id, name, w FROM participants WHERE gid=?').bind(gid).all()).results;
  const ws = await pickWinners(g.seed, parts, g.winners);
  let text;
  if (!ws.length) {
    text = '🏁 <b>Итоги розыгрыша</b>\nУчастников не было, победителя нет.';
  } else {
    const who = ws.map((w, i) => (ws.length > 1 ? (i + 1) + '. ' : '') + (w.name.startsWith('@') ? esc(w.name) : '<a href="tg://user?id=' + w.id + '">' + esc(w.name) + '</a>')).join('\n');
    text = '🏁 <b>Итоги розыгрыша</b>\n\n🏆 <b>' + (ws.length > 1 ? 'Победители:' : 'Победитель:') + '</b>' + (ws.length > 1 ? '\n' : ' ') + who + '\n\n👥 <b>Участников:</b> ' + parts.length;
  }
  await tg(env, 'editMessageReplyMarkup', { chat_id: g.chat_id, message_id: g.message_id, reply_markup: kb([[btn('Завершён · участников: ' + parts.length, 'noop')]]) });
  await say(env, g.chat_id, text, { reply_parameters: { message_id: g.message_id } });
  await env.DB.prepare('UPDATE giveaways SET result=? WHERE id=?').bind(JSON.stringify(ws), gid).run();
  await say(env, g.owner_id, 'Розыгрыш завершён. ' + (ws.length ? 'Победитель: ' + esc(ws[0].name) + (ws.length > 1 ? ' и ещё ' + (ws.length - 1) : '') : 'Участников не было.'));
  return true;
}
async function finishDue(env) {
  const rows = (await env.DB.prepare("SELECT id FROM giveaways WHERE status='open' AND ends_at>0 AND ends_at<=?").bind(Date.now()).all()).results;
  for (const r of rows) await finish(env, r.id);
}

/* ---------- joining ---------- */
async function isSub(env, chatId, userId) {
  const m = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  const st = m.ok ? m.result.status : null;
  return !!(st && (SUB_OK.has(st) || (st === 'restricted' && m.result.is_member)));
}
async function tryJoin(env, g, user) {
  if (g.status !== 'open') return { ok: false, msg: 'Розыгрыш уже завершён.' };
  const ex = await env.DB.prepare('SELECT 1 AS x FROM participants WHERE gid=? AND user_id=?').bind(g.id, user.id).first();
  if (ex) return { ok: false, already: true, msg: 'Ты уже участвуешь.' };
  let conds = []; try { conds = JSON.parse(g.conds || '[]'); } catch (e) {}
  const need = [{ id: g.chat_id, title: g.chat_title, username: g.chat_username || null }].concat(conds);
  const missing = [];
  for (const c of need) if (!(await isSub(env, c.id, user.id))) missing.push({ title: c.title, username: c.username || null });
  if (missing.length) return { ok: false, missing, msg: ('Подпишись на: ' + missing.map(c => c.username ? '@' + c.username : c.title).join(', ') + '. Потом попробуй снова.').slice(0, 195) };
  let w = 1;
  if (g.boosts) {
    const b = await tg(env, 'getUserChatBoosts', { chat_id: g.chat_id, user_id: user.id });
    if (b.ok && b.result.boosts && b.result.boosts.length) w = 2;
  }
  await env.DB.prepare('INSERT OR IGNORE INTO participants(gid, user_id, name, w, joined_at) VALUES(?,?,?,?,?)').bind(g.id, user.id, nameOf(user), w, Date.now()).run();
  const n = await count(env, g.id);
  if (g.max_p && n >= g.max_p) await finish(env, g.id);
  return { ok: true, w, ticket: n, msg: w > 1 ? 'Ты участвуешь! Буст канала даёт шанс ×2.' : 'Ты участвуешь! Удачи.' };
}
async function sendCaptcha(env, chat, uid, gid) {
  const pool = CAP.slice().sort(() => Math.random() - 0.5).slice(0, 6);
  const target = Math.floor(Math.random() * pool.length);
  await setS(env, uid, 'captcha', { gid, target: pool[target][0] });
  const row = (a, b) => pool.slice(a, b).map((c, i) => btn(c[0], 'cp:' + c[0]));
  return say(env, chat, 'Проверка. Нажми на ' + pool[target][1] + '.', { reply_markup: kb([row(0, 3), row(3, 6)]) });
}

/* ---------- creating a giveaway ---------- */
async function verifyChannel(env, ref, userId) {
  const c = await tg(env, 'getChat', { chat_id: ref });
  if (!c.ok || c.result.type !== 'channel') return { err: 'Не нашёл такой канал. Проверь @username.' };
  const bot = await me(env);
  const bm = await tg(env, 'getChatMember', { chat_id: c.result.id, user_id: bot.id });
  if (!bm.ok || bm.result.status !== 'administrator') return { err: 'Я не админ канала «' + c.result.title + '». Добавь меня в администраторы (с правом публикации) и попробуй снова.' };
  if (bm.result.can_post_messages === false) return { err: 'У меня нет права публиковать сообщения в «' + c.result.title + '». Включи его в правах администратора.' };
  const um = await tg(env, 'getChatMember', { chat_id: c.result.id, user_id: userId });
  if (!um.ok || !['creator', 'administrator'].includes(um.result.status)) return { err: 'Ты не администратор канала «' + c.result.title + '», поэтому использовать его нельзя.' };
  return { chat: c.result };
}
function parseRef(v) {
  v = String(v || '').trim();
  const m = v.match(/^(?:https?:\/\/)?(?:t\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})$/);
  return m ? '@' + m[1] : null;
}
/* Простая разметка: **жирный** __курсив__ ~~зачёркнутый~~ ||спойлер|| `код` [текст](ссылка) */
const MARKS = [['**', 'bold'], ['__', 'italic'], ['~~', 'strikethrough'], ['||', 'spoiler'], ['`', 'code']];
function parseInto(src, st) {
  let i = 0;
  while (i < src.length) {
    if (src[i] === '[') {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(src.slice(i));
      if (m) { const off = st.out.length; parseInto(m[1], st); st.ents.push({ type: 'text_link', offset: off, length: st.out.length - off, url: m[2] }); i += m[0].length; continue; }
    }
    let hit = null;
    for (const [mk, type] of MARKS) {
      if (src.startsWith(mk, i)) { const j = src.indexOf(mk, i + mk.length); if (j > i + mk.length) { hit = [mk, type, j]; break; } }
    }
    if (hit) {
      const [mk, type, j] = hit, off = st.out.length, inner = src.slice(i + mk.length, j);
      if (type === 'code') st.out += inner; else parseInto(inner, st);
      if (st.out.length > off) st.ents.push({ type, offset: off, length: st.out.length - off });
      i = j + mk.length; continue;
    }
    st.out += src[i]; i++;
  }
}
function parseMarkup(src) {
  const st = { out: '', ents: [] };
  parseInto(String(src || ''), st);
  st.ents.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: st.out, entities: st.ents };
}
// Пост = ровно то, что прислал организатор. Бот ничего от себя не добавляет.
function buildPost(env, d) { return { text: d.text || '', entities: d.entities || [] }; }
const stripCustom = ents => (ents || []).filter(e => e.type !== 'custom_emoji');
const hasCustom = ents => (ents || []).some(e => e.type === 'custom_emoji');
function dataUrlToBlob(u) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
  if (!m) return null;
  const bin = atob(m[2]), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: m[1] });
}
async function tgForm(env, method, form) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, { method: 'POST', body: form });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
// Sends the post; if Telegram refuses premium emoji, retries with ordinary emoji.
async function sendPost(env, chat, d, post, extra) {
  const go = async ents => {
    if (d.blob) {
      const f = new FormData();
      f.append('chat_id', String(chat)); f.append('caption', post.text); f.append('caption_entities', JSON.stringify(ents));
      if (extra && extra.reply_markup) f.append('reply_markup', JSON.stringify(extra.reply_markup));
      f.append('photo', d.blob, 'photo.jpg');
      return tgForm(env, 'sendPhoto', f);
    }
    return d.photo
      ? tg(env, 'sendPhoto', Object.assign({ chat_id: chat, photo: d.photo, caption: post.text, caption_entities: ents }, extra || {}))
      : tg(env, 'sendMessage', Object.assign({ chat_id: chat, text: post.text, entities: ents, link_preview_options: { is_disabled: true } }, extra || {}));
  };
  let r = await go(post.entities);
  let downgraded = false;
  if (!r.ok && hasCustom(post.entities)) {
    r = await go(stripCustom(post.entities));
    downgraded = r.ok;
  }
  r.downgraded = downgraded;
  return r;
}
async function appLink(env, id) {
  const bot = await me(env);
  const base = env.APP_LINK || ('https://t.me/' + bot.username);
  return env.APP_LINK ? base + (base.includes('?') ? '&' : '?') + 'startapp=' + id : base + '?start=g_' + id;
}
async function publish(env, uid, d) {
  const id = rid(5), seed = rid(16), commit = await sha256(seed);
  d.ends_at = d.ends_abs || (d.hours ? Date.now() + d.hours * 3600 * 1000 : 0);
  const post = buildPost(env, d);
  const markup = kb([[{ text: d.button || 'Участвовать', url: await appLink(env, id) }]]);
  const r = await sendPost(env, d.chat_id, d, post, { reply_markup: markup });
  if (!r.ok) return { err: r.description || 'не удалось опубликовать' };
  if (d.blob && r.result && r.result.photo && r.result.photo.length) d.photo = r.result.photo[r.result.photo.length - 1].file_id;
  await env.DB.prepare('INSERT INTO giveaways(id, owner_id, text, entities, photo, button, chat_id, chat_title, chat_username, message_id, winners, ends_at, status, seed, commit_hash, boosts, captcha, created_at, conds, title, prize, max_p) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, uid, d.text, JSON.stringify(d.entities || []), d.photo || null, d.button || 'Участвовать', d.chat_id, d.chat_title, d.chat_username || null, r.result.message_id, d.winners, d.ends_at, 'open', seed, commit, d.boosts === false ? 0 : 1, d.captcha ? 1 : 0, Date.now(), JSON.stringify(d.conds || []), d.title || null, d.prize || null, d.max_p || null).run();
  return { id, message_id: r.result.message_id, downgraded: r.downgraded, commit };
}

/* ---------- bot handlers: only the welcome message and join buttons ---------- */
async function onMessage(env, msg) {
  if (msg.chat.type !== 'private') return;
  const uid = msg.from.id, text = (msg.text || '').trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    if (payload.startsWith('g_') && env.WEBAPP_URL) {
      const u = env.WEBAPP_URL + (env.WEBAPP_URL.includes('?') ? '&' : '?') + 'g=' + payload.slice(2);
      return say(env, msg.chat.id, 'Нажми кнопку, чтобы участвовать в розыгрыше.', { reply_markup: kb([[{ text: 'Открыть розыгрыш', web_app: { url: u } }]]) });
    }
    if (payload.startsWith('c_')) {
      const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(payload.slice(2)).first();
      if (!g || g.status !== 'open') return say(env, msg.chat.id, 'Этот розыгрыш уже завершён.');
      return sendCaptcha(env, msg.chat.id, uid, g.id);
    }
  }
  return welcome(env, msg.chat.id);
}

async function onCallback(env, q) {
  const data = q.data || '', uid = q.from.id, chat = q.message ? q.message.chat.id : uid;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: !!alert });
  if (data === 'noop') return ack();
  if (data.startsWith('j:')) {
    const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(data.slice(2)).first();
    if (!g) return ack('Розыгрыш не найден.', true);
    if (g.status !== 'open') return ack('Розыгрыш уже завершён.', true);
    if (g.captcha) {
      const ex = await env.DB.prepare('SELECT 1 AS x FROM participants WHERE gid=? AND user_id=?').bind(g.id, uid).first();
      if (ex) return ack('Ты уже участвуешь.', true);
      const bot = await me(env);
      return tg(env, 'answerCallbackQuery', { callback_query_id: q.id, url: 'https://t.me/' + bot.username + '?start=c_' + g.id });
    }
    const r = await tryJoin(env, g, q.from);
    return ack(r.msg, true);
  }
  if (data.startsWith('cp:')) {
    const s = await getS(env, uid);
    if (!s || s.step !== 'captcha') return ack();
    if (data.slice(3) !== s.data.target) { await ack('Не то, попробуй ещё.'); return sendCaptcha(env, chat, uid, s.data.gid); }
    const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(s.data.gid).first();
    await clearS(env, uid); await ack();
    const r = await tryJoin(env, g, q.from);
    const rows = g.chat_username ? [[{ text: 'Вернуться в канал', url: 'https://t.me/' + g.chat_username }]] : [];
    return say(env, chat, r.msg, rows.length ? { reply_markup: kb(rows) } : {});
  }
  return ack();
}

/* ---------- API for the mini-app ---------- */
function cors(env) {
  let origin = '*'; try { if (env.WEBAPP_URL) origin = new URL(env.WEBAPP_URL).origin; } catch (e) {}
  return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type,x-init-data', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '86400' };
}
const jr = (env, obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, cors(env)) });
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const toHex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
async function authUser(env, req) {
  const p = new URLSearchParams(req.headers.get('x-init-data') || '');
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), env.BOT_TOKEN);
  if (toHex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400 * 2) return null;
  try { const u = JSON.parse(p.get('user')); return u && u.id ? u : null; } catch (e) { return null; }
}
function gView(g, uid, n, joined) {
  let conds = []; try { conds = JSON.parse(g.conds || '[]'); } catch (e) {}
  const o = {
    id: g.id, title: g.title || String(g.text || '').split('\n')[0].slice(0, 80), prize: g.prize || '',
    channel: g.chat_username ? '@' + g.chat_username : g.chat_title, captcha: !!g.captcha, boosts: !!g.boosts,
    status: g.status, mine: g.owner_id === uid, conds: conds.map(c => c.username ? '@' + c.username : c.title),
    commit: g.commit_hash, maxP: g.max_p || 0, n: n || 0, joined: !!joined, winners: g.winners, ends_at: g.ends_at || 0,
    link: g.chat_username && g.message_id ? 'https://t.me/' + g.chat_username + '/' + g.message_id : null,
    boostLink: g.chat_username ? 'https://t.me/boost/' + g.chat_username : null,
  };
  if (g.status === 'done' && g.result) { try { const ws = JSON.parse(g.result); o.result = { winners: ws, seed: g.seed, hash: ws[0] ? ws[0].hash : null }; } catch (e) {} }
  return o;
}
async function gViews(env, rows, uid) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id), ph = ids.map(() => '?').join(',');
  const cnt = {};
  (await env.DB.prepare('SELECT gid, COUNT(*) AS n FROM participants WHERE gid IN (' + ph + ') GROUP BY gid').bind(...ids).all()).results.forEach(r => { cnt[r.gid] = r.n; });
  const mine = new Set((await env.DB.prepare('SELECT gid FROM participants WHERE user_id=? AND gid IN (' + ph + ')').bind(uid, ...ids).all()).results.map(r => r.gid));
  return rows.map(g => gView(g, uid, cnt[g.id], mine.has(g.id)));
}
async function gDetail(env, g, uid) {
  const [v] = await gViews(env, [g], uid);
  const ps = (await env.DB.prepare('SELECT user_id, name, w FROM participants WHERE gid=? LIMIT 3000').bind(g.id).all()).results;
  v.p = ps.map(x => ({ id: String(x.user_id), name: x.name, w: x.w || 1 }));
  return v;
}
const clampInt = (v, a, b, d) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(a, Math.min(b, v)); };
const chList = async (env, uid) => (await listChannels(env, uid)).map(c => ({ id: c.chat_id, title: c.title, username: c.username }));

async function api(env, req, url) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  const user = await authUser(env, req);
  if (!user) return jr(env, { ok: false, error: 'Открой приложение через Telegram.' }, 401);
  const uid = user.id, path = url.pathname.replace(/^\/api\//, '');
  let body = {}; if (req.method === 'POST') { try { body = await req.json(); } catch (e) {} }
  const fail = (error, status) => jr(env, { ok: false, error }, status || 400);

  if (path === 'state') {
    const a = (await env.DB.prepare("SELECT * FROM giveaways WHERE status='open' OR owner_id=? ORDER BY created_at DESC LIMIT 60").bind(uid).all()).results;
    const b = (await env.DB.prepare("SELECT * FROM giveaways WHERE status='done' AND owner_id<>? ORDER BY created_at DESC LIMIT 30").bind(uid).all()).results;
    return jr(env, { ok: true, me: { id: String(uid) }, channels: await chList(env, uid), giveaways: await gViews(env, a.concat(b), uid) });
  }
  if (path === 'channels' && req.method === 'POST') {
    const ref = parseRef(body.ref); if (!ref) return fail('Введи @username канала.');
    const r = await verifyChannel(env, ref, uid); if (r.err) return fail(r.err);
    await addChannel(env, uid, r.chat);
    return jr(env, { ok: true, channels: await chList(env, uid), added: r.chat.id });
  }
  if (path === 'channels/delete' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM channels WHERE owner_id=? AND chat_id=?').bind(uid, Number(body.id)).run();
    return jr(env, { ok: true, channels: await chList(env, uid) });
  }
  if (path === 'giveaways' && req.method === 'POST') {
    const raw = String(body.text || '').slice(0, 5000);
    const blob = body.photo ? dataUrlToBlob(body.photo) : null;
    if (body.photo && !blob) return fail('Фото не подошло. Выбери JPG или PNG.');
    if (blob && blob.size > 8 * 1024 * 1024) return fail('Фото слишком большое.');
    const parsed = parseMarkup(raw);
    if (!parsed.text.trim() && !blob) return fail('Напиши текст поста или добавь фото.');
    if (parsed.text.length > (blob ? 1000 : 4000)) return fail('Текст слишком длинный: до ' + (blob ? 1000 : 4000) + ' символов' + (blob ? ' (с фото)' : '') + '.');
    if (!body.chat_id) return fail('Выбери канал для публикации.');
    let endsAbs = 0;
    if (body.ends_at) {
      endsAbs = Number(body.ends_at);
      if (!(endsAbs > Date.now() + 60000 && endsAbs < Date.now() + 90 * 86400000)) return fail('Время окончания должно быть в будущем, не дальше 90 дней.');
    }
    const maxP = body.max_p ? clampInt(body.max_p, 1, 1000000, 0) : 0;
    const button = String(body.button || 'Участвовать').trim().slice(0, 40) || 'Участвовать';
    const main = await verifyChannel(env, Number(body.chat_id), uid); if (main.err) return fail(main.err);
    const conds = [];
    for (const id of (Array.isArray(body.conds) ? body.conds : []).slice(0, 5)) {
      if (Number(id) === main.chat.id) continue;
      const c = await verifyChannel(env, Number(id), uid); if (c.err) return fail(c.err);
      conds.push({ id: c.chat.id, title: c.chat.title, username: c.chat.username || null });
    }
    const d = {
      text: parsed.text, entities: parsed.entities, photo: null, blob, button,
      chat_id: main.chat.id, chat_title: main.chat.title, chat_username: main.chat.username || null,
      winners: clampInt(body.winners, 1, 100, 1), hours: body.hours ? clampInt(body.hours, 1, 24 * 60, 0) : 0,
      ends_abs: endsAbs, max_p: maxP,
      captcha: !!body.captcha, boosts: body.boosts !== false, conds,
      title: parsed.text.trim().split('\n')[0].slice(0, 80) || 'Розыгрыш',
    };
    const r = await publish(env, uid, d);
    if (r.err) return fail('Не получилось опубликовать: ' + r.err);
    return jr(env, { ok: true, id: r.id, commit: r.commit, downgraded: r.downgraded });
  }
  const m = path.match(/^giveaways\/([0-9a-f]+)(?:\/(join|boost|finish))?$/);
  if (m) {
    const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(m[1]).first();
    if (!g) return fail('Розыгрыш не найден.', 404);
    const act = m[2];
    if (!act) return jr(env, { ok: true, g: await gDetail(env, g, uid) });
    if (act === 'join') {
      const r = await tryJoin(env, g, user);
      const g2 = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(g.id).first();
      return jr(env, { ok: r.ok, already: !!r.already, missing: r.missing || null, ticket: r.ticket || null, w: r.w || null, msg: r.msg, g: await gDetail(env, g2, uid) });
    }
    if (act === 'boost') {
      let msg;
      const ex = await env.DB.prepare('SELECT w FROM participants WHERE gid=? AND user_id=?').bind(g.id, uid).first();
      if (g.status !== 'open') msg = 'Розыгрыш уже завершён.';
      else if (!g.boosts) msg = 'В этом розыгрыше бусты выключены.';
      else if (!ex) msg = 'Сначала нажми «Участвовать».';
      else {
        const b = await tg(env, 'getUserChatBoosts', { chat_id: g.chat_id, user_id: uid });
        if (b.ok && b.result.boosts && b.result.boosts.length) { await env.DB.prepare('UPDATE participants SET w=2 WHERE gid=? AND user_id=?').bind(g.id, uid).run(); msg = 'Буст засчитан, шанс ×2.'; }
        else msg = 'Буст канала не найден. Забусти канал и нажми снова.';
      }
      return jr(env, { ok: msg.startsWith('Буст засчитан'), msg, g: await gDetail(env, await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(g.id).first(), uid) });
    }
    if (act === 'finish') {
      if (g.owner_id !== uid) return fail('Завершить может только организатор.', 403);
      if (g.status !== 'open') return fail('Розыгрыш уже завершён.');
      await finish(env, g.id);
      const g2 = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(g.id).first();
      return jr(env, { ok: true, g: await gDetail(env, g2, uid) });
    }
  }
  return fail('Не найдено', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { await ensureSchema(env); return await api(env, req, url); }
      catch (e) { console.log('api error', e && e.stack || e); return jr(env, { ok: false, error: 'Ошибка сервера' }, 500); }
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
      let u; try { u = await req.json(); } catch (e) { return new Response('ok'); }
      try {
        await ensureSchema(env);
        if (u.message) await onMessage(env, u.message);
        else if (u.callback_query) await onCallback(env, u.callback_query);
      } catch (e) { console.log('error', e && e.stack || e); }
      return new Response('ok');
    }
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      await ensureSchema(env);
      const out = {};
      out.webhook = await tg(env, 'setWebhook', { url: url.origin + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      out.commands = await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Главное меню' }, { command: 'cancel', description: 'Отменить создание' }] });
      if (env.WEBAPP_URL) out.menu = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Розыгрыши', web_app: { url: env.WEBAPP_URL } } });
      return new Response(JSON.stringify(out, null, 1), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Рандомайзер: работает');
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(finishDue(env)); },
};
