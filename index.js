import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as cheerio from 'cheerio';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ОШИБКА: Не задан BOT_TOKEN');
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;
const PROXY_ROTATE_URL = process.env.PROXY_ROTATE_URL || '';

// ====================== ПРОКСИ ======================
let CURRENT_PROXY = {
  server: process.env.PROXY_SERVER || 'http://mob.lteboost.com:3000',
  username: process.env.PROXY_USER || 'user_2ce64754',
  password: process.env.PROXY_PASS || '9GhUc54U0LRoIUTFq730',
};

let lastIpChange = 0;

function buildProxyUrl(proxy) {
  if (!proxy.username || !proxy.password) return proxy.server;
  const u = new URL(proxy.server);
  u.username = proxy.username;
  u.password = proxy.password;
  return u.toString();
}

async function changeProxyIP(ctx = null) {
  if (!PROXY_ROTATE_URL) {
    if (ctx) await ctx.reply('⚠️ PROXY_ROTATE_URL не задан — смена IP недоступна.');
    return false;
  }
  const now = Date.now();
  if (now - lastIpChange < 60000) {
    if (ctx) await ctx.reply('⏳ IP недавно менялся, подождите минуту...');
    return false;
  }
  try {
    if (ctx) await ctx.reply('🔄 Запрашиваю смену IP...');
    const response = await fetch(PROXY_ROTATE_URL, { timeout: 15000 });
    const text = await response.text();
    console.log('[Proxy] Rotate:', text);
    lastIpChange = Date.now();
    if (ctx) await ctx.reply('✅ Запрос на смену IP отправлен.');
    await sleep(7000);
    return true;
  } catch (err) {
    console.error('[Proxy] Rotate error:', err.message);
    if (ctx) await ctx.reply(`❌ Ошибка смены IP: ${err.message}`);
    return false;
  }
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
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⏰ *Автопрогон #${autoRunCount}*\n«${query}»`, { parse_mode: 'Markdown' });
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
    `🤖 *Бот серфинга (HTTP-Fast Mode)*\n\n` +
    `• /changeip — смена IP\n` +
    `• /testproxy — проверка\n` +
    `• /run — запуск по активной фразе\n` +
    `• /queries — список фраз\n` +
    `• /setquery N — выбрать фразу\n` +
    `• /stop — добавить стоп-домен\n` +
    `• /auto_on / auto_off / auto_status — автопрогон\n\n` +
    `Фраза: ${currentQuery || '—'}\n` +
    `Стоп-домены: ${[...stopDomains].join(', ')}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('changeip', async (ctx) => {
  await changeProxyIP(ctx);
});

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Тестирую прокси...');
  const proxyUrl = buildProxyUrl(CURRENT_PROXY);
  const agent = new HttpsProxyAgent(proxyUrl);

  const tests = [
    { url: 'https://api.ipify.org?format=json', name: 'ipify' },
    { url: 'https://m.yandex.ru/', name: 'm.yandex.ru' },
    { url: 'https://ya.ru/', name: 'ya.ru' },
  ];

  const lines = [];
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
      lines.push(`✅ ${t.name} — ${res.status} (${Date.now() - t0}ms) ${body.slice(0, 60).replace(/\s+/g, ' ')}`);
    } catch (err) {
      lines.push(`❌ ${t.name} — ${err.message.slice(0, 80)}`);
    }
  }
  await ctx.reply(lines.join('\n'));
});

bot.command('queries', (ctx) => {
  ctx.reply(DEFAULT_QUERIES.map((q, i) => `${i + 1}. ${q}`).join('\n'));
});

bot.command('setquery', (ctx) => {
  const n = parseInt(ctx.message.text.replace('/setquery', '').trim(), 10);
  if (!n || n < 1 || n > DEFAULT_QUERIES.length) return ctx.reply(`1–${DEFAULT_QUERIES.length}`);
  currentQuery = DEFAULT_QUERIES[n - 1];
  ctx.reply(`✅ «${currentQuery}»`);
});

bot.command('stop', (ctx) => {
  const text = ctx.message.text.replace('/stop', '').trim();
  if (!text) return ctx.reply(`Стоп-домены:\n${[...stopDomains].join('\n')}`);
  const added = text.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  added.forEach((d) => stopDomains.add(normalizeDomain(d)));
  ctx.reply(`✅ Добавлено. Всего: ${stopDomains.size}`);
});

bot.command('stop_reset', (ctx) => {
  stopDomains = new Set(DEFAULT_STOP_DOMAINS);
  ctx.reply('♻️ Сброшено.');
});

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
      if (ctx?.reply) {
        await ctx.reply(`🛑 Ошибка/Капча (попытка ${attempt}/3). Меняю IP...`);
      }
      await changeProxyIP(ctx);
      await sleep(7000);
    }
  }

  if (!results.length) {
    return `⚠️ Не удалось получить выдачу.\nОшибка: ${lastError}`;
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
      actions.push(`⚠️ *${domain}* — сбой: ${err.message.slice(0, 40)}`);
    }
    await sleep(3000 + Math.random() * 2000);
  }

  return [
    `📊 *Отчёт*`,
    `Фраза: «${query}»`,
    `Регион: Челябинск (lr=74)`,
    `Посещено: ${visited.length}`,
    ``,
    ...actions,
  ].join('\n');
}

// ====================== ПОИСК ЯНДЕКС ======================
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
    'Accept-Encoding': 'identity', // избегаем gzip, чтобы не возиться с распаковкой
    'Cache-Control': 'no-cache',
  };

  // Прогрев главной для получения cookies
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

  const res = await fetch(`https://m.yandex.ru/search/?text=${encodeURIComponent(query)}&lr=74`, {
    agent,
    headers: searchHeaders,
    timeout: 25000,
  });

  const html = await res.text();

  // Более точная проверка капчи
  if (
    /SmartCaptcha/i.test(html) ||
    /<form[^>]+action="[^"]*captcha/i.test(html) ||
    /CheckboxCaptcha/i.test(html) ||
    /"captcha"\s*:\s*\{/.test(html)
  ) {
    throw new Error('Captcha detected');
  }

  const $ = cheerio.load(html);
  const items = [];

  // Селекторы мобильной выдачи Яндекса
  const selectors = [
    'li.serp-item',
    'div.serp-item',
    'article[data-fast-name="organic"]',
    'div[data-fast-name="organic"]',
    '.organic',
  ];

  $(selectors.join(',')).each((_, el) => {
    const a = $(el).find('a[href^="http"]').first();
    const href = a.attr('href');
    if (!href) return;
    if (/yandex\.|ya\.ru|yastatic/.test(href)) return;

    const title = $(el).find('h2, .OrganicTitle, .Title, .organic__title').text().trim() || a.text().trim();
    items.push({ url: href, title: title || href });
  });

  const seen = new Set();
  const unique = items.filter((i) => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);

  if (unique.length === 0) {
    throw new Error('Пустая выдача (возможно, изменились селекторы Яндекса)');
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
    console.log('✅ Бот запущен (HTTP-Fast Mode)');
    if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
  })
  .catch((err) => {
    console.error('❌ Ошибка запуска бота:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
