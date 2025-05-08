require("dotenv").config();

const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express");

// --- Configuration ---
const API_URL_FXSSI = "https://c.fxssi.com/api/current-ratios";
const BASE_INTERVAL_MS = 5 * 60 * 1000;
const RANDOM_VARIATION_MS = 1 * 60 * 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CONFIG_FILE_PATH = "./telegram_subscriber.json";
const WEBHOOK_PORT = process.env.PORT || 80;
// --- End Configuration ---

let bot;
let subscribedChatId = null;
let previousSignals = {};
let lastSuccessfulResults = [];
let lastServerTimeText = "N/A";

// --- Express App Setup ---
const app = express();
app.use(express.text({ type: "*/*" })); // รับ text/plain และอื่นๆ สำหรับ body

function formatTimestamp(timestampStr) {
  if (!timestampStr) return "N/A";
  try {
    // TradingView's {{time}} is usually a Unix timestamp (seconds or milliseconds)
    // or an ISO string. Let's try parsing it.
    let date;
    if (String(timestampStr).length === 10) {
      // Likely Unix seconds
      date = new Date(parseInt(timestampStr, 10) * 1000);
    } else if (
      String(timestampStr).length === 13 &&
      /^\d+$/.test(timestampStr)
    ) {
      // Likely Unix ms
      date = new Date(parseInt(timestampStr, 10));
    } else {
      // Try direct parsing (ISO string etc.)
      date = new Date(timestampStr);
    }

    if (isNaN(date.getTime())) {
      // Check if date is valid
      return timestampStr; // Return original if parsing failed
    }
    return date.toLocaleString("th-TH", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "Asia/Bangkok", // Adjust to your preferred timezone
    });
  } catch (e) {
    console.warn("Could not parse timestamp:", timestampStr, e);
    return timestampStr; // Return original on error
  }
}

// Route สำหรับ TradingView Webhook
app.post("/tw", (req, res) => {
  const webhookDataString = req.body;
  console.log(`[${new Date().toLocaleString()}] Received Webhook on /tw:`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Raw Body:", webhookDataString);

  let jsonData;
  try {
    // Pine Script อาจจะมี space ต่อท้าย JSON string
    jsonData = JSON.parse(webhookDataString.trim());
    console.log("Parsed JSON Body:", JSON.stringify(jsonData, null, 2));
  } catch (e) {
    console.error("Error parsing webhook JSON:", e);
    const errorMessage =
      `⚠️ *Error Parsing Webhook JSON*\n\n` +
      `\`\`\`\n${webhookDataString.substring(0, 1000)}\n\`\`\`\n` +
      `Error: ${e.message}`;
    if (subscribedChatId && bot) {
      sendTelegramNotification(errorMessage, true);
    }
    res.status(400).send("Invalid JSON payload.");
    return;
  }

  // สร้างข้อความ Telegram จาก jsonData
  let telegramMessage = `🔔 *${
    jsonData.indicator_name || "TradingView Alert"
  }*\n\n`;

  const eventType = jsonData.event_type || "Unknown Event";
  telegramMessage += `*Event:* \`${eventType}\`\n`;
  telegramMessage += `*Symbol:* \`${jsonData.symbol || "N/A"}\` (${
    jsonData.exchange || "N/A"
  })\n`;

  const chartTimeframe =
    jsonData.timeframe_chart || jsonData.timeframe || "N/A";
  const signalTimeframe = jsonData.timeframe_signal || "";
  telegramMessage += `*Timeframe:* \`${chartTimeframe}${
    signalTimeframe ? ` (Signal: ${signalTimeframe})` : ""
  }\`\n`;

  if (jsonData.price !== undefined) {
    telegramMessage += `*Price:* \`${jsonData.price}\`\n`;
  }
  if (jsonData.price_detected_at !== undefined) {
    telegramMessage += `*Price (Detected):* \`${jsonData.price_detected_at}\`\n`;
  }
  if (jsonData.current_price !== undefined) {
    // For Pivot alerts
    telegramMessage += `*Current Price (Chart):* \`${jsonData.current_price}\`\n`;
  }
  if (jsonData.price_at_creation !== undefined) {
    // For SCOB Creation
    telegramMessage += `*Price (Creation):* \`${jsonData.price_at_creation}\`\n`;
  }
  if (jsonData.mitigation_price !== undefined) {
    // For SCOB Mitigation
    telegramMessage += `*Price (Mitigation):* \`${jsonData.mitigation_price}\`\n`;
  }

  // SCOB Specific details
  if (eventType.toLowerCase().includes("scob")) {
    if (jsonData.scob_top !== undefined) {
      telegramMessage += `*SCOB Top:* \`${jsonData.scob_top}\`\n`;
    }
    if (jsonData.scob_bottom !== undefined) {
      telegramMessage += `*SCOB Bottom:* \`${jsonData.scob_bottom}\`\n`;
    }
  }

  if (jsonData.message) {
    telegramMessage += `*Message:* ${jsonData.message}\n`;
  }

  if (jsonData.timestamp_bar) {
    telegramMessage += `*Bar Time:* \`${formatTimestamp(
      jsonData.timestamp_bar
    )}\`\n`;
  }
  if (jsonData.timestamp_alert) {
    telegramMessage += `*Alert Time:* \`${formatTimestamp(
      jsonData.timestamp_alert
    )}\`\n`;
  }

  // ตอบกลับไปยัง TradingView
  res.status(200).send("Webhook processed successfully by Express server.");

  // ส่งการแจ้งเตือนไปยัง Telegram หากมีผู้สมัคร
  if (subscribedChatId && bot) {
    sendTelegramNotification(telegramMessage, true); // true เพื่อบอกว่าเป็นข้อความพิเศษ
  }
});

app.get("/", (req, res) => {
  res.send("FXSSI Telegram Bot with TradingView Webhook is running!");
});
// --- End Express App Setup ---

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
    let responseMessage = `สวัสดีครับคุณ ${userName}! คุณได้สมัครรับการแจ้งเตือน FXSSI signals และ TradingView Webhooks แล้ว`;

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
        "Sending current FXSSI signals snapshot to newly subscribed user..."
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

async function sendTelegramNotification(message, isSpecialMessage = false) {
  if (!bot || !subscribedChatId) return;
  try {
    let finalMessage = message;
    if (!isSpecialMessage) {
      const timeString =
        lastServerTimeText !== "N/A"
          ? lastServerTimeText.split(" ")[1]
          : new Date().toLocaleTimeString("th-TH", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
      finalMessage += `\n_(ข้อมูล Server FXSSI ณ: ${timeString})_`;
    }
    // Ensure message is not too long for Telegram
    if (finalMessage.length > 4096) {
      console.warn(
        `Telegram message too long (${finalMessage.length} chars), truncating.`
      );
      finalMessage = finalMessage.substring(0, 4090) + "\n... (truncated)";
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
  return String(str) + char.repeat(Math.max(0, length - String(str).length));
}
function padLeft(str, length, char = " ") {
  return char.repeat(Math.max(0, length - String(str).length)) + String(str);
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
    ...signalsArray.map((s) => String(s.symbol).length),
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
      error.message ? error.message : error // Log full error if no message
    );
  }
}

async function fetchDataAndProcessFxssi() {
  const fetchTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
  });
  console.log(`\n[${fetchTime}] Fetching new data from FXSSI...`);
  try {
    const response = await axios.get(API_URL_FXSSI);
    const jsonData = response.data;
    if (jsonData && jsonData.pairs) {
      lastServerTimeText = jsonData.server_time_text || "N/A";
      console.log(`FXSSI Data fetched. Server time: ${lastServerTimeText}`);
      const currentRunResults = [];
      for (const pairSymbol in jsonData.pairs) {
        if (jsonData.pairs.hasOwnProperty(pairSymbol)) {
          const pairData = jsonData.pairs[pairSymbol];
          if (pairData && pairData.hasOwnProperty("average")) {
            const buyPercentage = parseFloat(pairData.average);
            if (isNaN(buyPercentage)) continue;
            let overallSignal = "HOLD";
            if (buyPercentage > 55)
              overallSignal =
                "SELL"; // Note: Original logic, in FXSSI buyPercentage means % of traders buying. So >55 means more buy, so signal should be BUY. Reversing for consistency if this means "sentiment for selling". Assuming current logic is intended.
            else if (buyPercentage < 45) overallSignal = "BUY"; // Similarly, if <45% are buying, sentiment is SELL.
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

      const isFirstRunPopulatingSignals =
        Object.keys(previousSignals).length === 0;
      if (
        isFirstRunPopulatingSignals &&
        subscribedChatId &&
        currentRunResults.length > 0
      ) {
        console.log(
          "First successful FXSSI data fetch. Sending initial signals snapshot..."
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
              `🔔 *${result.symbol} FXSSI เปลี่ยนแปลง!* ${getEmojiForSignal(
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
          "Initial FXSSI signal data populated. Monitoring for changes."
        );
      }
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
        `Webhook endpoint available at: /tw (POST)` // Removed http://localhost as it might be behind a reverse proxy
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
