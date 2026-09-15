import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ОШИБКА: Не задан BOT_TOKEN');
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// ====================== ФАЙЛЫ СОСТОЯНИЯ ======================
const DATA_DIR = process.env.DATA_DIR || '/app/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const HTML_DUMP = path.join(DATA_DIR, 'last.html');
const PROXY_STATE_FILE = path.join(DATA_DIR, 'proxy.json');

// ====================== LTEBOOST API (для /proxyinfo) ======================
const LTE_API_BASE = 'https://gb.lteboost.com/api/client/v1';
const LTE_API_KEY = process.env.LTE_API_KEY || '';

// ====================== ПРОКСИ ======================
// Формат пароля: BASEKEY_country-RU_city-chelyabinsk_lifetime-5_session-XXXX
const DEFAULT_PROXY_PASS =
  'KbuTHCUaYBbDykhx2j4d_country-RU_city-chelyabinsk_lifetime-5_session-y3rvpjcb';

let CURRENT_PROXY = {
  server: process.env.PROXY_SERVER || 'http://mob.lteboost.com:3000',
  username: process.env.PROXY_USER || 'user_2ce64754',
  password: process.env.PROXY_PASS || DEFAULT_PROXY_PASS,
};

// Загружаем сохранённый пароль (если менялся через /changeip)
try {
  if (fs.existsSync(PROXY_STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PROXY_STATE_FILE, 'utf8'));
    if (saved.password) CURRENT_PROXY.password = saved.password;
    if (saved.server) CURRENT_PROXY.server = saved.server;
    if (saved.username) CURRENT_PROXY.username = saved.username;
    console.log('[Proxy] Загружен пароль из файла');
  }
} catch (e) {
  console.warn('[Proxy] Не удалось загрузить пароль:', e.message);
}

let lastIpChange = 0;

function buildProxyUrl(proxy) {
  if (!proxy.username || !proxy.password) return proxy.server;
  const u = new URL(proxy.server);
  u.username = proxy.username;
  u.password = proxy.password;
  return u.toString();
}

// ─── Генератор session ID ───────────────────────────────────────────────────
function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── Сборка sticky-пароля ───────────────────────────────────────────────────
function buildStickyPassword(baseKey, sessionId) {
  return `${baseKey}_country-RU_city-chelyabinsk_lifetime-5_session-${sessionId}`;
}

// ─── Извлечение текущего session ID ─────────────────────────────────────────
function extractSessionId(password) {
  const m = password.match(/_session-([a-z0-9]+)/i);
  return m ? m[1] : '?';
}

// ─── Извлечение базового ключа ──────────────────────────────────────────────
function extractBaseKey(password) {
  return password.split('_')[0];
}

// ─── Смена IP через новый session ID ────────────────────────────────────────
async function changeProxyIP(ctx = null) {
  const now = Date.now();
  if (now - lastIpChange < 30000) {
    if (ctx) await ctx.reply('⏳ IP недавно менялся, подождите 30 сек...');
    return false;
  }

  const baseKey = extractBaseKey(CURRENT_PROXY.password);
  const newSession = generateSessionId();
  const newPass = buildStickyPassword(baseKey, newSession);

  CURRENT_PROXY.password = newPass;

  try {
    fs.writeFileSync(PROXY_STATE_FILE, JSON.stringify(CURRENT_PROXY), 'utf8');
    console.log('[Rotate] Новая сессия:', newSession);
  } catch (e) {
    console.warn('[Rotate] Ошибка сохранения:', e.message);
  }

  lastIpChange = Date.now();

  if (ctx) {
    await ctx.reply(
      `🔄 Новая sticky-сессия: \`${newSession}\`\n` +
      `Через 5 секунд IP обновится.\n` +
      `Пароль: \`${newPass}\``,
      { parse_mode: 'Markdown' }
    );
  }
  await sleep(5000);
  return true;
}

// ====================== СОСТОЯНИЕ ======================
let currentQuery = '';
let isRunning = false;

const DEFAULT_STOP_DOMAINS = ['sos74.ru', 'xn--74-dlcmol6bgl3g.xn--p1ai'];
let stopDomains = new Set(DEFAULT_STOP_DOMAINS);

const DEFAULT_QUERIES = [
  'вскрытие замка Челябинск',
  'вскрытие двери Челябинск',
  'аварийное вскрытие замков',
  'вызвать мастера по замкам',
  'вскрытие замка круглосуточно',
  'вскрытие замка ночью',
  'ребенок закрылся дома Челябинск',
  'ребенок один в квартире закрыт',
  'захлопнулась дверь с ребенком',
  'сломался замок в двери',
  'заклинило замок',
  'потерял ключи от квартиры',
  'захлопнулась дверь без ключей',
  'сломался ключ в замке',
  'не открывается замок входной двери',
  'вскрытие замка квартиры',
  'вскрытие замка машины Челябинск',
  'вскрытие гаража Челябинск',
  'вскрытие сейфа Челябинск',
  'вскрытие офиса Челябинск',
  'вскрытие замка цена Челябинск',
  'вскрытие замка недорого',
  'вскрытие замка без повреждений',
];

function normalizeDomain(hostname) {
  let d = hostname.toLowerCase().replace(/^www\./, '');
  try { d = new URL(`http://${d}`).hostname; } catch {}
  return d;
}

function isStopped(hostname, stopSet) {
  const d = normalizeDomain(hostname);
  if (stopSet.has(d)) return true;
  for (const stop of stopSet) {
    if (d === stop || d.endsWith('.' + stop)) return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================== АВТОПРОГОН ======================
const AUTO_INTERVAL_HOURS = parseFloat(process.env.AUTO_INTERVAL_HOURS || '2');
const AUTO_ENABLED_DEFAULT = String(process.env.AUTO_ENABLED || 'false').toLowerCase() === 'true';

let autoTimer = null;
let autoEnabled = AUTO_ENABLED_DEFAULT;
let lastAutoRun = null;
let autoRunCount = 0;

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return true;
  return ctx.from?.id === ADMIN_CHAT_ID || ctx.chat?.id === ADMIN_CHAT_ID;
}

function startScheduler() {
  if (autoTimer) clearInterval(autoTimer);
  if (!ADMIN_CHAT_ID) return;
  const intervalMs = AUTO_INTERVAL_HOURS * 60 * 60 * 1000;
  console.log(`[scheduler] Интервал: ${AUTO_INTERVAL_HOURS} ч`);
  autoTimer = setInterval(async () => {
    if (!autoEnabled || isRunning) return;
    const query = DEFAULT_QUERIES[Math.floor(Math.random() * DEFAULT_QUERIES.length)];
    isRunning = true;
    autoRunCount++;
    try {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `⏰ *Автопрогон #${autoRunCount}*\n«${query}»`,
        { parse_mode: 'Markdown' }
      );
      const report = await runSurf(query, stopDomains, {
        reply: (text, opts) => bot.telegram.sendMessage(ADMIN_CHAT_ID, text, opts),
      });
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
      lastAutoRun = new Date();
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}

function stopScheduler() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

// ====================== БОТ ======================
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error('[Telegraf]', err);
  ctx.reply(`⚠️ ${err.message}`).catch(() => {});
});

bot.start((ctx) => {
  ctx.reply(
    `🤖 *Бот серфинга (HTTP-Fast + sticky)*\n\n` +
    `*Основное:*\n` +
    `• Текст = фраза, /run — старт, /stop_run — стоп.\n\n` +
    `*Фразы:* /queries, /setquery N\n\n` +
    `*Стоп-домены:* /stop, /stop_reset\n\n` +
    `*Прокси:*\n` +
    `• /testproxy — проверка\n` +
    `• /changeip — новая sticky-сессия\n` +
    `• /proxyinfo — баланс LTEBOOST\n` +
    `• /dumphtml — что вернул Яндекс\n\n` +
    `*Автопрогон:* /auto_on, /auto_off, /auto_status\n\n` +
    `Прокси: \`${CURRENT_PROXY.server}\`\n` +
    `Session: \`${extractSessionId(CURRENT_PROXY.password)}\`\n` +
    `Фраза: ${currentQuery || '—'}\n` +
    `Стоп-домены: ${[...stopDomains].join(', ')}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Смена IP ───────────────────────────────────────────────────────────────
bot.command('changeip', async (ctx) => { await changeProxyIP(ctx); });

// ─── Информация от LTEBOOST ─────────────────────────────────────────────────
bot.command('proxyinfo', async (ctx) => {
  if (!LTE_API_KEY) return ctx.reply('LTE_API_KEY не задан.');
  try {
    const res = await fetch(`${LTE_API_BASE}/proxies`, {
      headers: { 'Authorization': `Bearer ${LTE_API_KEY}` },
      timeout: 15000,
    });
    const text = await res.text();
    await ctx.reply(`📡 Ответ API:\n\n${text.slice(0, 3500)}`);
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

// ─── Тест прокси ────────────────────────────────────────────────────────────
bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Тестирую прокси...');
  const proxyUrl = buildProxyUrl(CURRENT_PROXY);
  const agent = new HttpsProxyAgent(proxyUrl);

  const tests = [
    { url: 'https://api.ipify.org?format=json', name: 'ipify' },
    { url: 'https://m.yandex.ru/', name: 'm.yandex.ru' },
  ];

  const lines = [
    `Session: \`${extractSessionId(CURRENT_PROXY.password)}\``,
    '',
  ];
  for (const t of tests) {
    const t0 = Date.now();
    try {
      const res = await fetch(t.url, {
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 20000,
      });
      const body = await res.text();
      lines.push(`✅ ${t.name} — ${res.status} (${Date.now() - t0}ms), длина ${body.length}`);
      if (t.name === 'ipify') {
        lines.push(`   IP: ${body}`);
      }
    } catch (err) {
      lines.push(`❌ ${t.name} — ${err.message.slice(0, 80)}`);
    }
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ─── Диагностика HTML ───────────────────────────────────────────────────────
bot.command('dumphtml', async (ctx) => {
  if (!fs.existsSync(HTML_DUMP)) {
    return ctx.reply('❌ Файл пуст. Сначала сделай /run.');
  }
  const html = fs.readFileSync(HTML_DUMP, 'utf8');
  const maxLen = 3500;
  await ctx.reply(`📄 HTML (первые ${maxLen} из ${html.length}):\n\n${html.slice(0, maxLen)}`);
});

// ─── Фразы ──────────────────────────────────────────────────────────────────
bot.command('queries', (ctx) => {
  ctx.reply(DEFAULT_QUERIES.map((q, i) => `${i + 1}. ${q}`).join('\n'));
});

bot.command('setquery', (ctx) => {
  const n = parseInt(ctx.message.text.replace('/setquery', '').trim(), 10);
  if (!n || n < 1 || n > DEFAULT_QUERIES.length) return ctx.reply(`1–${DEFAULT_QUERIES.length}`);
  currentQuery = DEFAULT_QUERIES[n - 1];
  ctx.reply(`✅ «${currentQuery}»`);
});

// ─── Стоп-домены ────────────────────────────────────────────────────────────
bot.command('stop', (ctx) => {
  const text = ctx.message.text.replace('/stop', '').trim();
  if (!text) return ctx.reply(`Стоп-домены:\n${[...stopDomains].join('\n')}`);
  const added = text.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  added.forEach((d) => stopDomains.add(normalizeDomain(d)));
  ctx.reply(`✅ Всего: ${stopDomains.size}`);
});

bot.command('stop_reset', (ctx) => {
  stopDomains = new Set(DEFAULT_STOP_DOMAINS);
  ctx.reply('♻️ Сброшено.');
});

// ─── Запуск ─────────────────────────────────────────────────────────────────
bot.command('run', async (ctx) => {
  if (isRunning) return ctx.reply('⚠️ Уже выполняется');
  if (!currentQuery) return ctx.reply('❌ Фраза не задана');
  isRunning = true;
  await ctx.reply(`🚀 Запуск: «${currentQuery}»`);
  try {
    const report = await runSurf(currentQuery, stopDomains, ctx);
    await ctx.reply(report, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  } finally {
    isRunning = false;
  }
});

bot.command('stop_run', (ctx) => {
  isRunning = false;
  ctx.reply('🛑 Остановлено');
});

// ─── Автопрогон ─────────────────────────────────────────────────────────────
bot.command('auto_on', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  autoEnabled = true;
  startScheduler();
  await ctx.reply(`✅ Автопрогон включён (каждые ${AUTO_INTERVAL_HOURS} ч)`);
});

bot.command('auto_off', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  autoEnabled = false;
  stopScheduler();
  await ctx.reply('⏹ Автопрогон выключен');
});

bot.command('auto_status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  await ctx.reply(
    `Статус: ${autoEnabled ? '🟢 Включён' : '🔴 Выключен'}\n` +
    `Интервал: ${AUTO_INTERVAL_HOURS} ч\n` +
    `Запусков: ${autoRunCount}\n` +
    `Последний: ${lastAutoRun ? lastAutoRun.toLocaleString('ru-RU') : '—'}`
  );
});

// ====================== ОСНОВНАЯ ЛОГИКА ======================
async function runSurf(query, stopSet, ctx) {
  const visited = [];
  const actions = [];

  let results = [];
  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      results = await searchYandexHttp(query, CURRENT_PROXY, ctx);
      break;
    } catch (err) {
      lastError = err.message;
      console.log(`[Search] Попытка ${attempt}: ${err.message}`);
      if (ctx?.reply) await ctx.reply(`🛑 Ошибка (попытка ${attempt}/3): ${err.message}`);

      if (attempt < 3) {
        if (ctx?.reply) await ctx.reply('🔄 Меняю sticky-сессию...');
        await changeProxyIP(ctx);
      }
      await sleep(7000);
    }
  }

  if (!results.length) {
    return `⚠️ Не удалось получить выдачу.\nОшибка: ${lastError}\n\nПосмотри /dumphtml.`;
  }

  await ctx.reply(`📋 Найдено: ${results.length} сайтов. Выполняю визиты...`);

  const proxyUrl = buildProxyUrl(CURRENT_PROXY);
  const agent = new HttpsProxyAgent(proxyUrl);

  for (const item of results) {
    if (!isRunning) break;
    let domain;
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }

    if (isStopped(domain, stopSet)) {
      actions.push(`⏭️ *${domain}* — стоп`);
      continue;
    }

    try {
      await fetch(item.url, {
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 15000,
        redirect: 'follow',
      }).catch(() => {});
      visited.push(domain);
      actions.push(`✅ *${domain}* — просмотр`);
    } catch (err) {
      actions.push(`⚠️ *${domain}* — сбой`);
    }
    await sleep(3000 + Math.random() * 2000);
  }

  return [
    `📊 *Отчёт*`,
    `Фраза: «${query}»`,
    `Session: \`${extractSessionId(CURRENT_PROXY.password)}\``,
    `Посещено: ${visited.length}`,
    ``,
    ...actions,
  ].join('\n');
}

// ====================== ПОИСК ЯНДЕКСА ======================
async function searchYandexHttp(query, proxy, ctx) {
  const proxyUrl = buildProxyUrl(proxy);
  const agent = new HttpsProxyAgent(proxyUrl);

  const mobileUAs = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ];
  const ua = mobileUAs[Math.floor(Math.random() * mobileUAs.length)];

  const baseHeaders = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
  };

  // Прогрев главной — получаем cookies
  let cookies = '';
  try {
    const homeRes = await fetch('https://m.yandex.ru/', { agent, headers: baseHeaders, timeout: 15000 });
    const setCookies = homeRes.headers.raw?.()['set-cookie'] || [];
    if (setCookies.length) {
      cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
    }
    await sleep(2000 + Math.random() * 2000);
  } catch (e) {
    console.warn('[Warmup]', e.message);
  }

  const searchHeaders = { ...baseHeaders, 'Referer': 'https://m.yandex.ru/' };
  if (cookies) searchHeaders['Cookie'] = cookies;

  const searchUrl = `https://m.yandex.ru/search/?text=${encodeURIComponent(query)}&lr=74`;
  console.log('[Search] URL:', searchUrl);

  const res = await fetch(searchUrl, {
    agent,
    headers: searchHeaders,
    timeout: 25000,
    redirect: 'follow',
  });

  const html = await res.text();
  console.log(`[Search] Статус ${res.status}, HTML ${html.length} байт`);

  try {
    fs.writeFileSync(HTML_DUMP, html, 'utf8');
  } catch (e) {
    console.warn('[Search] Не удалось сохранить HTML:', e.message);
  }

  // Проверка SmartCaptcha
  const isCaptcha =
    /<title[^>]*>Вы не робот\?<\/title>/i.test(html) ||
    /captcha_smart/i.test(html) ||
    /SmartCaptcha/i.test(html) ||
    /CheckboxCaptcha/i.test(html) ||
    /<form[^>]+action="[^"]*captcha/i.test(html);

  if (isCaptcha) {
    throw new Error('Yandex SmartCaptcha');
  }

  if (html.length < 2000) {
    throw new Error(`HTML слишком короткий (${html.length} байт)`);
  }

  const $ = cheerio.load(html);

  const debugCounts = {
    'a[href^="http"]': $('a[href^="http"]').length,
    'h2': $('h2').length,
    'li.serp-item': $('li.serp-item').length,
  };
  console.log('[Search] Селекторы:', JSON.stringify(debugCounts));

  const items = [];
  const seen = new Set();

  $('a[href^="http"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (/yandex\.|ya\.ru|yastatic|yandexcloud/.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);

    const title = $(el).text().trim() || $(el).find('h2').text().trim() || href;
    if (!title || title.length < 3) return;
    items.push({ url: href, title: title.slice(0, 100) });
  });

  console.log(`[Search] Найдено ссылок: ${items.length}`);

  const unique = items.slice(0, 10);

  if (unique.length === 0) {
    throw new Error(`Пустая выдача. HTML ${html.length} байт.`);
  }

  return unique;
}

// ====================== FALLBACK ======================
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();
  currentQuery = text;
  await ctx.reply(`✅ Фраза: «${currentQuery}»`);
});

// ====================== ЗАПУСК ======================
bot.launch()
  .then(() => {
    console.log('✅ Бот запущен (HTTP-Fast + sticky)');
    console.log(`[Proxy] ${CURRENT_PROXY.server}`);
    console.log(`[Proxy] Session: ${extractSessionId(CURRENT_PROXY.password)}`);
    if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
  })
  .catch((err) => {
    console.error('❌ Ошибка запуска бота:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
