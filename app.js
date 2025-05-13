require("dotenv").config();

const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express"); // เพิ่ม Express

// --- Configuration ---
const API_URL_FXSSI = "https://c.fxssi.com/api/current-ratios";
const BASE_INTERVAL_MS = 5 * 60 * 1000;
const RANDOM_VARIATION_MS = 1 * 60 * 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CONFIG_FILE_PATH = "./telegram_subscriber.json";
const WEBHOOK_PORT = process.env.PORT || 80; // Port สำหรับ Express Webhook
// --- End Configuration ---

let bot;
let subscribedChatId = null;
let previousSignals = {};
let lastSuccessfulResults = [];
let lastServerTimeText = "N/A";
let previousXauUsdSpecialSignal = null; // <<-- เพิ่มตัวแปรสำหรับสัญญาณพิเศษ XAUUSD

// --- Express App Setup ---
const app = express();
app.use(express.text({ type: "*/*" }));

app.post("/tw", (req, res) => {
  const webhookData = req.body;
  console.log(`[${new Date().toLocaleString()}] Received Webhook on /tw:`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", webhookData);
  res.status(200).send("Webhook processed successfully by Express server.");
  if (subscribedChatId && bot) {
    const telegramMessage =
      `🔔 *TradingView Webhook Received!*\n\n` +
      `\`\`\`\n${webhookData}\n\`\`\`\n` +
      `_(Source: /tw endpoint)_`;
    sendTelegramNotification(telegramMessage, true);
  }
});

app.get("/", (req, res) => {
  res.send("FXSSI Telegram Bot with TradingView Webhook is running!");
});
// --- End Express App Setup ---

function getEmojiForSignal(signal) {
  if (!signal) return "❔";
  const upperSignal = signal.toUpperCase();
  // <<-- เพิ่มการจัดการสำหรับสัญญาณทองคำพิเศษ
  if (upperSignal.includes("BUY GOLD")) return "📈";
  if (upperSignal.includes("SELL GOLD")) return "📉";
  if (upperSignal.includes("HOLD GOLD")) return "⚖️";
  // -->>
  switch (upperSignal) {
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
    let responseMessage = `สวัสดีครับคุณ ${userName}! คุณได้สมัครรับการแจ้งเตือน FXSSI signals และ TradingView Webhooks แล้ว`;

    if (oldSubscribedChatId && oldSubscribedChatId !== chatId) {
      responseMessage += `\n(Chat ID ก่อนหน้า: ${oldSubscribedChatId} จะไม่ได้รับการแจ้งเตือนแล้ว)`;
    }
    responseMessage += `\nผมจะส่งสรุปสัญญาณปัจจุบันให้ (หากมีข้อมูล) และจะแจ้งเตือนเมื่อมีการเปลี่ยนแปลงสำคัญครับ`;
    // bot.sendMessage(chatId, responseMessage);
    console.log(
      `User ${userName} (Chat ID: ${chatId}) subscribed via /start command.`
    );

    if (lastSuccessfulResults.length > 0 && subscribedChatId) {
      console.log(
        "Sending current FXSSI signals snapshot to newly subscribed user..."
      );
      sendInitialSignalsSnapshot(
        lastSuccessfulResults,
        `📊 สรุป Sentiment FXSSI (หลัง /start)`,
        lastServerTimeText
      );
    }
    // <<-- อาจจะส่งสถานะสัญญาณ XAUUSD พิเศษปัจจุบันให้ด้วยถ้าต้องการ
    if (previousXauUsdSpecialSignal && subscribedChatId) {
      const xauAvg =
        jsonDataCacheForStartup && jsonDataCacheForStartup.pairs.XAUUSD
          ? parseFloat(jsonDataCacheForStartup.pairs.XAUUSD.average).toFixed(2)
          : "N/A";
      const usdxAvg =
        jsonDataCacheForStartup && jsonDataCacheForStartup.pairs.USDX
          ? parseFloat(jsonDataCacheForStartup.pairs.USDX.average).toFixed(2)
          : "N/A";
      const specialXauMessage =
        `*สถานะสัญญาณทองคำพิเศษ (XAUUSD vs USDX) ปัจจุบัน:*\n` +
        `${getEmojiForSignal(
          previousXauUsdSpecialSignal
        )} \`${previousXauUsdSpecialSignal}\`\n` +
        `   XAUUSD avg: ${xauAvg}%\n` +
        `   USDX avg: ${usdxAvg}%`;
      sendTelegramNotification(specialXauMessage, true);
    }
    // -->>
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

async function sendTelegramNotification(message, isSpecialMessage = false) {
  if (!bot || !subscribedChatId) return;
  try {
    let finalMessage = message;
    if (!isSpecialMessage) {
      const timeString =
        lastServerTimeText !== "N/A" && lastServerTimeText.includes(" ")
          ? lastServerTimeText.split(" ")[1]
          : new Date().toLocaleTimeString("th-TH", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
      finalMessage += `\n_(ข้อมูล Server FXSSI ณ: ${timeString})_`;
    }
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

function padRight(str, length, char = " ") {
  return str + char.repeat(Math.max(0, length - str.length));
}
function padLeft(str, length, char = " ") {
  return char.repeat(Math.max(0, length - str.length)) + str;
}

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
    message += `_ข้อมูล ณ ${now.toLocaleDateString(
      "th-TH"
    )} ${now.toLocaleTimeString("th-TH")} (Local Time)_\n\n`;
  }
  message += "```\n";
  const maxSymbolLength = Math.max(
    ...signalsArray.map((s) => s.symbol.length),
    7
  );
  signalsArray.forEach((s) => {
    const buyVal = s.buyPercentage.toFixed(2);
    const sellVal = (100 - s.buyPercentage).toFixed(2);
    const symbolPadded = padRight(s.symbol, maxSymbolLength);
    const buyStr = padLeft(buyVal, 5);
    const sellStr = padLeft(sellVal, 5);
    message += `${getEmojiForSignal(
      s.overallSignal
    )} ${symbolPadded} (B:${buyStr} | S:${sellStr})\n`;
  });
  message += "```\n";
  if (message.length > 4000) {
    message = `*${title}*\n\nรายการสัญญาณยาวเกินไป.\n`;
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
      if (fs.existsSync(CONFIG_FILE_PATH)) fs.unlinkSync(CONFIG_FILE_PATH);
    } catch (e) {
      console.error("Error deleting subscriber config file:", e);
    }
  } else {
    console.error(
      `Failed to send Telegram notification to ${subscribedChatId}:`,
      error.message
    );
  }
}

let jsonDataCacheForStartup = null; // <<-- Cache jsonData for /start if needed

async function fetchDataAndProcessFxssi() {
  const fetchTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
  });
  console.log(`\n[${fetchTime}] Fetching new data from FXSSI...`);
  try {
    const response = await axios.get(API_URL_FXSSI);
    const jsonData = response.data;
    jsonDataCacheForStartup = jsonData; // <<-- Cache for /start command

    if (jsonData && jsonData.pairs) {
      lastServerTimeText = jsonData.server_time_text || "N/A";
      console.log(`FXSSI Data fetched. Server time: ${lastServerTimeText}`);
      const currentRunResults = [];

      // --- Process General Signals (เดิม) ---
      for (const pairSymbol in jsonData.pairs) {
        if (jsonData.pairs.hasOwnProperty(pairSymbol)) {
          const pairData = jsonData.pairs[pairSymbol];
          if (pairData && pairData.hasOwnProperty("average")) {
            const buyPercentage = parseFloat(pairData.average);
            if (isNaN(buyPercentage)) continue;
            let overallSignal = "HOLD";
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

      const isFirstRunPopulatingGeneralSignals =
        Object.keys(previousSignals).length === 0;
      if (
        isFirstRunPopulatingGeneralSignals &&
        subscribedChatId &&
        currentRunResults.length > 0
      ) {
        console.log(
          "First successful FXSSI data fetch. Sending initial general signals snapshot..."
        );
        await sendInitialSignalsSnapshot(
          currentRunResults,
          "📊 สรุป Sentiment FXSSI เริ่มต้น",
          lastServerTimeText
        );
      }

      let generalChangesDetected = 0;
      if (!isFirstRunPopulatingGeneralSignals) {
        currentRunResults.forEach((result) => {
          const lastOverallSignal = previousSignals[result.symbol];
          const currentOverallSignal = result.overallSignal;
          if (
            lastOverallSignal !== undefined &&
            currentOverallSignal !== lastOverallSignal
          ) {
            generalChangesDetected++;
            const sentimentBuyBase = result.buyPercentage.toFixed(2);
            const sentimentSellBase = (100 - result.buyPercentage).toFixed(2);
            const message =
              `🔔 *${result.symbol} FXSSI เปลี่ยนแปลง!* ${getEmojiForSignal(
                currentOverallSignal
              )}\n` +
              `   จาก: \`${lastOverallSignal}\`  เป็น: \`${currentOverallSignal}\`\n` +
              `   Sentiment (ฐาน): (ซื้อ: ${sentimentBuyBase}% | ขาย: ${sentimentSellBase}%)`;
            sendTelegramNotification(message);
          }
        });
      }
      const newPreviousSignals = {};
      currentRunResults.forEach((result) => {
        newPreviousSignals[result.symbol] = result.overallSignal;
      });
      previousSignals = newPreviousSignals;
      if (isFirstRunPopulatingGeneralSignals && currentRunResults.length > 0) {
        console.log(
          "Initial general FXSSI signal data populated. Monitoring for changes."
        );
      } else if (
        generalChangesDetected === 0 &&
        !isFirstRunPopulatingGeneralSignals
      ) {
        // console.log("No significant general FXSSI signal changes detected.");
      }
      // --- End Process General Signals ---

      // --- Process Special XAUUSD Signal (ใหม่) ---
      if (
        jsonData.pairs.XAUUSD &&
        jsonData.pairs.XAUUSD.average &&
        jsonData.pairs.USDX &&
        jsonData.pairs.USDX.average
      ) {
        const xauusdAvg = parseFloat(jsonData.pairs.XAUUSD.average);
        const usdxAvg = parseFloat(jsonData.pairs.USDX.average);
        let currentXauUsdSpecialSignal = "HOLD GOLD";

        if (xauusdAvg > 55 && usdxAvg < 50) {
          currentXauUsdSpecialSignal = "SELL GOLD (USDX Weak)";
        } else if (xauusdAvg < 45 && usdxAvg > 50) {
          currentXauUsdSpecialSignal = "BUY GOLD (USDX Strong)";
        }

        // ตรวจจับการเปลี่ยนแปลงและแจ้งเตือน
        if (previousXauUsdSpecialSignal === null && subscribedChatId) {
          // First run with subscriber
          console.log(
            `Initial special XAUUSD signal determined: ${currentXauUsdSpecialSignal}. Storing and awaiting next change.`
          );
          const initialSpecialMsg =
            `*สัญญาณทองคำพิเศษเริ่มต้น (XAUUSD vs USDX):*\n` +
            `${getEmojiForSignal(
              currentXauUsdSpecialSignal
            )} \`${currentXauUsdSpecialSignal}\`\n` +
            `   XAUUSD avg: ${xauusdAvg.toFixed(2)}%\n` +
            `   USDX avg: ${usdxAvg.toFixed(2)}%`;
          // await sendTelegramNotification(initialSpecialMsg, true); // สามารถเปิดถ้าต้องการแจ้งเตือนรอบแรก
        } else if (
          previousXauUsdSpecialSignal !== null &&
          currentXauUsdSpecialSignal !== previousXauUsdSpecialSignal
        ) {
          console.log(
            `Special XAUUSD signal changed from ${previousXauUsdSpecialSignal} to ${currentXauUsdSpecialSignal}. Sending notification.`
          );
          const message =
            `🔔 *XAUUSD สัญญาณพิเศษ เปลี่ยนแปลง!* ${getEmojiForSignal(
              currentXauUsdSpecialSignal
            )}\n` +
            `   จาก: \`${previousXauUsdSpecialSignal}\`\n` +
            `   เป็น: \`${currentXauUsdSpecialSignal}\`\n` +
            `   เงื่อนไข:\n` +
            `     - XAUUSD Sentiment (ซื้อ): ${xauusdAvg.toFixed(2)}%\n` +
            `     - USDX Sentiment (ซื้อ): ${usdxAvg.toFixed(2)}%`;
          sendTelegramNotification(message);
        }
        previousXauUsdSpecialSignal = currentXauUsdSpecialSignal;
      } else {
        console.log(
          "XAUUSD or USDX data not available for special signal processing."
        );
      }
      // --- End Process Special XAUUSD Signal ---
    } else {
      console.log("Could not find 'pairs' data in the FXSSI response.");
      lastServerTimeText = "N/A (FXSSI API error)";
    }
  } catch (error) {
    console.error(
      "Error during FXSSI data fetch or processing:",
      error.message
    );
    lastServerTimeText = "N/A (FXSSI Fetch error)";
  } finally {
    const randomOffset =
      Math.random() * 2 * RANDOM_VARIATION_MS - RANDOM_VARIATION_MS;
    const nextInterval = BASE_INTERVAL_MS + randomOffset;
    setTimeout(fetchDataAndProcessFxssi, nextInterval);
  }
}

// --- Initialization ---
console.log("Initializing FXSSI Signal Monitor with Webhook...");

if (TELEGRAM_BOT_TOKEN) {
  app
    .listen(WEBHOOK_PORT, () => {
      console.log(
        `Express server with Webhook listening on port ${WEBHOOK_PORT}`
      );
      console.log(
        `Webhook endpoint: http://localhost:${WEBHOOK_PORT}/tw (POST)`
      );
    })
    .on("error", (err) => {
      console.error(
        `Failed to start Express server on port ${WEBHOOK_PORT}:`,
        err.message
      );
      if (err.code === "EADDRINUSE") {
        console.error(
          `Port ${WEBHOOK_PORT} is already in use. Please choose another port or stop the existing service.`
        );
      }
      process.exit(1);
    });

  fetchDataAndProcessFxssi();
  console.log("FXSSI Signal Monitor part is running. Press Ctrl+C to stop.");

  if (!subscribedChatId) {
    console.log(
      "To receive Telegram notifications, send the /start command to your bot on Telegram."
    );
  } else {
    console.log(
      `Currently subscribed to send notifications to Chat ID: ${subscribedChatId}.`
    );
  }
} else {
  console.error(
    "CRITICAL ERROR: TELEGRAM_BOT_TOKEN is not set. FXSSI Monitor and Telegram Bot cannot start."
  );
  process.exit(1);
}
