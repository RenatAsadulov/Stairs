import { Telegraf } from "telegraf";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Put it in .env");
  process.exit(1);
}

const DATA_FILE = process.env.DATA_FILE || "./data/users.json";
const CHART_DAYS = Math.max(
  7,
  Math.min(365, Number(process.env.CHART_DAYS) || 30)
); // 7..365

await ensureDataFile(DATA_FILE);

const WIDTH = 1200;
const HEIGHT = 700;
const chartCanvas = new ChartJSNodeCanvas({
  width: WIDTH,
  height: HEIGHT,
  backgroundColour: "white",
});

/**
 * DB shape v2:
 * {
 *   users: {
 *     [telegramUserId]: {
 *       name: string,
 *       total: number,            // overall total
 *       days: { "YYYY-MM-DD": n}, // per-day totals
 *       updatedAt: ISOString
 *     }
 *   },
 *   createdAt: ISOString,
 *   updatedAt: ISOString,
 *   version: 2
 * }
 */
let db = await readDbV2();

const bot = new Telegraf(BOT_TOKEN);
const awaitingName = new Set();

// ------- utils -------
const todayKey = () => new Date().toISOString().slice(0, 10);
const pad = (s, w) => (s.length >= w ? s : s + " ".repeat(w - s.length));

let writeQueue = Promise.resolve();
function saveDb() {
  writeQueue = writeQueue
    .then(async () => {
      db.updatedAt = new Date().toISOString();
      const tmp = DATA_FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch((e) => console.error("Save error:", e));
  return writeQueue;
}

function isRegistered(userId) {
  return Boolean(db.users[userId]?.name);
}
function requireRegistered(ctx) {
  const userId = String(ctx.from.id);
  if (!isRegistered(userId)) {
    ctx.reply("Спочатку зареєструйтесь: натисніть /start і введіть своє імʼя.");
    return false;
  }
  return true;
}

function addStairs(userId, nameFallback, amount, dateKey = todayKey()) {
  const now = new Date().toISOString();
  if (!db.users[userId]) {
    db.users[userId] = {
      name: nameFallback || "Без імені",
      total: 0,
      days: {},
      updatedAt: now,
    };
  }
  const u = db.users[userId];
  u.total = (u.total || 0) + amount;
  u.days ||= {};
  u.days[dateKey] = (u.days[dateKey] || 0) + amount;
  u.updatedAt = now;
}

function listUsers() {
  return Object.entries(db.users).map(([id, u]) => ({ id, ...u }));
}

function makeLeaderboardText(users) {
  if (users.length === 0)
    return "Ще немає даних. Додайте сходи командою /stairs <кількість>.";

  const sorted = [...users].sort((a, b) => b.total - a.total);
  const nameWidth = Math.max(4, ...sorted.map((u) => u.name.length));
  const totalWidth = Math.max(5, ...sorted.map((u) => String(u.total).length));
  const header = "🏆 Загальна статистика (усього)";
  const sep = "─".repeat(nameWidth + totalWidth + 7);
  const lines = [
    "```\n" + header,
    sep,
    `${pad("Імʼя", nameWidth)} | ${pad("Сходи", totalWidth)}`,
    `${"─".repeat(nameWidth)}-+-${"─".repeat(totalWidth)}`,
  ];
  for (const u of sorted) {
    lines.push(
      `${pad(u.name, nameWidth)} | ${pad(String(u.total), totalWidth)}`
    );
  }
  const sum = sorted.reduce((acc, u) => acc + (u.total || 0), 0);
  lines.push(`${"-".repeat(nameWidth)}-+-${"-".repeat(totalWidth)}`);
  lines.push(`${pad("Разом", nameWidth)} | ${pad(String(sum), totalWidth)}`);
  lines.push("```");
  return lines.join("\n");
}

/** Build daily labels and per-user arrays for last N days (inclusive of today) */
function buildDailySeries(users, opts = {}) {
  const { startISO, endISO, lastNDays } = opts;

  let labels = [];
  if (startISO && endISO) {
    const start = toISODate(startISO);
    const end = toISODate(endISO);
    const len = daysBetweenInclusive(start, end);
    for (let i = 0; i < len; i++) labels.push(addDays(start, i));
  } else {
    const n = lastNDays ?? CHART_DAYS;
    const today = toISODate(new Date());
    for (let i = n - 1; i >= 0; i--) labels.push(addDays(today, -i));
  }

  const series = users.map((u) => labels.map((d) => u.days?.[d] || 0));
  return { labels, series };
}

function randomNiceColor(seed) {
  // small palette; stable by user id hash
  const palette = [
    "#4e79a7",
    "#f28e2b",
    "#e15759",
    "#76b7b2",
    "#59a14f",
    "#edc948",
    "#b07aa1",
    "#ff9da7",
    "#9c755f",
    "#bab0ab",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

async function renderChart(users, { startISO, endISO, lastNDays } = {}) {
  const { labels, series } = buildDailySeries(users, {
    startISO,
    endISO,
    lastNDays,
  });

  const datasets = users.map((u, idx) => ({
    label: u.name,
    data: series[idx],
    borderColor: randomNiceColor(u.id),
    backgroundColor: "rgba(0,0,0,0)",
    borderWidth: 3,
    tension: 0.35,
    pointRadius: 0,
  }));

  const titleText =
    startISO && endISO
      ? `Динаміка ${formatDM(startISO)}–${formatDM(endISO)}`
      : `Динаміка за ${lastNDays ?? CHART_DAYS} днів`;

  const configuration = {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            callback: (value, idx) => formatDM(labels[idx]),
          },
        },
        y: { beginAtZero: true, grid: { color: "#eee" } },
      },
      plugins: {
        legend: { position: "bottom" },
        title: { display: true, text: titleText },
      },
      animation: false,
    },
  };

  return chartCanvas.renderToBuffer(configuration, "image/png");
}

// ------- commands -------
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const existing = db.users[userId];
  if (existing?.name) {
    awaitingName.delete(userId);
    await ctx.reply(`👋 Вітаю знову, ${existing.name}!`);
    return sendInfo(ctx);
  }
  awaitingName.add(userId);
  await ctx.reply(
    "Привіт! Я бот для підрахунку сходів.\n" +
      'Напишіть, будь ласка, ваше імʼя одним повідомленням (наприклад: "Ренат"). ' +
      "Після цього стануть доступні команди."
  );
});

bot.command("info", (ctx) => sendInfo(ctx));

bot.command("stairs", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args)
    return ctx.reply(
      "Використання: /stairs <кількість>\nНаприклад: /stairs 120"
    );

  const n = Number(args);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return ctx.reply(
      "Будь ласка, вкажіть додатну цілу кількість сходів. Наприклад: /stairs 80"
    );
  }

  const userId = String(ctx.from.id);
  addStairs(userId, ctx.from.username, n);
  await saveDb();

  return ctx.reply(`✅ Додано ${n}. Ваш підсумок: ${db.users[userId].total}`);
});

bot.command("stat", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  // Parse optional dates: /stat YYYY-MM-DD YYYY-MM-DD
  const parts = ctx.message.text.trim().split(/\s+/);
  const argStart = parts[1];
  const argEnd = parts[2];

  // ENV fallbacks
  const envStart = process.env.CHART_START;
  const envEnd = process.env.CHART_END;

  // Validate YYYY-MM-DD
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const startISO = ISO_RE.test(argStart)
    ? argStart
    : ISO_RE.test(envStart)
    ? envStart
    : undefined;
  const endISO = ISO_RE.test(argEnd)
    ? argEnd
    : ISO_RE.test(envEnd)
    ? envEnd
    : undefined;

  // If only one of start/end is given, ignore both and fallback to lastNDays
  const useFixed = startISO && endISO;

  const users = listUsers();
  const text = makeLeaderboardText(users);
  await ctx.reply(text, { parse_mode: "MarkdownV2" }).catch(async () => {
    await ctx.reply(text.replace(/```/g, ""));
  });

  try {
    const png = await renderChart(
      users,
      useFixed ? { startISO, endISO } : { lastNDays: CHART_DAYS }
    );
    const caption = useFixed
      ? `Динаміка по днях (${formatDM(startISO)}–${formatDM(endISO)})`
      : `Динаміка по днях (останні ${CHART_DAYS} днів)`;
    await ctx.replyWithPhoto({ source: Buffer.from(png) }, { caption });
  } catch (e) {
    console.error("Chart render error:", e);
    await ctx.reply("Не вдалося згенерувати графік 😓");
  }
});

// capture name after /start
bot.on("text", async (ctx) => {
  console.log("TEXT");
  const userId = String(ctx.from.id);
  if (!awaitingName.has(userId)) return;

  const raw = (ctx.message.text || "").trim();
  if (raw.length < 2 || raw.length > 40) {
    return ctx.reply("Імʼя має бути від 2 до 40 символів. Спробуйте ще раз.");
  }
  db.users[userId] = {
    name: raw,
    total: 0,
    days: {},
    updatedAt: new Date().toISOString(),
  };
  awaitingName.delete(userId);
  await saveDb();
  await ctx.reply(`✅ Дякую, ${raw}! Тепер вам доступні команди.\n`);
  return sendInfo(ctx);
});

bot.command("/update", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  // Expect: /update <date> <amount>
  const parts = ctx.message.text.trim().split(/\s+/);
  const dateArg = parts[1];
  const amountArg = parts[2];

  if (!dateArg || !amountArg) {
    return ctx.reply(
      "Використання: /update <дата> <кількість>\n" +
        "Дата: YYYY-MM-DD або DD.MM\n" +
        "Кількість може бути відʼємною. Напр.: /update 27.10 -2"
    );
  }

  const iso = parseUserDate(dateArg);
  if (!iso)
    return ctx.reply("Невірний формат дати. Використайте YYYY-MM-DD або DD.MM");

  const n = Number(amountArg);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return ctx.reply("Кількість має бути цілим числом (можна відʼємним).");
  }

  const userId = String(ctx.from.id);
  const u = db.users[userId] || null;

  if (!u) {
    return ctx.reply("У вас ще немає записів. Додайте сходи командою /stairs.");
  }

  const current = u.days?.[iso] || 0;

  // Validate negatives: cannot reduce below zero and cannot subtract > current
  if (n < 0) {
    const take = Math.abs(n);
    if (current === 0) {
      return ctx.reply("На цю дату ще немає даних. Немає чого віднімати.");
    }
    if (take > current) {
      return ctx.reply("Не можна відняти більше ніж є :(");
    }
  }

  // Apply update
  const now = new Date().toISOString();
  u.days ||= {};
  u.days[iso] = current + n;

  // If day becomes 0, keep it as 0 (do NOT delete — history stays explicit)
  if (u.days[iso] < 0) u.days[iso] = 0; // guard, though we block this above

  // Update totals consistently
  u.total = Object.values(u.days).reduce((acc, v) => acc + (v || 0), 0);
  u.updatedAt = now;

  await saveDb();

  return ctx.reply(
    `Оновлено ${formatDM(iso)}: ${current} ${n >= 0 ? "+" : ""}${n} = ${
      u.days[iso]
    }.\n` + `Ваш загальний підсумок: ${u.total}`
  );
});

bot.command("/list", async (ctx) => {
  console.log("we here registred");
  if (!requireRegistered(ctx)) return;
  console.log("we didnt return");

  const userId = String(ctx.from.id);
  const u = db.users[userId];

  const entries = Object.entries(u.days || {});
  console.log(u.days, entries);
  if (entries.length === 0) {
    return ctx.reply(
      "Ще немає щоденних записів. Додайте сходи командою /stairs."
    );
  }

  // Sort by date ascending
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  // Build monospace table
  const name = u.name || "Ви";
  const nameLine = `Лічильник за днями — ${name}`;
  const rows = [];
  rows.push("```");
  rows.push(nameLine);
  rows.push("───────────────");
  rows.push("День   | Сходи");
  rows.push("───────+───────");

  let sum = 0;
  for (const [iso, val] of entries) {
    sum += val || 0;
    const dm = formatDM(iso); // DD.MM
    const v = String(val || 0).padStart(5, " ");
    rows.push(`${dm} | ${v}`);
  }
  rows.push("───────+───────");
  rows.push(`Разом  | ${String(sum).padStart(5, " ")}`);
  rows.push("```");

  // Telegram + MarkdownV2 can be picky; send as plain text if Markdown fails
  const text = rows.join("\n");
  try {
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  } catch {
    await replyChunked(ctx, text.replace(/```/g, "")); // fallback
  }
});

// lifecycle
bot.launch().then(() => console.log("Stairs bot is running with daily stats."));

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  try {
    await saveDb();
    await bot.stop(signal);
  } finally {
    process.exit(0);
  }
}

// ------- IO helpers -------
async function ensureDataFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    const now = new Date().toISOString();
    const empty = { users: {}, createdAt: now, updatedAt: now, version: 2 };
    await fsp.writeFile(filePath, JSON.stringify(empty, null, 2));
  }
}

function toISODate(d) {
  // d can be Date or string
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()))
    .toISOString()
    .slice(0, 10);
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function daysBetweenInclusive(startISO, endISO) {
  const start = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  return Math.max(0, Math.round((end - start) / 86400000)) + 1;
}
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DM_RE = /^\d{2}\.\d{2}$/; // DD.MM

function parseUserDate(s) {
  const str = (s || "").trim();
  if (ISO_RE.test(str)) return str; // already ISO

  if (DM_RE.test(str)) {
    const [d, m] = str.split(".").map(Number);
    const y = new Date().getFullYear(); // current year
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toISOString().slice(0, 10);
  }
  return null; // invalid
}

function formatDM(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}`;
}

// Split a long string into multiple messages (Telegram has limits)
async function replyChunked(ctx, text, chunkSize = 3800) {
  for (let i = 0; i < text.length; i += chunkSize) {
    await ctx.reply(text.slice(i, i + chunkSize));
  }
}

async function readDbV2() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);

    // Migrate from v1 (no per-day storage)
    if (!parsed.version) {
      for (const [id, u] of Object.entries(parsed.users || {})) {
        u.days = u.days || {};
        // we can’t reconstruct history; place their total into today so the chart has a point
        if ((u.total || 0) > 0 && Object.keys(u.days).length === 0) {
          u.days[todayKey()] = u.total;
        }
      }
      parsed.version = 2;
      parsed.updatedAt = new Date().toISOString();
      await fsp.writeFile(DATA_FILE, JSON.stringify(parsed, null, 2));
    }

    // defensive defaults
    parsed.users ||= {};
    parsed.createdAt ||= new Date().toISOString();
    parsed.updatedAt ||= new Date().toISOString();
    return parsed;
  } catch (e) {
    console.error("DB read failed, reinitializing:", e);
    const now = new Date().toISOString();
    const seed = { users: {}, createdAt: now, updatedAt: now, version: 2 };
    await fsp.writeFile(DATA_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

async function sendInfo(ctx) {
  const text =
    "ℹ️ Доступні команди:\n" +
    "• /start — почати роботу і вказати імʼя.\n" +
    "• /info — список команд і пояснення.\n" +
    "• /stairs <кількість> — додати кількість пройдених сходів **сьогодні**.\n" +
    `• /stat — показати таблицю загальних результатів та графік за останні ${CHART_DAYS} днів.\n\n` +
    "• /update <дата> <кількість> — змінити значення за день (можна віднімати, напр.: /update 27.10 -2)\n" +
    "• /list — показати ваші щоденні значення по датах\n" +
    "Примітка: бот зберігає дані **помесячно по днях** у локальному файлі JSON. Якщо потрібні окремі періоди або експорт — скажіть 😉";
  return ctx.reply(text, { parse_mode: "Markdown" });
}
