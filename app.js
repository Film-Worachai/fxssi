require("dotenv").config();

const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

// --- Configuration ---
const API_URL = "https://c.fxssi.com/api/current-ratios";
const BASE_INTERVAL_MS = 5 * 60 * 1000;
const RANDOM_VARIATION_MS = 1 * 60 * 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CONFIG_FILE_PATH = "./telegram_subscriber.json";
// --- End Configuration ---

let bot;
let subscribedChatId = null;
let previousSignals = {};
let lastSuccessfulResults = [];
let lastServerTimeText = "N/A";

function getEmojiForSignal(signal) {
  if (!signal) return "❔";
  switch (signal.toUpperCase()) {
    case "BUY":
      return "📈";
    case "SELL":
      return "📉";
    case "HOLD":
      return "⚖️";
    default:
      return "❔";
  }
}

function saveSubscribedChatId(chatId) {
  try {
    fs.writeFileSync(
      CONFIG_FILE_PATH,
      JSON.stringify({ subscribedChatId: chatId })
    );
    console.log(`Subscribed chat ID ${chatId} saved to ${CONFIG_FILE_PATH}`);
  } catch (err) {
    console.error("Error saving chat ID to file:", err);
  }
}

function loadSubscribedChatId() {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const data = fs.readFileSync(CONFIG_FILE_PATH, "utf8");
      const config = JSON.parse(data);
      if (config.subscribedChatId) {
        subscribedChatId = config.subscribedChatId;
        console.log(
          `Loaded subscribed chat ID ${subscribedChatId} from ${CONFIG_FILE_PATH}`
        );
      }
    } else {
      console.log(
        `Subscriber config file (${CONFIG_FILE_PATH}) not found. Awaiting /start command.`
      );
    }
  } catch (err) {
    console.error("Error loading chat ID from file:", err);
  }
}

if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log("Telegram Bot initialized and polling for messages.");
  loadSubscribedChatId();

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const oldSubscribedChatId = subscribedChatId;
    subscribedChatId = chatId;
    saveSubscribedChatId(chatId);

    const userName = msg.from.first_name || "User";
    let responseMessage = `สวัสดีครับคุณ ${userName}! คุณได้สมัครรับการแจ้งเตือน FXSSI signals แล้ว`;

    if (oldSubscribedChatId && oldSubscribedChatId !== chatId) {
      responseMessage += `\n(Chat ID ก่อนหน้า: ${oldSubscribedChatId} จะไม่ได้รับการแจ้งเตือนแล้ว)`;
    }
    responseMessage += `\nผมจะส่งสรุปสัญญาณปัจจุบันให้ (หากมีข้อมูล) และจะแจ้งเตือนเมื่อมีการเปลี่ยนแปลงสำคัญครับ`;
    bot.sendMessage(chatId, responseMessage);
    console.log(
      `User ${userName} (Chat ID: ${chatId}) subscribed via /start command.`
    );

    if (lastSuccessfulResults.length > 0 && subscribedChatId) {
      console.log(
        "Sending current signals snapshot to newly subscribed user..."
      );
      sendInitialSignalsSnapshot(
        lastSuccessfulResults,
        `📊 สรุป Sentiment FXSSI (หลัง /start)`,
        lastServerTimeText
      );
    }
  });

  bot.on("polling_error", (error) => {
    console.error(
      `Telegram polling error: ${error.code} - ${
        error.message ? error.message.substring(0, 150) : "(No message)"
      }`
    );
  });
} else {
  console.error(
    "CRITICAL ERROR: TELEGRAM_BOT_TOKEN is not set. Please create a .env file or set it as an environment variable."
  );
}

async function sendTelegramNotification(message, isSnapshot = false) {
  if (!bot || !subscribedChatId) return;
  try {
    let finalMessage = message;
    if (!isSnapshot) {
      const timeString =
        lastServerTimeText !== "N/A"
          ? lastServerTimeText.split(" ")[1]
          : new Date().toLocaleTimeString("th-TH", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
      finalMessage += `\n_(ข้อมูล Server ณ: ${timeString})_`;
    }
    // ใช้ parse_mode: 'MarkdownV2' จะดีกว่าสำหรับการ escape ตัวอักษรพิเศษ แต่ต้องระวังการ escape ให้ถูกต้อง
    // สำหรับการ padding แบบง่ายๆ Markdown (default) ก็พอใช้ได้
    await bot.sendMessage(subscribedChatId, finalMessage, {
      parse_mode: "Markdown",
    });
    const firstLine = message.split("\n")[0];
    console.log(
      `Telegram notification sent to Chat ID ${subscribedChatId}: "${firstLine}"`
    );
  } catch (error) {
    handleTelegramSendError(error);
  }
}

// ฟังก์ชันสำหรับ padding string ด้านขวา
function padRight(str, length, char = " ") {
  return str + char.repeat(Math.max(0, length - str.length));
}
// ฟังก์ชันสำหรับ padding string ด้านซ้าย
function padLeft(str, length, char = " ") {
  return char.repeat(Math.max(0, length - str.length)) + str;
}

// ปรับปรุงฟังก์ชันสำหรับส่ง snapshot ของ signals ทั้งหมด
async function sendInitialSignalsSnapshot(signalsArray, title, serverTimeText) {
  if (!bot || !subscribedChatId) return;

  if (!signalsArray || signalsArray.length === 0) {
    await sendTelegramNotification(
      `*${title}*\n\nไม่มีข้อมูลสัญญาณในขณะนี้`,
      true
    );
    return;
  }

  let message = `*${title}*\n\n`;
  if (serverTimeText && serverTimeText !== "N/A") {
    message += `_ข้อมูล ณ ${serverTimeText} (Server Time)_\n\n`;
  } else {
    const now = new Date();
    const dateString = now.toLocaleDateString("th-TH", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeString = now.toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
    });
    message += `_ข้อมูล ณ วันที่ ${dateString} เวลา ${timeString} (Local Time)_\n\n`;
  }

  // ใช้ `<code>` block เพื่อให้ spacing มีผลมากขึ้น (monospaced font)
  message += "```\n"; // เริ่ม code block

  // หาความยาวสูงสุดของชื่อ symbol เพื่อใช้ในการ padding
  const maxSymbolLength = Math.max(
    ...signalsArray.map((s) => s.symbol.length),
    7
  ); // 7 คือ EUR/USD

  signalsArray.forEach((s) => {
    const buyVal = s.buyPercentage.toFixed(2);
    const sellVal = (100 - s.buyPercentage).toFixed(2);

    // จัดรูปแบบ: [Emoji] Symbol (B: xx.xx | S: yy.yy)
    const symbolPadded = padRight(s.symbol, maxSymbolLength);
    const buyStr = padLeft(buyVal, 5); // "xx.xx" -> 5 chars
    const sellStr = padLeft(sellVal, 5);

    // \u2003 คือ em-space ซึ่งกว้างกว่า space ปกติ อาจช่วยจัดคอลัมน์ได้ดีขึ้นเล็กน้อย
    // หรือใช้ space ธรรมดาก็ได้
    const space = " "; // หรือ "\u2003"

    message += `${getEmojiForSignal(
      s.overallSignal
    )} ${symbolPadded}${space}(B:${buyStr} | S:${sellStr})\n`;
  });
  message += "```\n"; // จบ code block

  if (message.length > 4000) {
    // ตรวจสอบความยาวอีกครั้งหลังจัดรูปแบบ
    message =
      `*${title}*\n\nรายการสัญญาณยาวเกินกว่าจะแสดงในข้อความเดียว.\n` +
      `กรุณาตรวจสอบ Console log สำหรับรายละเอียดทั้งหมด.\n`;
    if (serverTimeText && serverTimeText !== "N/A") {
      message += `_ข้อมูล ณ ${serverTimeText} (Server Time)_`;
    }
  }

  await sendTelegramNotification(message.trim(), true);
}

function handleTelegramSendError(error) {
  if (
    error.response &&
    (error.response.statusCode === 403 ||
      (error.response.body && error.response.body.error_code === 403))
  ) {
    console.warn(
      `Failed to send Telegram notification to ${subscribedChatId}: Bot was blocked or kicked. Resetting subscription.`
    );
    subscribedChatId = null;
    try {
      if (fs.existsSync(CONFIG_FILE_PATH)) {
        fs.unlinkSync(CONFIG_FILE_PATH);
        console.log(`Removed ${CONFIG_FILE_PATH} due to send error.`);
      }
    } catch (e) {
      console.error("Error deleting subscriber config file:", e);
    }
  } else {
    const errMsg = error.response
      ? error.response.data
        ? error.response.data.description
        : error.message
      : error.message;
    console.error(
      `Failed to send Telegram notification to ${subscribedChatId}:`,
      errMsg
    );
  }
}

async function fetchDataAndProcess() {
  const fetchTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
  });
  console.log(`\n[${fetchTime}] Fetching new data from FXSSI...`);
  try {
    const response = await axios.get(API_URL);
    const jsonData = response.data;

    if (jsonData && jsonData.pairs) {
      lastServerTimeText = jsonData.server_time_text || "N/A";
      console.log(`Data fetched. Server time: ${lastServerTimeText}`);

      const currentRunResults = [];
      for (const pairSymbol in jsonData.pairs) {
        if (jsonData.pairs.hasOwnProperty(pairSymbol)) {
          const pairData = jsonData.pairs[pairSymbol];
          if (pairData && pairData.hasOwnProperty("average")) {
            const buyPercentage = parseFloat(pairData.average);
            if (isNaN(buyPercentage)) continue;

            let overallSignal = "HOLD";
            // Contrarian interpretation (เหมือนเดิม)
            if (buyPercentage > 55) overallSignal = "SELL";
            else if (buyPercentage < 45) overallSignal = "BUY";

            currentRunResults.push({
              symbol: pairSymbol,
              buyPercentage: buyPercentage,
              overallSignal: overallSignal,
            });
          }
        }
      }

      currentRunResults.sort((a, b) => b.buyPercentage - a.buyPercentage);
      lastSuccessfulResults = [...currentRunResults];

      console.log("--- Current Data (Sorted by Buy % High to Low) ---");
      const maxSymbolLengthConsole = Math.max(
        ...currentRunResults.map((s) => s.symbol.length),
        7
      );
      currentRunResults.forEach((result) => {
        const buyStr = result.buyPercentage.toFixed(2);
        const sellStr = (100 - result.buyPercentage).toFixed(2);
        const symbolPadded = padRight(result.symbol, maxSymbolLengthConsole);
        console.log(
          `${getEmojiForSignal(
            result.overallSignal
          )} ${symbolPadded} (B: ${padLeft(buyStr, 5)} | S: ${padLeft(
            sellStr,
            5
          )}) -> Signal: ${result.overallSignal}`
        );
      });
      console.log("--- End of Current Data ---");

      const isFirstRunPopulatingSignals =
        Object.keys(previousSignals).length === 0;

      if (
        isFirstRunPopulatingSignals &&
        subscribedChatId &&
        currentRunResults.length > 0
      ) {
        console.log(
          "First successful data fetch. Sending initial signals snapshot..."
        );
        await sendInitialSignalsSnapshot(
          currentRunResults,
          "📊 สรุป Sentiment FXSSI เริ่มต้น",
          lastServerTimeText
        );
      }

      let changesDetectedThisRun = 0;
      if (!isFirstRunPopulatingSignals) {
        currentRunResults.forEach((result) => {
          const lastOverallSignal = previousSignals[result.symbol];
          const currentOverallSignal = result.overallSignal;

          if (
            lastOverallSignal !== undefined &&
            currentOverallSignal !== lastOverallSignal &&
            currentOverallSignal !== "HOLD"
          ) {
            changesDetectedThisRun++;
            const buyP = result.buyPercentage.toFixed(2);
            const sellP = (100 - result.buyPercentage).toFixed(2);
            const message =
              `🔔 *${result.symbol} เปลี่ยนแปลงสัญญาณ!* ${getEmojiForSignal(
                currentOverallSignal
              )}\n` +
              `   จาก: \`${lastOverallSignal}\`  เป็น: \`${currentOverallSignal}\`\n` +
              `   Sentiment: (B: ${buyP} | S: ${sellP})`;
            sendTelegramNotification(message);
          }
        });
      }

      const newPreviousSignals = {};
      currentRunResults.forEach((result) => {
        newPreviousSignals[result.symbol] = result.overallSignal;
      });
      previousSignals = newPreviousSignals;

      if (isFirstRunPopulatingSignals && currentRunResults.length > 0) {
        console.log(
          "Initial signal data populated and snapshot sent. Monitoring for changes."
        );
      } else if (changesDetectedThisRun === 0 && !isFirstRunPopulatingSignals) {
        console.log(
          "No significant overall signal changes (to BUY/SELL) detected in this run."
        );
      } else if (currentRunResults.length === 0) {
        console.log(
          "No currency pair data found in the API response this run."
        );
      }
    } else {
      console.log("Could not find 'pairs' data in the FXSSI response.");
      lastServerTimeText = "N/A (API error)";
    }
  } catch (error) {
    console.error("Error during data fetch or processing:", error.message);
    lastServerTimeText = "N/A (Fetch error)";
    if (error.response)
      console.error("API Response Status:", error.response.status);
    else if (error.request)
      console.error("No response received from API:", error.request);
  } finally {
    const randomOffset =
      Math.random() * 2 * RANDOM_VARIATION_MS - RANDOM_VARIATION_MS;
    const nextInterval = BASE_INTERVAL_MS + randomOffset;

    console.log(
      `Next data fetch scheduled in approximately ${(
        nextInterval / 60000
      ).toFixed(2)} minutes.`
    );
    setTimeout(fetchDataAndProcess, nextInterval);
  }
}

// --- Initialization ---
console.log("Initializing FXSSI Signal Monitor...");
if (bot) {
  if (!subscribedChatId) {
    console.log(
      "To receive Telegram notifications, send the /start command to your bot on Telegram."
    );
  } else {
    console.log(
      `Currently subscribed to send notifications to Chat ID: ${subscribedChatId}. Awaiting first data fetch...`
    );
  }
} else {
  console.log(
    "Telegram bot is not properly configured (TELEGRAM_BOT_TOKEN missing). No Telegram notifications will be sent."
  );
}

if (TELEGRAM_BOT_TOKEN) {
  fetchDataAndProcess();
  console.log("FXSSI Signal Monitor is running. Press Ctrl+C to stop.");
} else {
  console.error(
    "FXSSI Signal Monitor cannot start without TELEGRAM_BOT_TOKEN."
  );
}
