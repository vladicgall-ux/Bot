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
    console.log('[Proxy] Запрос смены IP выполнен:', text);
    if (ctx) await ctx.reply('🔄 IP-адрес прокси успешно запрошен на смену!');
    await sleep(4000);
  } catch (err) {
    console.error('[Proxy] Ошибка смены IP:', err);
    if (ctx) await ctx.reply(`❌ Не удалось сменить IP: ${err.message}`);
  }
}

let currentQuery = '';
let isRunning = false;
let queryQueue = [];

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
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;
const AUTO_ENABLED_DEFAULT = String(process.env.AUTO_ENABLED || 'false').toLowerCase() === 'true';

let autoTimer = null;
let autoEnabled = false;
let lastAutoRun = null;
let autoRunCount = 0;

function startScheduler() {
  if (autoTimer) clearInterval(autoTimer);
  const intervalMs = AUTO_INTERVAL_HOURS * 60 * 60 * 1000;

  autoTimer = setInterval(async () => {
    if (!autoEnabled || isRunning || !ADMIN_CHAT_ID) return;
    const query = DEFAULT_QUERIES[Math.floor(Math.random() * DEFAULT_QUERIES.length)];
    isRunning = true;
    try {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⏰ *Автопрогон*\n«${query}»`, { parse_mode: 'Markdown' });
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

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[Telegraf] ${ctx.updateType}:`, err);
  ctx.reply(`⚠️ ${err.message}`).catch(() => {});
});

bot.start((ctx) => {
  ctx.reply(
    `🤖 *Бот серфинга в Яндексе (Proxy-Only Mode)*\n\n` +
    `• Отправьте текст фразы или используйте /setquery N\n` +
    `• /run — старт, /stop_run — стоп\n` +
    `• Управление IP: /changeip, /testproxy\n` +
    `• Текущая фраза: ${currentQuery || '—'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('changeip', async (ctx) => { await changeProxyIP(ctx); });

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Проверяю прокси...');
  if (!PROXIES.length) return ctx.reply('❌ Прокси не заданы.');

  const proxy = PROXIES[0];
  
  try {
    const proxyUrlWithAuth = proxy.username && proxy.password 
      ? `http://${proxy.username}:${proxy.password}@${proxy.server.replace('http://', '')}`
      : proxy.server;
    const agent = new HttpsProxyAgent(proxyUrlWithAuth);
    const res = await fetch('https://api.ipify.org?format=json', { agent, timeout: 10000 });
    const data = await res.json();
    await ctx.reply(`✅ Прокси работает!\n📍 IP: ${data.ip}`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка прокси: ${e.message}`);
  }
});

bot.command('queries', (ctx) => {
  ctx.reply(`📝 Фразы:\n\n${DEFAULT_QUERIES.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
});

bot.command('setquery', (ctx) => {
  const n = parseInt(ctx.message.text.replace('/setquery', '').trim(), 10);
  if (!n || n < 1 || n > DEFAULT_QUERIES.length) return ctx.reply(`Укажите номер от 1 до ${DEFAULT_QUERIES.length}`);
  currentQuery = DEFAULT_QUERIES[n - 1];
  ctx.reply(`✅ Выбрана фраза #${n}: «${currentQuery}»`);
});

bot.command('run', async (ctx) => {
  if (isRunning) return ctx.reply('⚠️ Уже выполняется.');
  if (!currentQuery) return ctx.reply('❌ Фраза не задана. Сначала выберите фразу через /setquery N или отправьте текст.');
  isRunning = true;
  await ctx.reply(`🚀 Запуск для: «${currentQuery}»`);
  try {
    const report = await runSurf(currentQuery, stopDomains, ctx);
    await ctx.reply(report, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  } finally {
    isRunning = false;
  }
});

bot.command('stop_run', (ctx) => { isRunning = false; ctx.reply('🛑 Остановлено.'); });

bot.on('text', (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  currentQuery = text;
  ctx.reply(`✅ Установлена фраза: «${currentQuery}»`);
});

async function runSurf(query, stopSet, ctx) {
  const visited = [];
  const actions = [];
  const searchProxy = randomProxy();
  
  let results = [];
  try {
    results = await searchYandexMobilePlaywright(query, searchProxy, ctx);
  } catch (err) {
    console.error('[runSurf] Search error:', err.message);
    await changeProxyIP();
    throw err;
  }

  if (!results.length) {
    return '⚠️ Выдача пуста или поймана капча.';
  }
  await ctx.reply(`📋 Найдено сайтов: ${results.length}. Начинаю визиты...`);

  let lastProxy = searchProxy?.server || null;

  for (const item of results) {
    if (!isRunning) break;
    let domain;
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }

    if (isStopped(domain, stopSet)) {
      actions.push(`⏭️ *${domain}* — стоп-домен`);
      continue;
    }

    const proxy = randomProxy(lastProxy);
    lastProxy = proxy?.server || null;
    const tag = proxy ? proxy.server.split('://')[1]?.split(':')[0] : 'proxy';

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
    `📊 *Отчёт выполнения*`,
    `Фраза: «${query}»`,
    `Посещено сайтов: ${visited.length}`,
    ``,
    `*Детали:*`,
    ...actions,
  ].join('\n');
}

// ============================================================================
// ПОИСК ТОЛЬКО С ПРОКСИ (без fallback на прямое соединение)
// Если прокси не работает - возвращаем ошибку
// ============================================================================
async function searchYandexMobilePlaywright(query, proxy, ctx) {
  let session;
  try {
    session = await launchSession(proxy);
    const page = session.page;
    
    // Блокируем загрузку ненужных ресурсов
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,mp4,webm,mov}', route => route.abort());
    await page.route('**/*.css', route => route.abort());
    await page.route('**/analytics/**', route => route.abort());
    await page.route('**/ads/**', route => route.abort());
    
    console.log(`[Yandex] Поиск с прокси: ${proxy?.server || 'unknown'}...`);
    
    await page.goto('https://m.yandex.ru/', { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });
    
    await sleep(2000 + Math.random() * 2000);

    const searchUrl = `https://m.yandex.ru/search/?text=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });

    await sleep(1000 + Math.random() * 1000);

    const pageText = await page.content().catch(() => '');
    
    if (pageText.includes('smartcaptcha') || pageText.includes('Captcha') || pageText.includes('подтвердите')) {
      if (ctx && ctx.reply) await ctx.reply('🛑 Яндекс затребовал SmartCaptcha. Меняю IP...');
      throw new Error('SmartCaptcha detected');
    }

    const html = await page.content();
    const $ = cheerio.load(html);
    const items = [];

    $('a[href^="http"]').each((_, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      
      if (href && 
          !href.includes('yandex.ru') && 
          !href.includes('ya.ru') &&
          !href.includes('turbo.yandex') &&
          !href.includes('ads.') &&
          href.startsWith('http')) {
        if (!items.some(i => i.url === href)) {
          items.push({ url: href, title: title || href });
        }
      }
    });

    console.log(`[Yandex] Найдено результатов: ${items.length}`);
    return items.slice(0, 10);

  } catch (err) {
    console.error('[searchYandex]', err.message);
    
    if (ctx && ctx.reply) {
      await ctx.reply(`❌ Ошибка поиска: ${err.message.slice(0, 100)}`).catch(() => {});
    }
    throw err;
  } finally {
    if (session?.browser) {
      await session.browser.close().catch(() => {});
    }
  }
}

async function launchSession(proxy) {
  if (!proxy) {
    throw new Error('Прокси требуется! Используйте /testproxy для проверки.');
  }

  const proxyConfig = {
    server: proxy.server,
    username: proxy.username,
    password: proxy.password,
  };

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyConfig,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-resources',
      '--blink-settings=imagesEnabled=false',
    ],
  });

  const device = devices['Pixel 7'];
  const context = await browser.newContext({
    ...device,
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
  });

  const page = await context.newPage();
  
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
  });

  return { browser, context, page };
}

async function visitSite(page, url) {
  await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,mp4,webm,mov,avi,flv}', route => route.abort());
  
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000 + Math.random() * 1500);
  
  const duration = 8000 + Math.random() * 4000;
  const t0 = Date.now();
  while (Date.now() - t0 < duration) {
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), 150 + Math.random() * 250);
    await sleep(800 + Math.random() * 1000);
  }

  const tel = page.locator('a[href^="tel:"]').first();
  if (await tel.isVisible({ timeout: 2000 }).catch(() => false)) {
    try { await tel.click({ timeout: 3000 }); await sleep(1500); return 'клик «Позвонить»'; } catch {}
  }
  return 'просмотр';
}

bot.launch().then(() => console.log('✅ Бот запущен (Proxy-Only Mode - Traffic Optimized)'));

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
