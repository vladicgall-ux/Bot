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
PROXIES.forEach((p, i) => console.log(`  #${i + 1}: ${p.server} (user: ${p.username ? 'есть' : 'нет'})`));

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
    if (ctx) {
      await ctx.reply('🔄 IP-адрес прокси успешно запрошен на смену!');
    }
    await sleep(4000);
  } catch (err) {
    console.error('[Proxy] Ошибка смены IP:', err);
    if (ctx) {
      await ctx.reply(`❌ Не удалось сменить IP: ${err.message}`);
    }
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
  console.log(`[scheduler] Интервал: ${AUTO_INTERVAL_HOURS} ч`);

  autoTimer = setInterval(async () => {
    if (!autoEnabled || isRunning || !ADMIN_CHAT_ID) return;
    const query = DEFAULT_QUERIES[Math.floor(Math.random() * DEFAULT_QUERIES.length)];
    console.log(`[scheduler] «${query}»`);
    isRunning = true;
    try {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⏰ *Автопрогон* (${++autoRunCount})\n«${query}»`, { parse_mode: 'Markdown' });
      const report = await runSurf(query, stopDomains, {
        reply: (text, opts) => bot.telegram.sendMessage(ADMIN_CHAT_ID, text, opts),
      });
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
      lastAutoRun = new Date();
    } catch (err) {
      console.error('[scheduler]', err);
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `❌ ${err.message}`).catch(() => {});
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
    `🤖 *Бот серфинга в Яндексе*\n\n` +
    `*Основное:*\n` +
    `• Текст = фраза, /run — старт, /stop_run — стоп.\n\n` +
    `*Фразы:* /queries, /setquery N, /run_all\n\n` +
    `*Стоп-домены:* /stop, /stop_reset\n\n` +
    `*Управление IP:* /changeip\n\n` +
    `*Автопрогон:* /auto_on, /auto_off, /auto_status\n\n` +
    `*Диагностика:* /testproxy\n\n` +
    `Прокси: ${PROXIES.length}\n` +
    `Фраза: ${currentQuery || '—'}\n` +
    `Стоп-домены (${stopDomains.size}): ${[...stopDomains].join(', ')}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('changeip', async (ctx) => {
  await changeProxyIP(ctx);
});

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Проверяю прокси через HTTP-запрос...');

  if (!PROXIES.length) return ctx.reply('❌ Прокси не заданы.');

  const proxy = PROXIES[0];
  let proxyUrlWithAuth = proxy.server;
  if (proxy.username && proxy.password) {
    const urlObj = new URL(proxy.server);
    urlObj.username = proxy.username;
    urlObj.password = proxy.password;
    proxyUrlWithAuth = urlObj.toString();
  }
  const customAgent = new HttpsProxyAgent(proxyUrlWithAuth);

  const sites = [
    'https://api.ipify.org?format=json',
    'https://2ip.ru/',
    'https://yandex.ru/search/?text=test',
  ];

  const lines = [`Прокси: ${proxy.server}`, ''];
  for (const url of sites) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        agent: customAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 25000,
      });
      lines.push(`✅ ${url} — статус ${res.status} (${Date.now() - t0}ms)`);
    } catch (err) {
      lines.push(`❌ ${url} — ${err.message.slice(0, 80)}`);
    }
  }
  await ctx.reply(lines.join('\n'));
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

bot.command('queries', (ctx) => {
  ctx.reply(`📝 Фразы:\n\n${DEFAULT_QUERIES.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
});

bot.command('setquery', (ctx) => {
  const n = parseInt(ctx.message.text.replace('/setquery', '').trim(), 10);
  if (!n || n < 1 || n > DEFAULT_QUERIES.length) return ctx.reply(`1–${DEFAULT_QUERIES.length}`);
  currentQuery = DEFAULT_QUERIES[n - 1];
  ctx.reply(`✅ «${currentQuery}»`);
});

bot.command('run', async (ctx) => {
  if (isRunning) return ctx.reply('⚠️ Уже выполняется.');
  if (!currentQuery) return ctx.reply('❌ Фраза не задана.');
  isRunning = true;
  await ctx.reply(`🚀 «${currentQuery}»`);
  try {
    const report = await runSurf(currentQuery, stopDomains, ctx);
    await ctx.reply(report, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  } finally {
    isRunning = false;
  }
});

bot.command('run_all', async (ctx) => {
  if (isRunning) return ctx.reply('⚠️ Уже.');
  isRunning = true;
  queryQueue = [...DEFAULT_QUERIES];
  await ctx.reply(`🚀 Прогон ${queryQueue.length} фраз.`);
  const summary = [];
  try {
    while (queryQueue.length && isRunning) {
      const q = queryQueue.shift();
      await ctx.reply(`▶️ (${DEFAULT_QUERIES.length - queryQueue.length}/${DEFAULT_QUERIES.length}): «${q}»`);
      try {
        const report = await runSurf(q, stopDomains, ctx);
        await ctx.reply(report, { parse_mode: 'Markdown' });
        summary.push(`✅ «${q}»`);
      } catch (err) {
        summary.push(`❌ «${q}»`);
      }
      await sleep(5000 + Math.random() * 5000);
    }
    await ctx.reply(`🏁 Готово\n\n${summary.join('\n')}`);
  } finally {
    isRunning = false;
    queryQueue = [];
  }
});

bot.command('stop_run', (ctx) => {
  isRunning = false;
  ctx.reply('🛑');
});

bot.command('auto_on', (ctx) => {
  if (autoEnabled) return ctx.reply('⚠️ Уже.');
  autoEnabled = true;
  startScheduler();
  ctx.reply(`✅ Авто каждые ${AUTO_INTERVAL_HOURS} ч`);
});

bot.command('auto_off', (ctx) => {
  autoEnabled = false;
  stopScheduler();
  ctx.reply('🛑');
});

bot.command('auto_status', (ctx) => {
  ctx.reply(
    `Авто: ${autoEnabled ? '✅' : '❌'}\n` +
    `Интервал: ${AUTO_INTERVAL_HOURS} ч\n` +
    `Прогонов: ${autoRunCount}\n` +
    `Последний: ${lastAutoRun ? lastAutoRun.toLocaleString('ru-RU') : '—'}`
  );
});

bot.on('text', (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  currentQuery = text;
  ctx.reply(`✅ «${currentQuery}»`);
});

async function runSurf(query, stopSet, ctx) {
  const visited = [];
  const actions = [];

  const searchProxy = randomProxy();
  
  let results = [];
  try {
    results = await searchYandexHttp(query, searchProxy, ctx);
  } catch (err) {
    await changeProxyIP();
    throw err;
  }

  if (!results.length) {
    return '⚠️ Поисковая выдача пуста или заблокирована капчей.';
  }
  await ctx.reply(`📋 Найдено результатов: ${results.length}. Начинаю визиты...`);

  let lastProxy = searchProxy?.server || null;

  for (const item of results) {
    if (!isRunning) break;
    let domain;
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }

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
      actions.push(`⚠️ *${domain}* — ${err.message.slice(0, 60)}`);
    } finally {
      if (session?.browser) await session.browser.close().catch(() => {});
    }
    await sleep(3000 + Math.random() * 4000);
  }

  return [
    `📊 *Отчёт*`,
    `Фраза: «${query}»`,
    `Прокси: ${PROXIES.length}`,
    `Посещено: ${visited.length}`,
    ``,
    `*Действия:*`,
    ...actions,
  ].join('\n');
}

async function searchYandexHttp(query, proxy, ctx) {
  let proxyUrlWithAuth = proxy.server;
  if (proxy.username && proxy.password) {
    const urlObj = new URL(proxy.server);
    urlObj.username = proxy.username;
    urlObj.password = proxy.password;
    proxyUrlWithAuth = urlObj.toString();
  }
  const agent = new HttpsProxyAgent(proxyUrlWithAuth);

  const searchUrl = `https://yandex.ru/search/?text=${encodeURIComponent(query)}`;
  
  const response = await fetch(searchUrl, {
    agent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
    },
    timeout: 30000,
  });

  const html = await response.text();

  if (html.includes('Captcha') || html.includes('подтвердите') || html.includes('я не робот')) {
    if (ctx && ctx.reply) await ctx.reply('🛑 Яндекс затребовал капчу при HTTP-запросе.');
    throw new Error('Captcha detected');
  }

  const $ = cheerio.load(html);
  const items = [];

  $('li.serp-item, div[data-fast-name="organic"], article[data-fast-name="organic"]').each((_, node) => {
    const link = $(node).find('a.OrganicTitle-Link, a[href^="http"]').first();
    const href = link.attr('href');
    const title = $(node).find('h2, .OrganicTitle').text().trim();

    if (href && !href.includes('yandex.ru') && !href.includes('ya.ru') && href.startsWith('http')) {
      items.push({ url: href, title: title || href });
    }
  });

  const seen = new Set();
  return items.filter((i) => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
}

async function launchSession(proxy) {
  const browser = await chromium.launch({
    headless: true,
    proxy: proxy || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const device = devices['Pixel 7'];
  const context = await browser.newContext({
    ...device,
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    geolocation: { latitude: 55.1644, longitude: 61.4368 },
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

async function visitSite(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2000 + Math.random() * 1500);
  
  const duration = 10000 + Math.random() * 5000;
  const t0 = Date.now();
  while (Date.now() - t0 < duration) {
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), 150 + Math.random() * 250);
    await sleep(800 + Math.random() * 1000);
  }

  const tel = page.locator('a[href^="tel:"]').first();
  if (await tel.isVisible({ timeout: 2000 }).catch(() => false)) {
    try { await tel.click({ timeout: 3000 }); await sleep(1500); return 'клик «Позвонить»'; } catch {}
  }

  const cta = page.locator(
    'button:has-text("Заказать"), a:has-text("Заказать"), ' +
    'button:has-text("Оставить заявку"), a:has-text("Оставить заявку"), ' +
    'button:has-text("Обратная связь"), a:has-text("Обратная связь"), ' +
    'button:has-text("Связаться"), a:has-text("Связаться")'
  );
  const count = await cta.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = cta.nth(i);
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      try {
        const text = await btn.innerText().catch(() => 'кнопка');
        await btn.click({ timeout: 3000 });
        await sleep(1500);
        return `клик «${text.slice(0, 30)}»`;
      } catch {}
    }
  }
  return 'просмотр';
}

bot.launch()
  .then(() => {
    console.log('✅ Бот успешно запущен!');
    if (AUTO_ENABLED_DEFAULT) {
      autoEnabled = true;
      startScheduler();
      console.log('[scheduler] Авто включён');
    }
  })
  .catch((err) => { console.error('❌', err); process.exit(1); });

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
