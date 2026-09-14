import { Telegraf } from 'telegraf';
import { chromium, devices } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ОШИБКА: Не задан BOT_TOKEN');
  process.exit(1);
}

function parseProxyList() {
  const list = [];
  if (process.env.PROXY_LIST) {
    const lines = process.env.PROXY_LIST.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split('|').map((s) => s.trim());
      if (!parts[0]) continue;
      list.push({
        server: parts[0],
        username: parts[1] || undefined,
        password: parts[2] || undefined,
      });
    }
  }
  if (!list.length && process.env.PROXY_SERVER) {
    list.push({
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USER || undefined,
      password: process.env.PROXY_PASS || undefined,
    });
  }
  return list;
}

const PROXIES = parseProxyList();
console.log(`[init] Прокси: ${PROXIES.length}`);
PROXIES.forEach((p, i) => console.log(`  #${i + 1}: ${p.server}`));

function randomProxy(exclude = null) {
  if (!PROXIES.length) return null;
  const available = PROXIES.filter((p) => p.server !== exclude);
  const pool = available.length ? available : PROXIES;
  return pool[Math.floor(Math.random() * pool.length)];
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
    `*Автопрогон:* /auto_on, /auto_off, /auto_status\n\n` +
    `*Диагностика:* /testproxy\n\n` +
    `Прокси: ${PROXIES.length}\n` +
    `Фраза: ${currentQuery || '—'}\n` +
    `Стоп-домены (${stopDomains.size}): ${[...stopDomains].join(', ')}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Расширенный тест прокси ────────────────────────────────────────────────
bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Проверяю прокси на разных сайтах...');

  if (!PROXIES.length) return ctx.reply('❌ Прокси не заданы.');

  const proxy = PROXIES[0];
  const sites = [
    'https://api.ipify.org?format=json',
    'https://2ip.ru/',
    'https://ya.ru/',
    'https://yandex.ru/',
  ];

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    const lines = [`Прокси: ${proxy.server}`, ''];

    for (const url of sites) {
      const t0 = Date.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const title = await page.title().catch(() => '');
        lines.push(`✅ ${url} — OK (${Date.now() - t0}ms) ${title.slice(0, 40)}`);
      } catch (err) {
        const msg = err.message.split('\n')[0].slice(0, 90);
        lines.push(`❌ ${url} — ${msg}`);
      }
    }

    await ctx.reply(lines.join('\n'));
  } catch (err) {
    await ctx.reply(`❌ Ошибка запуска браузера:\n${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
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
  const searchSession = await launchSession(searchProxy);
  let results = [];
  try {
    results = await searchYandex(searchSession.page, query, ctx);
  } catch (err) {
    await searchSession.browser.close();
    throw err;
  }
  if (!results.length) {
    await searchSession.browser.close();
    return '⚠️ Пусто.';
  }
  await ctx.reply(`📋 ${results.length} результатов.`);
  await searchSession.browser.close();

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
    await sleep(2000 + Math.random() * 3000);
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
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

// ─── Поиск в Яндексе (с fallback ya.ru → yandex.ru) ─────────────────────────
async function searchYandex(page, query, ctx) {
  let loaded = false;

  // Пробуем сначала ya.ru
  for (const url of ['https://ya.ru', 'https://yandex.ru']) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      loaded = true;
      console.log(`[searchYandex] Открыл ${url}`);
      break;
    } catch (err) {
      console.warn(`[searchYandex] ${url} не открылся: ${err.message.split('\n')[0]}`);
      await ctx.reply(`⚠️ ${url} — не открылся, пробую другой домен...`);
    }
  }

  if (!loaded) {
    throw new Error('Ни ya.ru, ни yandex.ru не открылись через прокси');
  }

  if (await isCaptcha(page)) {
    await ctx.reply('🛑 Капча на главной.');
    throw new Error('Captcha');
  }

  const input = page.locator('input[name="text"], input#text, textarea[name="text"]').first();
  await input.waitFor({ timeout: 15000 });
  await input.fill(query);
  await sleep(400 + Math.random() * 600);

  const btn = page.locator('button[type="submit"], button:has-text("Найти")').first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
  else await input.press('Enter');

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await sleep(2000);

  if (await isCaptcha(page)) {
    await ctx.reply('🛑 Капча после поиска.');
    throw new Error('Captcha2');
  }

  return await page.evaluate(() => {
    const items = [];
    const nodes = document.querySelectorAll('li.serp-item, div[data-fast-name="organic"], article[data-fast-name="organic"]');
    nodes.forEach((node) => {
      const link = node.querySelector('a.OrganicTitle-Link, a[href^="http"]');
      const title = node.querySelector('h2, .OrganicTitle')?.innerText?.trim();
      if (link?.href && !link.href.includes('yandex.ru') && !link.href.includes('ya.ru')) {
        items.push({ url: link.href, title: title || link.href });
      }
    });
    const seen = new Set();
    return items.filter((i) => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
  });
}

async function visitSite(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500 + Math.random() * 1000);
  const duration = 10000 + Math.random() * 5000;
  const t0 = Date.now();
  while (Date.now() - t0 < duration) {
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), 200 + Math.random() * 300);
    await sleep(500 + Math.random() * 800);
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

async function isCaptcha(page) {
  try {
    const sels = ['div.CheckboxCaptcha', 'form[action*="captcha"]', 'div[class*="SmartCaptcha"]', 'iframe[src*="captcha"]', '.captcha', '#captcha'];
    for (const s of sels) {
      if (await page.locator(s).first().isVisible({ timeout: 800 }).catch(() => false)) return true;
    }
    const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (/подтвердите|я не робот|captcha/i.test(body)) return true;
  } catch {}
  return false;
}

bot.launch()
  .then(() => {
    console.log('✅ Бот запущен');
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
