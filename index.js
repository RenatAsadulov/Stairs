import { Telegraf } from "telegraf";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Put it in .env");
  process.exit(1);
}

const pendingNumber = new Map();

const DATA_FILE = process.env.DATA_FILE || "./data/users.json";
const CHART_DAYS = Math.max(
  7,
  Math.min(365, Number(process.env.CHART_DAYS) || 30)
); // 7..365

await ensureDataFile(DATA_FILE);

const WIDTH = 1200;
const HEIGHT = 700;

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
 *   version: 2,
 *   season: number,
 *   announce: { pending: [telegramUserId] } // ще не отримали анонс сезону
 * }
 */
const SEASON = 2;
const SEASON_ANNOUNCE_TEXT =
  'Вітаю тебе у другому сезоні "Сходів". Цього разу ми йдемо на гору Фудзі, це всього ~1260 поверхів. Тож не зволікай, доєднуйся, буде багато цікавого!';
const SEASON_IMAGE = new URL("./assets/fuji.jpg", import.meta.url).pathname;
let seasonImageFileId = null; // після першого завантаження шлемо по file_id

let db = await readDbV2();

const bot = new Telegraf(BOT_TOKEN);
const awaitingName = new Set();

// ------- utils -------
const todayKey = () => new Date().toISOString().slice(0, 10);
const pad = (s, w) => (s.length >= w ? s : s + " ".repeat(w - s.length));

function escapeM2(s = "") {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

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

function colorFromSeed(seed) {
  // детерминированный «рандом» от userId
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // пастельные, но контрастные
  return `hsl(${hue}, 70%, 55%)`;
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

function makeLeaderboardText(users, meId) {
  if (users.length === 0)
    return "Ще немає даних. Додайте сходи командою /stairs <кількість>.";

  const sorted = [...users].sort((a, b) => b.total - a.total);
  const nameWidth = Math.max(4, ...sorted.map((u) => u.name.length));
  const totalWidth = Math.max(5, ...sorted.map((u) => String(u.total).length));

  const header = "🏆 Загальна статистика (усього)";
  const sep = "─".repeat(nameWidth + totalWidth + 10);

  const lines = [
    "```\n" + header,
    sep,
    `${pad("Імʼя", nameWidth)} | ${pad("Сходи", totalWidth)} | `,
    `${"─".repeat(nameWidth)}-+-${"─".repeat(totalWidth)}-+-`,
  ];

  for (const u of sorted) {
    const mark = u.id === meId ? "★" : " ";
    lines.push(
      `${pad(u.name, nameWidth)} | ${pad(
        String(u.total),
        totalWidth
      )} | ${mark}`
    );
  }

  const sum = sorted.reduce((acc, u) => acc + (u.total || 0), 0);
  lines.push(`${"-".repeat(nameWidth)}-+-${"-".repeat(totalWidth)}-+-`);
  lines.push(`${pad("Разом", nameWidth)} | ${pad(String(sum), totalWidth)} | `);
  lines.push("```");
  return lines.join("\n");
}

function makeLeaderboardTextMD(users, meId) {
  if (users.length === 0)
    return "Ще немає даних. Додайте сходи командою /stairs <кількість>.";
  const sorted = [...users].sort((a, b) => b.total - a.total);

  const lines = ["🏆 Загальна статистика (усього)"];
  for (const u of sorted) {
    const name = u.id === meId ? `*${escapeM2(u.name)}*` : escapeM2(u.name);
    lines.push(`${name} — ${u.total}`);
  }
  const sum = sorted.reduce((s, u) => s + (u.total || 0), 0);
  lines.push(`Разом — ${sum}`);
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

await startNewSeasonIfNeeded();

// ------- commands -------
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const existing = db.users[userId];
  if (existing?.name) {
    awaitingName.delete(userId);
    await ctx.reply(`👋 Вітаю знову, ${existing.name}!`, userKeyboard());
    return sendInfo(ctx);
  }
  awaitingName.add(userId);
  await sendSeasonPhoto(
    ctx.chat.id,
    'Вітаю тебе у другому сезоні "Сходів". Цього разу ми йдемо на гору Фудзі, це всього ~1260 поверхів. Тож не зволікай, доєднуйся, буде багато цікавого!\n\n' +
      "Введіть Ваше імʼя, щоб ми знали на якій висоті вас шукати. Нехай щасти!"
  );
});

// /join — реєстрація у новому сезоні (посилання з анонсу)
bot.command("join", (ctx) => joinSeason(ctx));

// кнопка "Долучитись" під анонсом
bot.action("join", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return joinSeason(ctx);
});

async function joinSeason(ctx) {
  const userId = String(ctx.from.id);
  const existing = db.users[userId];
  if (existing?.name) {
    awaitingName.delete(userId);
    await ctx.reply(`👋 Ви вже у челенджі, ${existing.name}!`, userKeyboard());
    return;
  }
  awaitingName.add(userId);
  await ctx.reply(
    "Введіть Ваше імʼя, щоб ми знали на якій висоті вас шукати. Нехай щасти!"
  );
}

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
});

// capture name after /start
bot.on("text", async (ctx, next) => {
  const userId = String(ctx.from.id);
  const msg = (ctx.message.text || "").trim();

  if (awaitingName.has(userId)) {
    // блокируем все команды, пока имя не указано
    if (msg.startsWith("/")) {
      await ctx.reply(
        'Спочатку введіть імʼя одним повідомленням (наприклад: "Ренат"). Команди поки недоступні.'
      );
      return;
    }

    if (msg.length < 2 || msg.length > 40) {
      await ctx.reply("Імʼя має бути від 2 до 40 символів. Спробуйте ще раз.");
      return;
    }

    const now = new Date().toISOString();
    db.users[userId] = db.users[userId] || {
      name: msg,
      total: 0,
      days: {},
      updatedAt: now,
    };
    db.users[userId].name = msg;
    db.users[userId].updatedAt = now;
    awaitingName.delete(userId);
    await saveDb();

    await ctx.reply(
      `✅ Дякую, ${msg}! Тепер вам доступні команди.`,
      userKeyboard()
    );
    await sendInfo(ctx);
    return; // имя обработали — дальше не идём
  }

  // если ждём число после кнопки
  if (pendingNumber.has(userId) && !msg.startsWith("/")) {
    const { mode } = pendingNumber.get(userId);
    pendingNumber.delete(userId);

    // валидация числа
    const n = Number(msg);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return ctx.reply("Потрібне додатне ціле число. Спробуйте ще раз.");
    }

    const iso = todayKey();
    db.users[userId] ||= {
      name: ctx.from.username || "Без імені",
      total: 0,
      days: {},
      updatedAt: new Date().toISOString(),
    };
    const u = db.users[userId];
    u.days ||= {};
    const todayVal = u.days[iso] || 0;

    if (mode === "add") {
      // как /stairs
      u.days[iso] = todayVal + n;
      u.total = Object.values(u.days).reduce((a, v) => a + (v || 0), 0);
      u.updatedAt = new Date().toISOString();
      await saveDb();
      return ctx.reply(
        `✅ Додано ${n}. За сьогодні: ${u.days[iso]} | Всього: ${u.total}`,
        userKeyboard()
      );
    } else {
      // sub: вычитаем только из СЕГОДНЯ, и не даём уйти в минус
      if (n > todayVal) {
        return ctx.reply(
          "Операція неможлива — за сьогодні менше сходів, ніж ви хочете відняти.",
          userKeyboard()
        );
      }
      u.days[iso] = todayVal - n; // может стать 0 — это ок
      u.total = Object.values(u.days).reduce((a, v) => a + (v || 0), 0);
      u.updatedAt = new Date().toISOString();
      await saveDb();
      return ctx.reply(
        `➖ Віднято ${n}. За сьогодні: ${u.days[iso]} | Всього: ${u.total}`,
        userKeyboard()
      );
    }
  }

  // если число не ожидали — передаём дальше (например, обработчик имени)
  return next();
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

// "+ Этаж" — просим число, потом добавим как /stairs
bot.hears("+ Поверх", async (ctx) => {
  if (!requireRegistered(ctx)) return;
  const userId = String(ctx.from.id);
  pendingNumber.set(userId, { mode: "add" });

  // Телеграм НЕ даёт включить «цифровую» клавиатуру программно,
  // но force_reply переносит фокус в поле ввода.
  await ctx.reply("➕", {
    reply_markup: { force_reply: true, input_field_placeholder: "Напр.: 120" },
  });
});

// "- Этаж" — просим число, потом вычтем из сегодняшнего дня
bot.hears("- Поверх", async (ctx) => {
  if (!requireRegistered(ctx)) return;
  const userId = String(ctx.from.id);
  pendingNumber.set(userId, { mode: "sub" });

  await ctx.reply("➖", {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: "Наприклад: 20",
    },
  });
});

// "Результат" — как /stat, но отправитель САМЫЙ ВВЕРХ и жирным
bot.hears("Результат", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  const meId = String(ctx.from.id);
  const users = listUsers();

  const text = makeLeaderboardText(users, meId);
  // переставим текущего пользователя наверх
  const me = users.find((u) => u.id === meId);
  const others = users.filter((u) => u.id !== meId);
  // сортируем остальных по total ↓
  others.sort((a, b) => b.total - a.total);
  const ordered = [me, ...others].filter(Boolean);

  // делаем «таблицу» и жирным только первую строку (MarkdownV2, без моноширинного блока)
  const rows = ordered.map((u, idx) => {
    const name = idx === 0 ? `*${escapeM2(u.name)}*` : escapeM2(u.name);
    return `${name} — ${u.total}`;
  });
  const table = `🏆 Загальна статистика (усього) \n` + rows.join("\n");

  try {
    await ctx.reply(text, { parse_mode: "MarkdownV2" }, userKeyboard());
  } catch {
    await ctx.reply(table, userKeyboard());
  }
});

// "По дням" — твой /list, но вызываем по кнопке
bot.hears("По дням", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  const userId = String(ctx.from.id);
  const u = db.users[userId];

  const entries = Object.entries(u.days || {}).sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  );
  if (entries.length === 0)
    return ctx.reply("Ще немає щоденних записів.", userKeyboard());

  const lines = ["Дата  ||  Кількість", "────────┆──────────"];
  for (const [iso, v] of entries) lines.push(`${formatDM(iso)}  ||  ${v || 0}`);

  // MarkdownV2 иногда «спотыкается» — отправим просто текстом
  await ctx.reply(lines.join("\n"), userKeyboard());
});

// lifecycle
bot.launch(() => console.log("Stairs bot is running with daily stats."));
sendSeasonAnnounce();

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

function userKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "+ Поверх" }, { text: "Результат" }],
        [{ text: "- Поверх" }, { text: "По дням" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Введіть команду або число…",
    },
  };
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

// Новий сезон: архівуємо стару базу, очищаємо користувачів
// і запамʼятовуємо, кому треба надіслати анонс.
async function startNewSeasonIfNeeded() {
  if ((db.season || 1) >= SEASON) return;

  const oldIds = Object.keys(db.users);
  const archive = DATA_FILE.replace(/\.json$/, "") + `.season${db.season || 1}.json`;
  await fsp.writeFile(archive, JSON.stringify(db, null, 2));

  const now = new Date().toISOString();
  db = {
    users: {},
    createdAt: now,
    updatedAt: now,
    version: 2,
    season: SEASON,
    announce: { pending: oldIds },
  };
  await saveDb();
  console.log(
    `Season ${SEASON} started. Old DB archived to ${archive}, ${oldIds.length} users to notify.`
  );
}

// Розсилка анонсу; кожного прибираємо з черги одразу після спроби,
// тож після перезапуску повторно ніхто не отримає повідомлення.
async function sendSeasonAnnounce() {
  const pending = db.announce?.pending || [];
  let sent = 0;
  while (pending.length) {
    const userId = pending[0];
    try {
      await sendSeasonPhoto(userId, SEASON_ANNOUNCE_TEXT, {
        reply_markup: {
          inline_keyboard: [[{ text: "Долучитись", callback_data: "join" }]],
        },
      });
      sent++;
    } catch (e) {
      if (e?.response?.error_code === 429) {
        const wait = (e.response.parameters?.retry_after || 5) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.error(`Announce to ${userId} failed:`, e?.description || e);
    }
    pending.shift();
    await saveDb();
    await new Promise((r) => setTimeout(r, 100));
  }
  if (sent) console.log(`Season announce sent to ${sent} users.`);
}

// Фото Фудзі з підписом
async function sendSeasonPhoto(chatId, caption, extra = {}) {
  const photo = seasonImageFileId || { source: SEASON_IMAGE };
  const msg = await bot.telegram.sendPhoto(chatId, photo, { caption, ...extra });
  seasonImageFileId ||= msg.photo?.at(-1)?.file_id || null;
  return msg;
}

async function sendInfo(ctx) {
  const text = "ℹ️ Вітаю! Час ходити сходами :)";
  return ctx.reply(text, { parse_mode: "Markdown" });
}
