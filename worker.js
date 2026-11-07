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
];
async function getS(env, uid) {
  const r = await env.DB.prepare('SELECT step, data FROM sessions WHERE user_id=?').bind(uid).first();
  return r ? { step: r.step, data: JSON.parse(r.data || '{}') } : null;
}
const setS = (env, uid, step, data) => env.DB.prepare('INSERT OR REPLACE INTO sessions(user_id, step, data, updated) VALUES(?,?,?,?)').bind(uid, step, JSON.stringify(data || {}), Date.now()).run();
const clearS = (env, uid) => env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid).run();
const count = async (env, gid) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM participants WHERE gid=?').bind(gid).first()).n;

/* ---------- menus ---------- */
async function menu(env, chat) {
  const rows = [[btn('Создать розыгрыш', 'new')], [btn('Мои розыгрыши', 'my')]];
  if (env.WEBAPP_URL) rows.push([{ text: 'Открыть приложение', web_app: { url: env.WEBAPP_URL } }]);
  rows.push([{ text: 'Поддержать автора', url: 'https://t.me/BestRandomize' }]);
  return say(env, chat, '<b>Рандомайзер</b>\nРозыгрыши в твоём канале с честным выбором победителя: результат можно проверить.\n\nНажми «Создать розыгрыш».', { reply_markup: kb(rows) });
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
    text = '<b>Итоги розыгрыша</b>\nУчастников не было, победителя нет.';
  } else {
    const who = ws.map((w, i) => (ws.length > 1 ? (i + 1) + '. ' : '') + (w.name.startsWith('@') ? esc(w.name) : '<a href="tg://user?id=' + w.id + '">' + esc(w.name) + '</a>')).join('\n');
    text = '<b>Итоги розыгрыша</b>\n' + (ws.length > 1 ? 'Победители:\n' : 'Победитель: ') + who + '\n\nУчастников: ' + parts.length +
      '\n\n<b>Проверка честности</b>\nСекретное число: <code>' + g.seed + '</code>\nSHA-256 числа (был в посте): <code>' + g.commit_hash + '</code>\n' +
      'Победитель = SHA-256(число|id:вес,...) по модулю суммы весов, список по возрастанию id. Вес 2 у тех, кто забустил канал.';
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
async function tryJoin(env, g, user) {
  if (g.status !== 'open') return { ok: false, msg: 'Розыгрыш уже завершён.' };
  const m = await tg(env, 'getChatMember', { chat_id: g.chat_id, user_id: user.id });
  const st = m.ok ? m.result.status : null;
  const isMember = st && (SUB_OK.has(st) || (st === 'restricted' && m.result.is_member));
  if (!isMember) return { ok: false, msg: 'Сначала подпишись на «' + g.chat_title + '», потом нажми «Участвовать» ещё раз.' };
  const ex = await env.DB.prepare('SELECT 1 AS x FROM participants WHERE gid=? AND user_id=?').bind(g.id, user.id).first();
  if (ex) return { ok: false, msg: 'Ты уже участвуешь.' };
  let w = 1;
  if (g.boosts) {
    const b = await tg(env, 'getUserChatBoosts', { chat_id: g.chat_id, user_id: user.id });
    if (b.ok && b.result.boosts && b.result.boosts.length) w = 2;
  }
  await env.DB.prepare('INSERT OR IGNORE INTO participants(gid, user_id, name, w, joined_at) VALUES(?,?,?,?,?)').bind(g.id, user.id, nameOf(user), w, Date.now()).run();
  const n = await count(env, g.id);
  if (n <= 50 || n % 5 === 0) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: g.chat_id, message_id: g.message_id, reply_markup: kb([[btn(g.button + ' (' + n + ')', 'j:' + g.id)]]) });
  }
  return { ok: true, w, msg: w > 1 ? 'Ты участвуешь! Буст канала даёт шанс ×2.' : 'Ты участвуешь! Удачи.' };
}
async function sendCaptcha(env, chat, uid, gid) {
  const pool = CAP.slice().sort(() => Math.random() - 0.5).slice(0, 6);
  const target = Math.floor(Math.random() * pool.length);
  await setS(env, uid, 'captcha', { gid, target: pool[target][0] });
  const row = (a, b) => pool.slice(a, b).map((c, i) => btn(c[0], 'cp:' + c[0]));
  return say(env, chat, 'Проверка. Нажми на ' + pool[target][1] + '.', { reply_markup: kb([row(0, 3), row(3, 6)]) });
}

/* ---------- creating a giveaway ---------- */
async function resolveChannel(env, msg) {
  let ref = null;
  const fo = msg.forward_origin;
  if (fo && fo.type === 'channel') ref = fo.chat.id;
  else if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') ref = msg.forward_from_chat.id;
  else if (msg.text) {
    const m = msg.text.trim().match(/^(?:https?:\/\/t\.me\/|@)?([A-Za-z][A-Za-z0-9_]{4,31})$/);
    if (m) ref = '@' + m[1];
  }
  if (!ref) return { err: 'Пришли @username канала или перешли мне любое сообщение из него.' };
  const c = await tg(env, 'getChat', { chat_id: ref });
  if (!c.ok || c.result.type !== 'channel') return { err: 'Не нашёл такой канал. Проверь @username.' };
  const bot = await me(env);
  const bm = await tg(env, 'getChatMember', { chat_id: c.result.id, user_id: bot.id });
  if (!bm.ok || bm.result.status !== 'administrator') return { err: 'Я не админ этого канала. Добавь меня в администраторы (с правом публикации) и пришли канал снова.' };
  if (bm.result.can_post_messages === false) return { err: 'У меня нет права публиковать сообщения. Включи его в правах администратора.' };
  const um = await tg(env, 'getChatMember', { chat_id: c.result.id, user_id: msg.from.id });
  if (!um.ok || !['creator', 'administrator'].includes(um.result.status)) return { err: 'Ты не администратор этого канала.' };
  return { chat: c.result };
}
function buildPost(env, d, id, commit) {
  const ends = d.hours ? fmt(env, d.ends_at || Date.now() + d.hours * 3600 * 1000) : 'решит организатор';
  const head = d.text + '\n\nПобедителей: ' + d.winners + '\nИтоги: ' + ends + (d.hours ? ' (Бишкек)' : '') + '\nПроверка честности, хеш: ';
  const entities = (d.entities || []).concat(commit ? [{ type: 'code', offset: head.length, length: commit.length }] : []);
  return { text: head + (commit || '…'), entities };
}
async function sendContent(env, chat, d, extra) {
  const post = buildPost(env, d, null, null);
  if (d.photo) return tg(env, 'sendPhoto', Object.assign({ chat_id: chat, photo: d.photo, caption: post.text, caption_entities: post.entities }, extra || {}));
  return tg(env, 'sendMessage', Object.assign({ chat_id: chat, text: post.text, entities: post.entities }, extra || {}));
}
async function publish(env, uid, d) {
  const id = rid(5), seed = rid(16), commit = await sha256(seed);
  d.ends_at = d.hours ? Date.now() + d.hours * 3600 * 1000 : 0;
  const post = buildPost(env, d, id, commit);
  const markup = kb([[btn(d.button + ' (0)', 'j:' + id)]]);
  const r = d.photo
    ? await tg(env, 'sendPhoto', { chat_id: d.chat_id, photo: d.photo, caption: post.text, caption_entities: post.entities, reply_markup: markup })
    : await tg(env, 'sendMessage', { chat_id: d.chat_id, text: post.text, entities: post.entities, reply_markup: markup });
  if (!r.ok) return { err: r.description || 'не удалось опубликовать' };
  await env.DB.prepare('INSERT INTO giveaways(id, owner_id, text, entities, photo, button, chat_id, chat_title, chat_username, message_id, winners, ends_at, status, seed, commit_hash, boosts, captcha, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, uid, d.text, JSON.stringify(d.entities || []), d.photo || null, d.button, d.chat_id, d.chat_title, d.chat_username || null, r.result.message_id, d.winners, d.ends_at, 'open', seed, commit, 1, d.captcha ? 1 : 0, Date.now()).run();
  return { id, message_id: r.result.message_id };
}

/* ---------- handlers ---------- */
async function onMessage(env, msg) {
  if (msg.chat.type !== 'private') return;
  const uid = msg.from.id, text = (msg.text || '').trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    if (payload.startsWith('c_')) {
      const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=?').bind(payload.slice(2)).first();
      if (!g || g.status !== 'open') return say(env, msg.chat.id, 'Этот розыгрыш уже завершён.');
      return sendCaptcha(env, msg.chat.id, uid, g.id);
    }
    await clearS(env, uid);
    return menu(env, msg.chat.id);
  }
  if (text === '/cancel') { await clearS(env, uid); return say(env, msg.chat.id, 'Отменено.', { reply_markup: kb([[btn('В меню', 'menu')]]) }); }
  if (text === '/help') return menu(env, msg.chat.id);
  const s = await getS(env, uid);
  if (!s) return menu(env, msg.chat.id);
  const d = s.data;
  if (s.step === 'content') {
    if (msg.photo) { d.photo = msg.photo[msg.photo.length - 1].file_id; d.text = msg.caption || ''; d.entities = msg.caption_entities || []; }
    else if (msg.text) { d.text = msg.text; d.entities = msg.entities || []; d.photo = null; }
    else return say(env, msg.chat.id, 'Пришли текст или фото с подписью.');
    if (!d.text.trim()) return say(env, msg.chat.id, 'Добавь текст: у фото должна быть подпись.');
    if (d.text.length > (d.photo ? 700 : 3500)) return say(env, msg.chat.id, 'Текст слишком длинный (до ' + (d.photo ? 700 : 3500) + ' символов).');
    await setS(env, uid, 'channel', d);
    return say(env, msg.chat.id, 'Отлично. <b>В каком канале опубликовать?</b>\n\nДобавь меня администратором канала (с правом публикации), затем пришли @username канала или перешли мне любое сообщение из него.');
  }
  if (s.step === 'channel') {
    const r = await resolveChannel(env, msg);
    if (r.err) return say(env, msg.chat.id, r.err);
    d.chat_id = r.chat.id; d.chat_title = r.chat.title; d.chat_username = r.chat.username || null;
    await setS(env, uid, 'winners', d);
    return say(env, msg.chat.id, 'Канал: <b>' + esc(r.chat.title) + '</b>. Сколько будет победителей?', { reply_markup: kb([[1, 2, 3, 5, 10].map(n => btn(String(n), 'w:' + n))]) });
  }
  if (s.step === 'ends' && /^\d{1,4}$/.test(text)) {
    d.hours = Math.max(1, Math.min(24 * 60, parseInt(text, 10)));
    return askCaptcha(env, msg.chat.id, uid, d);
  }
  return say(env, msg.chat.id, 'Выбери вариант кнопкой выше или нажми /cancel.');
}
async function askCaptcha(env, chat, uid, d) {
  await setS(env, uid, 'captcha_opt', d);
  return say(env, chat, 'Включить капчу при участии? Участник один раз нажмёт на нужную картинку.', { reply_markup: kb([[btn('Да, с капчей', 'c:1'), btn('Нет', 'c:0')]]) });
}
async function preview(env, chat, uid, d) {
  d.button = d.button || 'Участвовать';
  await setS(env, uid, 'preview', d);
  await sendContent(env, chat, d);
  const ends = d.hours ? 'через ' + d.hours + ' ч' : 'вручную';
  return say(env, chat, 'Так будет выглядеть пост.\nКанал: <b>' + esc(d.chat_title) + '</b>\nПобедителей: ' + d.winners + ', итоги: ' + ends + ', капча: ' + (d.captcha ? 'да' : 'нет') + '.\nУчастие с бустом канала даёт шанс ×2.',
    { reply_markup: kb([[btn('Опубликовать', 'pub')], [btn('Отмена', 'cancel')]]) });
}

async function onCallback(env, q) {
  const data = q.data || '', uid = q.from.id, chat = q.message ? q.message.chat.id : uid;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: !!alert });
  if (data === 'noop') return ack();
  if (data === 'menu') { await ack(); return menu(env, chat); }
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
  await ack();
  if (data === 'new') { await setS(env, uid, 'content', {}); return say(env, chat, '<b>Новый розыгрыш.</b>\nОтправь мне текст розыгрыша. Можно с фото: отправь фото с подписью. Форматирование сохранится.'); }
  if (data === 'cancel') { await clearS(env, uid); return say(env, chat, 'Отменено.', { reply_markup: kb([[btn('В меню', 'menu')]]) }); }
  if (data.startsWith('w:')) {
    const s = await getS(env, uid); if (!s || s.step !== 'winners') return;
    s.data.winners = parseInt(data.slice(2), 10); await setS(env, uid, 'ends', s.data);
    return say(env, chat, 'Когда подвести итоги? Выбери кнопкой или напиши число часов.', { reply_markup: kb([[btn('1 час', 'e:1'), btn('24 часа', 'e:24')], [btn('3 дня', 'e:72'), btn('7 дней', 'e:168')], [btn('Вручную', 'e:0')]]) });
  }
  if (data.startsWith('e:')) {
    const s = await getS(env, uid); if (!s || s.step !== 'ends') return;
    s.data.hours = parseInt(data.slice(2), 10);
    return askCaptcha(env, chat, uid, s.data);
  }
  if (data.startsWith('c:')) {
    const s = await getS(env, uid); if (!s || s.step !== 'captcha_opt') return;
    s.data.captcha = data === 'c:1';
    return preview(env, chat, uid, s.data);
  }
  if (data === 'pub') {
    const s = await getS(env, uid); if (!s || s.step !== 'preview') return;
    const r = await publish(env, uid, s.data);
    if (r.err) return say(env, chat, 'Не получилось опубликовать: ' + esc(r.err) + '\nПроверь, что я админ канала с правом публикации.');
    await clearS(env, uid);
    return say(env, chat, 'Готово, розыгрыш опубликован в канале.', { reply_markup: kb([[btn('Мои розыгрыши', 'my')]]) });
  }
  if (data === 'my') {
    const rows = (await env.DB.prepare('SELECT id, chat_title, status, text FROM giveaways WHERE owner_id=? ORDER BY created_at DESC LIMIT 10').bind(uid).all()).results;
    if (!rows.length) return say(env, chat, 'У тебя пока нет розыгрышей.', { reply_markup: kb([[btn('Создать розыгрыш', 'new')]]) });
    return say(env, chat, '<b>Твои розыгрыши</b>', { reply_markup: kb(rows.map(g => [btn((g.status === 'open' ? '● ' : '✓ ') + g.chat_title + ': ' + g.text.slice(0, 22), 'v:' + g.id)])) });
  }
  if (data.startsWith('v:') || data.startsWith('f:')) {
    const g = await env.DB.prepare('SELECT * FROM giveaways WHERE id=? AND owner_id=?').bind(data.slice(2), uid).first();
    if (!g) return;
    if (data[0] === 'f') { await finish(env, g.id); return; }
    const n = await count(env, g.id);
    return say(env, chat, '<b>' + esc(g.chat_title) + '</b>\nСтатус: ' + (g.status === 'open' ? 'идёт' : 'завершён') + '\nУчастников: ' + n + '\nПобедителей: ' + g.winners +
      (g.ends_at ? '\nИтоги: ' + fmt(env, g.ends_at) : '\nИтоги: вручную'), { reply_markup: kb(g.status === 'open' ? [[btn('Завершить сейчас', 'f:' + g.id)], [btn('Назад', 'my')]] : [[btn('Назад', 'my')]]) });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
      let u; try { u = await req.json(); } catch (e) { return new Response('ok'); }
      try {
        if (u.message) await onMessage(env, u.message);
        else if (u.callback_query) await onCallback(env, u.callback_query);
      } catch (e) { console.log('error', e && e.stack || e); }
      return new Response('ok');
    }
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
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
