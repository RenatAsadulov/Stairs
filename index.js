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

const DATA_FILE = process.env.DATA_FILE || "./data/users.json";
await ensureDataFile(DATA_FILE);

const bot = new Telegraf(BOT_TOKEN);

// ---- In-memory helpers ----
/**
 * Structure of file:
 * {
 *   users: {
 *     [telegramUserId]: { name: string, total: number, updatedAt: ISOString }
 *   },
 *   createdAt: ISOString,
 *   updatedAt: ISOString
 * }
 */
let db = await readDb();

// Track users who must provide a name after /start
const awaitingName = new Set();

/** Simple atomic write queue to avoid concurrent writes */
let writeQueue = Promise.resolve();
function saveDb() {
  writeQueue = writeQueue
    .then(async () => {
      db.updatedAt = new Date().toISOString();
      const tmp = DATA_FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch((e) => {
      console.error("Save error:", e);
    });
  return writeQueue;
}

function getUserRecord(userId) {
  return db.users[userId] || null;
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

/** Format a monospace leaderboard */
function formatStats(users) {
  if (users.length === 0)
    return "Ще немає даних. Додайте сходи командою /stairs <кількість>.";

  // Sort by total desc
  const sorted = [...users].sort((a, b) => b.total - a.total);

  // Compute padding
  const nameWidth = Math.max(4, ...sorted.map((u) => u.name.length));
  const totalWidth = Math.max(5, ...sorted.map((u) => String(u.total).length));

  const header = `🏆 Статистика`;
  const sep = "─".repeat(nameWidth + totalWidth + 7);
  const lines = [
    "```\n" + header,
    sep,
    `${pad("Імʼя", nameWidth)} | ${pad("Сходи", totalWidth)}`,
    `${"─".repeat(nameWidth)}-+-${"─".repeat(totalWidth)}`,
  ];

  sorted.forEach((u) => {
    lines.push(
      `${pad(u.name, nameWidth)} | ${pad(String(u.total), totalWidth)}`
    );
  });

  const sum = sorted.reduce((acc, u) => acc + u.total, 0);
  lines.push(`${"-".repeat(nameWidth)}-+-${"-".repeat(totalWidth)}`);
  lines.push(`${pad("Разом", nameWidth)} | ${pad(String(sum), totalWidth)}`);
  lines.push("```");

  return lines.join("\n");
}

function pad(s, width) {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// ---- Commands ----

bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const existing = getUserRecord(userId);

  if (existing?.name) {
    awaitingName.delete(userId);
    await ctx.reply(`👋 Вітаю знову, ${existing.name}!`);
    return sendInfo(ctx);
  }

  // Mark user as awaiting their name
  awaitingName.add(userId);
  await ctx.reply(
    "Привіт! Я бот для підрахунку сходів.\n" +
      'Напишіть, будь ласка, ваше імʼя одним повідомленням (наприклад: "Вадим"). ' +
      "Після цього стануть доступні команди."
  );
});

bot.command("info", (ctx) => sendInfo(ctx));

bot.command("stairs", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) {
    return ctx.reply(
      "Використання: /stairs <кількість>\nНаприклад: /stairs 120"
    );
  }

  // Accept integers only; positive
  const n = Number(args);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return ctx.reply(
      "Будь ласка, вкажіть додатну цілу кількість сходів. Наприклад: /stairs 80"
    );
  }

  const userId = String(ctx.from.id);
  const now = new Date().toISOString();

  if (!db.users[userId]) {
    db.users[userId] = {
      name: ctx.from.username || "Без імені",
      total: 0,
      updatedAt: now,
    };
  }

  db.users[userId].total = (db.users[userId].total || 0) + n;
  db.users[userId].updatedAt = now;

  await saveDb();

  await ctx.reply(`✅ Додано ${n}. Ваш підсумок: ${db.users[userId].total}`);
});

bot.command("stat", async (ctx) => {
  if (!requireRegistered(ctx)) return;

  const users = Object.entries(db.users).map(([id, u]) => ({ id, ...u }));
  await ctx
    .reply(formatStats(users), { parse_mode: "MarkdownV2" })
    .catch(async () => {
      // fallback to no formatting if Markdown parsing fails for some reason
      await ctx.reply(formatStats(users).replace(/```/g, ""));
    });
});

// ---- Handle plain messages: capture a name when waiting for it ----
bot.on("text", async (ctx) => {
  const userId = String(ctx.from.id);
  if (!awaitingName.has(userId)) return; // Not awaiting a name

  const raw = (ctx.message.text || "").trim();
  // Basic validation
  if (raw.length < 2 || raw.length > 40) {
    return ctx.reply("Імʼя має бути від 2 до 40 символів. Спробуйте ще раз.");
  }

  // Save user
  const now = new Date().toISOString();
  db.users[userId] = { name: raw, total: 0, updatedAt: now };
  awaitingName.delete(userId);
  await saveDb();

  await ctx.reply(`✅ Дякую, ${raw}! Тепер вам доступні команди.\n`);
  return sendInfo(ctx);
});

// ---- Launch & graceful shutdown ----
bot.launch().then(() => {
  console.log("Stairs bot is running.");
});

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

// ---- Utilities ----

async function ensureDataFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    const now = new Date().toISOString();
    const empty = { users: {}, createdAt: now, updatedAt: now };
    await fsp.writeFile(filePath, JSON.stringify(empty, null, 2));
  }
}

async function readDb() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    // Defensive defaults
    parsed.users ||= {};
    parsed.createdAt ||= new Date().toISOString();
    parsed.updatedAt ||= new Date().toISOString();
    return parsed;
  } catch (e) {
    console.error("DB read failed, reinitializing:", e);
    const now = new Date().toISOString();
    const seed = { users: {}, createdAt: now, updatedAt: now };
    await fsp.writeFile(DATA_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

async function sendInfo(ctx) {
  const text =
    "ℹ️ Доступні команди:\n" +
    "• /info — список команд і пояснення.\n" +
    "• /stairs <кількість> — додати кількість пройдених сходів до вашого лічильника. Наприклад: /stairs 120\n" +
    "• /stat — показати загальну статистику (лідерборд) по всіх користувачах.\n\n" +
    "Порада: додавайте сходи відразу після тренування, щоб не забути 😉";
  return ctx.reply(text);
}
