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

const
