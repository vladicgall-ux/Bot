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

// ====================== НОВЫЙ API LTEBOOST ======================
const LTEBOOST_API_KEY = 'ltb_8EkIQN-4KxDsb94Ot51LFIqH6pOQ3gly7Blt1d8FAIQ';
const LTEBOOST_API_BASE = 'https://gb.lteboost.com/api/client/v1';

// Текущие данные прокси (будут обновляться)
let CURRENT_PROXY = {
  server: 'http://mob.lteboost.com:3000',
  username: 'user_2ce64754',
  password: 'Ufbdey9RjOsJTFGv8j7a', // свежий ключ
};

function getProxies() {
  return [CURRENT_PROXY];
}

function randomProxy(exclude = null) {
  const list = getProxies();
  if (!list.length) return null;
  return list[0]; // пока один прокси
}

// ====================== СМЕНА IP ЧЕРЕЗ НОВЫЙ API ======================
async function changeProxyIP(ctx = null) {
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
    console.log('[Proxy] recreate response:', text);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (ctx) await ctx.reply(`❌ Не JSON ответ:\n${text.slice(0, 300)}`);
      return false;
    }

    if (data.status === 'success' && data.new_proxy_key) {
      // Обновляем пароль
      CURRENT_PROXY.username = data.username || CURRENT_PROXY.username;
      CURRENT_PROXY.password = data.new_proxy_key;

      console.log('[Proxy] Новый пароль применён:', CURRENT_PROXY.password);

      if (ctx) {
        await ctx.reply(
          `✅ *IP успешно обновлён!*\n\n` +
          `Username: \`${CURRENT_PROXY.username}\`\n` +
          `Новый key: \`${CURRENT_PROXY.password}\``,
          { parse_mode: 'Markdown' }
        );
      }
      return true;
    } else {
      if (ctx) await ctx.reply(`⚠️ Неожиданный ответ:\n\`\`\`\n${JSON.stringify(data, null, 2).slice(0, 500)}\n\`\`\``, { parse_mode: 'Markdown' });
      return false;
    }

  } catch (err) {
    console.error('[Proxy] Ошибка:', err.message);
    if (ctx) await ctx.reply(`❌ Ошибка смены IP:\n${err.message}`);
    return false;
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
    `🤖 *Бот серфинга*\n\n` +
    `• /changeip — смена IP (новый API)\n` +
    `• /testproxy — проверка прокси\n` +
    `• /run — запуск\n` +
    `• Фраза: ${currentQuery || '—'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('changeip', async (ctx) => {
  await changeProxyIP(ctx);
});

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Тестирую текущий прокси...');

  const proxy = CURRENT_PROXY;

  // node-fetch
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

  // Playwright
  let session;
  try {
    session = await launchSession(proxy);
    await session.page.goto('https://m.yandex.ru/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await ctx.reply('✅ Playwright: работает');
  } catch (err) {
    await ctx.reply(`❌ Playwright: ${err.message.slice(0, 120)}`);
  } finally {
    if (session?.browser) await session.browser.close().catch(() => {});
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

  // Сначала обновляем IP
  if (ctx?.reply) await ctx.reply('🔄 Получаю свежий proxy_key...');
  await changeProxyIP(ctx);
  await sleep(3000);

  let searchProxy = randomProxy();
  let results = [];
  let usedMethod = '';
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      results = await searchYandexPlaywright(query, searchProxy, ctx);
      usedMethod = 'Playwright';
      break;
    } catch (err) {
      console.log(`[Search] ${attempts}: Playwright → ${err.message}`);

      if (err.message.includes('TUNNEL') || err.message.includes('ERR_') || err.message.includes('Timeout')) {
        try {
          results = await searchYandexHttp(query, searchProxy, ctx);
          usedMethod = 'node-fetch';
          break;
        } catch (err2) {
          console.log(`[Search] HTTP → ${err2.message}`);
        }
      }

      if (ctx?.reply) await ctx.reply(`🛑 Ошибка (${attempts}/${maxAttempts}). Обновляю key...`);
      await changeProxyIP(ctx);
      searchProxy = randomProxy();
      await sleep(7000);
    }
  }

  if (!results.length) {
    return '⚠️ Не удалось получить выдачу.';
  }

  await ctx.reply(`📋 Найдено: ${results.length} сайтов\nМетод: *${usedMethod}*`, { parse_mode: 'Markdown' });

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

    const proxy = randomProxy();
    const tag = 'mobile';

    let session;
    try {
      session = await launchSession(proxy);
      const action = await visitSite(session.page, item.url);
      visited.push(domain);
      actions.push(`✅ *${domain}* — ${action}`);
    } catch (err) {
      actions.push(`⚠️ *${domain}* — сбой`);
    } finally {
      if (session?.browser) await session.browser.close().catch(() => {});
    }
    await sleep(4000 + Math.random() * 4000);
  }

  return [
    `📊 *Отчёт*`,
    `Фраза: «${query}»`,
    `Метод: ${usedMethod}`,
    `Посещено: ${visited.length}`,
    ``,
    ...actions,
  ].join('\n');
}

async function searchYandexPlaywright(query, proxy, ctx) {
  let session;
  try {
    session = await launchSession(proxy);
    const page = session.page;

    await page.goto('https://m.yandex.ru/', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(2500 + Math.random() * 2000);

    const searchUrl = `https://m.yandex.ru/search/?text=${encodeURIComponent(query)}&lr=54`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000 + Math.random() * 2000);

    const content = await page.content();
    if (content.includes('smartcaptcha') || content.includes('Captcha') || content.includes('Я не робот') || content.includes('подтвердите')) {
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
        results.push({ url: href, title: title || href });
      });
      return results;
    });

    const seen = new Set();
    return items.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
  } finally {
    if (session?.browser) await session.browser.close().catch(() => {});
  }
}

async function searchYandexHttp(query, proxy, ctx) {
  let proxyUrl = proxy.server;
  if (proxy.username && proxy.password) {
    const u = new URL(proxy.server);
    u.username = proxy.username;
    u.password = proxy.password;
    proxyUrl = u.toString();
  }
  const agent = new HttpsProxyAgent(proxyUrl);

  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

  let cookies = '';
  try {
    const home = await fetch('https://m.yandex.ru/', {
      agent,
      headers: { 'User-Agent': ua, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      timeout: 18000,
    });
    const setCookies = home.headers.raw?.()['set-cookie'] || [];
    if (setCookies.length) cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    await sleep(2500);
  } catch {}

  const res = await fetch(`https://m.yandex.ru/search/?text=${encodeURIComponent(query)}&lr=54`, {
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
  if (html.includes('smartcaptcha') || html.includes('Captcha') || html.includes('Я не робот')) {
    throw new Error('Captcha detected');
  }

  const $ = cheerio.load(html);
  const items = [];
  $('div.serp-item, .Organic, .card, article, [data-cid], .organic').each((_, el) => {
    const a = $(el).find('a[href^="http"]').first();
    const href = a.attr('href');
    if (!href || href.includes('yandex.') || href.includes('ya.ru')) return;
    items.push({ url: href, title: $(el).find('h2, .organic__title').text().trim() || href });
  });

  const seen = new Set();
  return items.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
}

async function launchSession(proxy) {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
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
    await ctx.reply('❓ /run /stop_run /changeip /testproxy /queries /setquery N /auto_on /auto_off');
  }
});

bot.launch().then(() => {
  console.log('✅ Бот запущен (новый API + auto update key)');
  if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
});

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
