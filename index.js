import { Telegraf } from 'telegraf';
import { chromium, devices } from 'playwright';
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
if (ADMIN_CHAT_ID) {
  console.log(`[init] ADMIN_CHAT_ID: ${ADMIN_CHAT_ID}`);
} else {
  console.warn('[init] ADMIN_CHAT_ID не задан');
}

const PROXY_ROTATE_URL = process.env.PROXY_ROTATE_URL || 'https://api.lteboost.com/rotate?key=ltb_ssjgP4Ie9hTF2Ow1UO_bua_xryrF7Zrorf1WpfDH0Eg';

function parseProxyList() {
  const list = [];
  if (process.env.PROXY_LIST) {
    const lines = process.env.PROXY_LIST.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(':').map((s) => s.trim());
      if (parts.length >= 4) {
        list.push({
          server: `http://${parts[0]}:${parts[1]}`,
          username: parts[2],
          password: parts.slice(3).join(':'),
        });
      } else if (parts.length === 2) {
        list.push({
          server: `http://${parts[0]}:${parts[1]}`,
          username: undefined,
          password: undefined,
        });
      }
    }
  }

  if (!list.length) {
    // ← СЮДА ВСТАВЬ НОВЫЕ ДАННЫЕ, ЕСЛИ ЕСТЬ
    list.push({
      server: 'http://mob.lteboost.com:3000',
      username: 'user_2ce64754',
      password: 'PgcXBZWUW8Sf49PgSD10_country-RU_city-chelyabinsk_lifetime-5_session-ye6t0g7h',
    });
  }
  return list;
}

const PROXIES = parseProxyList();
console.log(`[init] Прокси: ${PROXIES.length}`);

function randomProxy(exclude = null) {
  if (!PROXIES.length) return null;
  const available = PROXIES.filter((p) => p.server !== exclude);
  const pool = available.length ? available : PROXIES;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function changeProxyIP(ctx = null) {
  try {
    const response = await fetch(PROXY_ROTATE_URL);
    const text = await response.text();
    console.log('[Proxy] Rotate:', text);
    if (ctx) await ctx.reply('🔄 Запросил смену IP...');
    await sleep(7000);
  } catch (err) {
    console.error('[Proxy] Ошибка rotate:', err.message);
    if (ctx) await ctx.reply(`❌ Ошибка смены IP: ${err.message}`);
  }
}

let currentQuery = '';
let isRunning = false;

const DEFAULT_STOP_DOMAINS = [
  'sos74.ru',
  'xn--74-dlcmol6bgl3g.xn--p1ai',
];
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
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[Telegraf]`, err);
  ctx.reply(`⚠️ ${err.message}`).catch(() => {});
});

bot.start((ctx) => {
  ctx.reply(
    `🤖 *Бот серфинга (умный fallback)*\n\n` +
    `• Текст = фраза\n` +
    `• /run — запуск\n` +
    `• /testproxy — проверка прокси\n` +
    `• /changeip — смена IP\n` +
    `• Фраза: ${currentQuery || '—'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('changeip', async (ctx) => {
  await changeProxyIP(ctx);
});

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Тестирую прокси двумя способами...');

  const proxy = PROXIES[0];
  if (!proxy) return ctx.reply('❌ Прокси не заданы');

  // === 1. Тест через node-fetch ===
  let fetchOk = false;
  try {
    let proxyUrl = proxy.server;
    if (proxy.username && proxy.password) {
      const u = new URL(proxy.server);
      u.username = proxy.username;
      u.password = proxy.password;
      proxyUrl = u.toString();
    }
    const agent = new HttpsProxyAgent(proxyUrl);
    const res = await fetch('https://m.yandex.ru/', {
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      },
      timeout: 20000,
    });
    fetchOk = res.status > 0;
    await ctx.reply(`✅ node-fetch: работает (статус ${res.status})`);
  } catch (err) {
    await ctx.reply(`❌ node-fetch: ${err.message.slice(0, 80)}`);
  }

  // === 2. Тест через Playwright ===
  let pwOk = false;
  let session;
  try {
    session = await launchSession(proxy);
    await session.page.goto('https://m.yandex.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    pwOk = true;
    await ctx.reply('✅ Playwright: работает');
  } catch (err) {
    await ctx.reply(`❌ Playwright: ${err.message.slice(0, 90)}`);
  } finally {
    if (session?.browser) await session.browser.close().catch(() => {});
  }

  if (fetchOk) {
    await ctx.reply('👍 Будет использоваться fallback через node-fetch (это нормально)');
  } else if (!fetchOk && !pwOk) {
    await ctx.reply('🚫 Оба способа не работают. Нужна новая сессия прокси.');
  }
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
  if (!ADMIN_CHAT_ID) return ctx.reply('❌ Нет ADMIN_CHAT_ID');
  autoEnabled = true;
  startScheduler();
  await ctx.reply('✅ Автопрогон включён');
});

bot.command('auto_off', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  autoEnabled = false;
  stopScheduler();
  await ctx.reply('⏹ Автопрогон выключен');
});

bot.command('auto_status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  const status = autoEnabled ? '🟢 Включён' : '🔴 Выключен';
  await ctx.reply(`Статус: ${status}\nЗапусков: ${autoRunCount}`);
});

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();
  currentQuery = text;
  await ctx.reply(`✅ Фраза: «${currentQuery}»`);
});

async function runSurf(query, stopSet, ctx) {
  const visited = [];
  const actions = [];
  let searchProxy = randomProxy();

  let results = [];
  let usedMethod = '';

  // ===== УМНЫЙ ПОИСК С FALLBACK =====
  try {
    // Сначала пробуем Playwright
    results = await searchYandexPlaywright(query, searchProxy, ctx);
    usedMethod = 'Playwright';
  } catch (err) {
    console.log('[Search] Playwright упал:', err.message);

    // Если туннель/прокси — пробуем старый надёжный способ
    if (
      err.message.includes('TUNNEL') ||
      err.message.includes('PROXY') ||
      err.message.includes('ERR_') ||
      err.message.includes('Captcha')
    ) {
      if (ctx?.reply) await ctx.reply('🔄 Playwright не смог → переключаюсь на node-fetch...');
      try {
        results = await searchYandexHttp(query, searchProxy, ctx);
        usedMethod = 'node-fetch (fallback)';
      } catch (err2) {
        // Последняя попытка — сменить IP и ещё раз через HTTP
        await changeProxyIP(ctx);
        searchProxy = randomProxy(searchProxy?.server);
        await sleep(5000);
        results = await searchYandexHttp(query, searchProxy, ctx);
        usedMethod = 'node-fetch после rotate';
      }
    } else {
      throw err;
    }
  }

  if (!results.length) {
    return '⚠️ Выдача пуста';
  }

  await ctx.reply(`📋 Найдено: ${results.length} сайтов (метод: ${usedMethod})\nНачинаю визиты...`);

  let lastProxy = searchProxy?.server || null;

  for (const item of results) {
    if (!isRunning) break;

    let domain;
    try {
      domain = new URL(item.url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }

    if (isStopped(domain, stopSet)) {
      actions.push(`⏭️ *${domain}* — стоп`);
      continue;
    }

    const proxy = randomProxy(lastProxy);
    lastProxy = proxy?.server || null;
    const tag = proxy ? proxy.server.split('://')[1]?.split(':')[0] : 'direct';

    let session;
    try {
      session = await launchSession(proxy);
      const action = await visitSite(session.page, item.url);
      visited.push(domain);
      actions.push(`✅ *${domain}* — ${action} _(${tag})_`);
    } catch (err) {
      actions.push(`⚠️ *${domain}* — сбой`);
    } finally {
      if (session?.browser) await session.browser.close().catch(() => {});
    }
    await sleep(3000 + Math.random() * 4000);
  }

  return [
    `📊 *Отчёт*`,
    `Фраза: «${query}»`,
    `Метод поиска: ${usedMethod}`,
    `Посещено: ${visited.length}`,
    ``,
    `*Детали:*`,
    ...actions,
  ].join('\n');
}

// ====================== ПОИСК ЧЕРЕЗ PLAYWRIGHT ======================
async function searchYandexPlaywright(query, proxy, ctx) {
  let session;
  try {
    session = await launchSession(proxy);
    const page = session.page;

    await page.goto('https://m.yandex.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    });
    await sleep(1800 + Math.random() * 1500);

    const searchUrl = `https://m.yandex.ru/search/?text=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 40000,
    });
    await sleep(2200 + Math.random() * 1800);

    const content = await page.content();
    if (
      content.includes('smartcaptcha') ||
      content.includes('Captcha') ||
      content.includes('Я не робот') ||
      content.includes('подтвердите')
    ) {
      throw new Error('Captcha detected');
    }

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('div.serp-item, .Organic, .card, article, [data-cid], .organic').forEach(node => {
        const a = node.querySelector('a[href^="http"]');
        if (!a) return;
        const href = a.href;
        if (href.includes('yandex.') || href.includes('ya.ru')) return;
        const title = (node.querySelector('h2, .organic__title, .Title') || a).innerText.trim();
        results.push({ url: href, title });
      });
      return results;
    });

    const seen = new Set();
    return items.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
  } finally {
    if (session?.browser) await session.browser.close().catch(() => {});
  }
}

// ====================== СТАРЫЙ НАДЁЖНЫЙ ПОИСК (fallback) ======================
async function searchYandexHttp(query, proxy, ctx) {
  let proxyUrl = proxy.server;
  if (proxy.username && proxy.password) {
    const u = new URL(proxy.server);
    u.username = proxy.username;
    u.password = proxy.password;
    proxyUrl = u.toString();
  }
  const agent = new HttpsProxyAgent(proxyUrl);

  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

  // Прогрев
  let cookies = '';
  try {
    const home = await fetch('https://m.yandex.ru/', {
      agent,
      headers: { 'User-Agent': ua, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      timeout: 15000,
    });
    const raw = home.headers.raw?.()['set-cookie'] || [];
    if (raw.length) cookies = raw.map(c => c.split(';')[0]).join('; ');
  } catch (e) {}

  await sleep(1200);

  const searchUrl = `https://m.yandex.ru/search/?text=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    agent,
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'Cookie': cookies,
      'Referer': 'https://m.yandex.ru/',
    },
    timeout: 25000,
  });

  const html = await res.text();

  if (html.includes('Captcha') || html.includes('smartcaptcha') || html.includes('подтвердите')) {
    throw new Error('Captcha detected');
  }

  const $ = cheerio.load(html);
  const items = [];

  $('div.serp-item, .card, article, div[data-fast-name], .organic').each((_, el) => {
    const a = $(el).find('a[href^="http"]').first();
    const href = a.attr('href');
    if (href && !href.includes('yandex.') && !href.includes('ya.ru')) {
      const title = $(el).find('h2, .organic__title').text().trim() || href;
      items.push({ url: href, title });
    }
  });

  const seen = new Set();
  return items.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
}

async function launchSession(proxy) {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
    ],
  };

  if (proxy) {
    opts.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  const browser = await chromium.launch(opts);
  const device = devices['Pixel 7'];
  const context = await browser.newContext({
    ...device,
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    ignoreHTTPSErrors: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

async function visitSite(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2000 + Math.random() * 1500);

  const duration = 8000 + Math.random() * 4000;
  const t0 = Date.now();
  while (Date.now() - t0 < duration) {
    await page.evaluate(y => window.scrollBy({ top: y, behavior: 'smooth' }), 150 + Math.random() * 250);
    await sleep(800 + Math.random() * 1000);
  }

  const tel = page.locator('a[href^="tel:"]').first();
  if (await tel.isVisible({ timeout: 2000 }).catch(() => false)) {
    try {
      await tel.click({ timeout: 3000 });
      await sleep(1500);
      return 'клик «Позвонить»';
    } catch {}
  }
  return 'просмотр';
}

bot.use(async (ctx) => {
  if (ctx.message?.text?.startsWith('/')) {
    await ctx.reply(
      '❓ Команды:\n/run /stop_run /changeip /testproxy\n/queries /setquery N\n/auto_on /auto_off /auto_status'
    );
  }
});

bot.launch().then(() => {
  console.log('✅ Бот запущен (с умным fallback)');
  if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
});

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
