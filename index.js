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

// ====================== API LTEBOOST ======================
const LTEBOOST_API_KEY = 'ltb_8EkIQN-4KxDsb94Ot51LFIqH6pOQ3gly7Blt1d8FAIQ';
const LTEBOOST_API_BASE = 'https://gb.lteboost.com/api/client/v1';

let CURRENT_PROXY = {
  server: 'http://mob.lteboost.com:3000',
  username: 'user_2ce64754',
  password: '9GhUc54U0LRoIUTFq730',
};

let lastKeyChange = 0; // защита от частого recreate

function randomProxy() {
  return CURRENT_PROXY;
}

async function changeProxyIP(ctx = null, force = false) {
  const now = Date.now();
  if (!force && now - lastKeyChange < 90000) { // минимум 90 секунд между сменами
    if (ctx) await ctx.reply('⏳ Ключ недавно менялся, пропускаю...');
    return false;
  }

  try {
    if (ctx) await ctx.reply('🔄 Запрашиваю новый proxy_key...');

    const response = await fetch(`${LTEBOOST_API_BASE}/proxy-keys/recreate?proxy_type=mobile`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LTEBOOST_API_KEY}`,
        'X-API-Key': LTEBOOST_API_KEY,
        'Accept': 'application/json',
      },
      timeout: 20000,
    });

    const text = await response.text();
    console.log('[Proxy] recreate:', text);

    const data = JSON.parse(text);

    if (data.status === 'success' && data.new_proxy_key) {
      CURRENT_PROXY.username = data.username || CURRENT_PROXY.username;
      CURRENT_PROXY.password = data.new_proxy_key;
      lastKeyChange = Date.now();

      if (ctx) {
        await ctx.reply(
          `✅ *IP обновлён!*\nKey: \`${CURRENT_PROXY.password}\``,
          { parse_mode: 'Markdown' }
        );
      }
      return true;
    }

    if (data.detail && data.detail.includes('Too many')) {
      if (ctx) await ctx.reply('⚠️ Лимит API на смену ключа. Жду 2 минуты...');
      await sleep(120000);
      return false;
    }

    if (ctx) await ctx.reply(`⚠️ Ответ: ${text.slice(0, 300)}`);
    return false;
  } catch (err) {
    console.error('[Proxy]', err.message);
    if (ctx) await ctx.reply(`❌ Ошибка: ${err.message}`);
    return false;
  }
}

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
    `🤖 *Бот серфинга (Anti-Captcha + lr=74)*\n\n` +
    `• /changeip — смена IP\n` +
    `• /testproxy — проверка\n` +
    `• /run — запуск\n` +
    `• Фраза: ${currentQuery || '—'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('changeip', async (ctx) => {
  await changeProxyIP(ctx, true);
});

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Тестирую прокси...');
  const proxy = CURRENT_PROXY;

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
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      },
      timeout: 20000,
    });
    await ctx.reply(`✅ node-fetch: ${res.status}`);
  } catch (err) {
    await ctx.reply(`❌ node-fetch: ${err.message.slice(0, 120)}`);
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
  await ctx.reply(`Статус: ${autoEnabled ? '🟢 Включён' : '🔴 Выключен'}\nЗапусков: ${autoRunCount}`);
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

  // Меняем ключ только если прошло достаточно времени
  await changeProxyIP(ctx);
  await sleep(5000);

  let results = [];
  let lastError = '';

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      results = await searchYandexHttp(query, CURRENT_PROXY, ctx);
      break;
    } catch (err) {
      lastError = err.message;
      console.log(`[Search] ${attempt}: ${err.message}`);

      if (ctx?.reply) {
        await ctx.reply(`🛑 Капча/ошибка (${attempt}/4): ${err.message}`);
      }

      // Долгая пауза при капче
      await sleep(15000 + Math.random() * 15000);
      await changeProxyIP(ctx);
      await sleep(5000);
    }
  }

  if (!results.length) {
    return `⚠️ Не удалось получить выдачу.\nПоследняя ошибка: ${lastError}`;
  }

  await ctx.reply(`📋 Найдено: ${results.length} сайтов (Челябинск)`);

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

    let session;
    try {
      session = await launchSession(CURRENT_PROXY);
      const action = await visitSite(session.page, item.url);
      visited.push(domain);
      actions.push(`✅ *${domain}* — ${action}`);
    } catch (err) {
      actions.push(`⚠️ *${domain}* — не открылся`);
    } finally {
      if (session?.browser) await session.browser.close().catch(() => {});
    }
    await sleep(4500 + Math.random() * 4000);
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

// ====================== УСИЛЕННЫЙ ПОИСК ПРОТИВ КАПЧИ ======================
async function searchYandexHttp(query, proxy, ctx) {
  let proxyUrl = proxy.server;
  if (proxy.username && proxy.password) {
    const u = new URL(proxy.server);
    u.username = proxy.username;
    u.password = proxy.password;
    proxyUrl = u.toString();
  }
  const agent = new HttpsProxyAgent(proxyUrl);

  const mobileUAs = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  ];
  const ua = mobileUAs[Math.floor(Math.random() * mobileUAs.length)];
  const isIOS = ua.includes('iPhone');

  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': isIOS ? undefined : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': isIOS ? '"iOS"' : '"Android"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  // ===== Долгий прогрев =====
  let cookies = '';
  try {
    // 1. Главная
    const homeRes = await fetch('https://m.yandex.ru/', {
      agent,
      headers,
      timeout: 20000,
    });

    let setCookies = [];
    if (typeof homeRes.headers.getSetCookie === 'function') {
      setCookies = homeRes.headers.getSetCookie();
    } else if (homeRes.headers.raw) {
      setCookies = homeRes.headers.raw()['set-cookie'] || [];
    }
    if (setCookies.length) {
      cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    }

    await sleep(4000 + Math.random() * 3000);

    // 2. Ещё один запрос для прогрева
    await fetch('https://m.yandex.ru/?from=tabbar', {
      agent,
      headers: { ...headers, Cookie: cookies, Referer: 'https://m.yandex.ru/' },
      timeout: 15000,
    }).catch(() => {});

    await sleep(3000 + Math.random() * 2000);
  } catch (e) {
    console.warn('[Warmup]', e.message);
  }

  // ===== Поиск =====
  const searchHeaders = {
    ...headers,
    'Referer': 'https://m.yandex.ru/',
    'Sec-Fetch-Site': 'same-origin',
  };
  if (cookies) searchHeaders['Cookie'] = cookies;

  const res = await fetch(`https://m.yandex.ru/search/?text=${encodeURIComponent(query)}&lr=74`, {
    agent,
    headers: searchHeaders,
    timeout: 30000,
  });

  const html = await res.text();

  // Проверка капчи
  const captchaSignals = [
    'smartcaptcha',
    'Captcha',
    'checkbox-captcha',
    'подтвердите, что вы не робот',
    'Я не робот',
    'SmartCaptcha',
    'captcha__export',
    'data-testid="checkbox-captcha"',
  ];

  if (captchaSignals.some(s => html.includes(s))) {
    throw new Error('Captcha detected');
  }

  const $ = cheerio.load(html);
  const items = [];

  $('div.serp-item, .Organic, .card, article, [data-cid], .organic, .SerpItem').each((_, el) => {
    const a = $(el).find('a[href^="http"]').first();
    const href = a.attr('href');
    if (!href || href.includes('yandex.') || href.includes('ya.ru')) return;
    const title = $(el).find('h2, .organic__title, .Title').text().trim() || a.text().trim();
    items.push({ url: href, title: title || href });
  });

  const seen = new Set();
  const unique = items.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);

  if (unique.length === 0) {
    throw new Error('Пустая выдача');
  }

  return unique;
}

async function launchSession(proxy) {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (proxy) {
    opts.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  const browser = await chromium.launch(opts);
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    ignoreHTTPSErrors: true,
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
    await ctx.reply('❓ /run /stop_run /changeip /testproxy /queries /setquery N');
  }
});

bot.launch().then(() => {
  console.log('✅ Бот запущен (усиленный anti-captcha + lr=74)');
  if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
});

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
