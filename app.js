require("dotenv").config();

const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express");

const { createProxyMiddleware } = require("http-proxy-middleware");

// --- Configuration ---
const API_URL_FXSSI = "https://c.fxssi.com/api/current-ratios";
const BASE_INTERVAL_MS = 5 * 60 * 1000;
const RANDOM_VARIATION_MS = 1 * 60 * 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CONFIG_FILE_PATH = "./telegram_subscriber.json";
const WEBHOOK_PORT = process.env.PORT || 80; // Default to 80 if not specified
// --- End Configuration ---

let bot;
let subscribedChatId = null;
let previousSignals = {}; // Stores previous general FXSSI signals { "EURUSD": "BUY", ... }
let lastSuccessfulResults = []; // Stores the latest processed FXSSI results array
let lastServerTimeText = "N/A";
let previousXauUsdSpecialSignal = null; // Stores the previous XAUUSD special signal string
let jsonDataCacheForStartup = null; // Caches the last jsonData for /start command

// --- Express App Setup ---
const app = express();

app.use(
  "/telegram-calendar-bot",
  createProxyMiddleware({
    target: "http://localhost:3000",
    changeOrigin: true,
  })
);

app.use(express.text({ type: "*/*" })); // Accept raw text body for webhook

function extractBaseSymbol(tickerId) {
  if (!tickerId) return null;
  const parts = tickerId.split(":");
  return parts.length > 1 ? parts[1].toUpperCase() : parts[0].toUpperCase();
}

app.post("/tw", (req, res) => {
  const rawWebhookData = req.body;
  const receivedAt = Date.now();
  console.log(
    `[${new Date(receivedAt).toLocaleString()}] Received Webhook on /tw:`
  );
  console.log("Raw Body:", rawWebhookData);

  let webhookDataJson;
  try {
    webhookDataJson = JSON.parse(rawWebhookData);
    console.log("Parsed JSON Body:", webhookDataJson);
  } catch (error) {
    console.error("Error parsing Webhook body as JSON:", error.message);
    return res.status(400).send("Webhook data could not be parsed as JSON.");
  }

  res.status(200).send("Webhook processed successfully by Express server."); // Acknowledge TradingView

  if (webhookDataJson && webhookDataJson.symbol && webhookDataJson.signal) {
    const baseSymbolFromWebhook = extractBaseSymbol(webhookDataJson.symbol);
    if (!baseSymbolFromWebhook) {
      console.warn(
        "Could not extract base symbol from webhook data:",
        webhookDataJson.symbol
      );
      return;
    }

    const {
      symbol,
      signal: webhookSignalType,
      timeframe,
      ob_bottom,
      ob_top,
      retest_price,
      alert_timestamp,
    } = webhookDataJson;

    const latestFxssiDataForSymbol = lastSuccessfulResults.find(
      (fxssi) => fxssi.symbol.toUpperCase() === baseSymbolFromWebhook
    );

    let fxssiMatch = false;
    let confirmationMessage = "";

    if (latestFxssiDataForSymbol) {
      const fxssiOverallSignal = latestFxssiDataForSymbol.overallSignal;
      const fxssiBuyPercentage = latestFxssiDataForSymbol.buyPercentage;

      if (
        fxssiOverallSignal === "BUY" &&
        webhookSignalType.toUpperCase().startsWith("BUY")
      ) {
        fxssiMatch = true;
      } else if (
        fxssiOverallSignal === "SELL" &&
        webhookSignalType.toUpperCase().startsWith("SELL")
      ) {
        fxssiMatch = true;
      }

      if (fxssiMatch) {
        console.log(
          `CONFIRMED (Immediate): FXSSI ${fxssiOverallSignal} for ${baseSymbolFromWebhook} matches Webhook ${webhookSignalType}`
        );
        const alertDateTV = new Date(Number(alert_timestamp)).toLocaleString(
          "th-TH",
          { timeZone: "Asia/Bangkok", hour12: false }
        );
        confirmationMessage =
          `${baseSymbolFromWebhook} ${fxssiOverallSignal}!*\n\n✅ *CONFIRMED SIGNAL: \n\n` +
          `*TradingView Signal:* \`${webhookSignalType}\` (on \`${timeframe}\`)\n` +
          `*FXSSI Sentiment (Current):* \`${fxssiOverallSignal}\` (Buyers: ${fxssiBuyPercentage.toFixed(
            2
          )}%)\n` +
          `  _(FXSSI data as of: ${lastServerTimeText || "N/A"})_\n\n` +
          `*Details from TradingView:*\n` +
          `  Symbol: \`${symbol}\`\n` +
          `  Order Block: \`${ob_bottom} - ${ob_top}\`\n` +
          `  Retest Price: \`${retest_price}\`\n` +
          `  TV Alert Time: \`${alertDateTV}\``;
        sendTelegramNotification(confirmationMessage, true);
      } else {
        console.log(
          `No Match: FXSSI ${fxssiOverallSignal} for ${baseSymbolFromWebhook} does NOT match Webhook ${webhookSignalType}. No notification sent.`
        );
      }
    } else {
      console.log(
        `No FXSSI data available for ${baseSymbolFromWebhook} to confirm Webhook ${webhookSignalType}. No notification sent.`
      );
    }
  }
});

app.get("/", (req, res) => {
  res.send("FXSSI Telegram Bot with TradingView Webhook is running!");
});
// --- End Express App Setup ---

function getEmojiForSignal(signal) {
  if (!signal) return "❔";
  const upperSignal = signal.toUpperCase();
  if (upperSignal.includes("BUY GOLD")) return "📈"; // Covers "BUY GOLD (USDX Strong)"
  if (upperSignal.includes("SELL GOLD")) return "📉"; // Covers "SELL GOLD (USDX Weak)"
  if (upperSignal.includes("HOLD GOLD")) return "⚖️";
  if (upperSignal.includes("BUY")) return "📈";
  if (upperSignal.includes("SELL")) return "📉";
  if (upperSignal.includes("HOLD")) return "⚖️";
  return "❔";
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
  bot.setMyCommands([
    { command: "/start", description: "Start receiving alerts" },
  ]);
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const oldSubscribedChatId = subscribedChatId;
    subscribedChatId = chatId;
    saveSubscribedChatId(chatId);
    const userName = msg.from.first_name || "User";
    let responseMessage = `สวัสดีครับคุณ ${userName}! คุณได้สมัครรับการแจ้งเตือน FXSSI signals และ TradingView Webhooks แล้วครับ`;
    if (oldSubscribedChatId && oldSubscribedChatId !== chatId) {
      responseMessage += `\n(Chat ID ก่อนหน้า: ${oldSubscribedChatId} จะไม่ได้รับการแจ้งเตือนแล้ว)`;
    }
    // Send welcome message - you can uncomment this if you want an explicit welcome message
    // bot.sendMessage(chatId, responseMessage); // This is the welcome message, you can send it if you want
    console.log(
      `User ${userName} (Chat ID: ${chatId}) subscribed via /start command.`
    );

    // Send current FXSSI snapshot if available
    if (lastSuccessfulResults.length > 0 && subscribedChatId) {
      sendInitialSignalsSnapshot(
        lastSuccessfulResults,
        `📊 สรุป Sentiment FXSSI (/start)`,
        lastServerTimeText
      );
    }
    // Send current XAUUSD special signal if available
    if (previousXauUsdSpecialSignal && subscribedChatId) {
      let specialXauMessage =
        `*🚀🚀 สถานะสัญญาณทองคำ (XAUUSD vs USDX) :*\n` +
        `${getEmojiForSignal(
          previousXauUsdSpecialSignal
        )} \`${previousXauUsdSpecialSignal}\``;

      if (
        jsonDataCacheForStartup?.pairs?.XAUUSD?.average &&
        jsonDataCacheForStartup?.pairs?.USDX?.average
      ) {
        const xauAvg = parseFloat(jsonDataCacheForStartup.pairs.XAUUSD.average);
        const usdxAvg = parseFloat(jsonDataCacheForStartup.pairs.USDX.average);
        const xauBuyFormatted = xauAvg.toFixed(2);
        const xauSellFormatted = (100 - xauAvg).toFixed(2);
        const usdxBuyFormatted = usdxAvg.toFixed(2);
        const usdxSellFormatted = (100 - usdxAvg).toFixed(2);

        specialXauMessage +=
          `\n   XAUUSD (B: ${xauBuyFormatted} | S: ${xauSellFormatted})` +
          `\n   USDX   (B: ${usdxBuyFormatted} | S: ${usdxSellFormatted})`;
      } else {
        specialXauMessage += `\n   (Detailed sentiment data currently unavailable)`;
      }
      sendTelegramNotification(specialXauMessage, true); // true for special message
    }
  });

  bot.on("polling_error", (error) =>
    console.error(
      `Telegram polling error: ${error.code} - ${
        error.message ? error.message.substring(0, 150) : "(No message)"
      }`
    )
  );
} else {
  console.error("CRITICAL ERROR: TELEGRAM_BOT_TOKEN is not set.");
}

async function sendTelegramNotification(message, isSpecialMessage = false) {
  if (!bot || !subscribedChatId) return;
  try {
    // No need to add server time here if message already contains it or is a special alert
    let finalMessage = message;
    await bot.sendMessage(subscribedChatId, finalMessage, {
      parse_mode: "Markdown",
    });
    const firstLine = message.split("\n")[0];
    console.log(
      `Telegram notification sent to Chat ID ${subscribedChatId}: "${firstLine.substring(
        0,
        80
      )}..."`
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
  if (!bot || !subscribedChatId || !signalsArray || signalsArray.length === 0)
    return;

  let message = `*${title}*\n\n`;
  message +=
    serverTimeText && serverTimeText !== "N/A"
      ? `_ข้อมูล FXSSI ณ ${serverTimeText} (Server Time)_\n\n`
      : `_ข้อมูล FXSSI ณ ${new Date().toLocaleDateString(
          "th-TH"
        )} ${new Date().toLocaleTimeString("th-TH")} (Local Time)_\n\n`;

  message += "```\n";
  const maxSymbolLength = Math.max(
    ...signalsArray.map((s) => s.symbol.length),
    7 // Minimum length for "Symbol " header
  );
  // Header for the table (optional but nice)
  // message += `${padRight("Symbol", maxSymbolLength)} B:      S:\n`;
  // message += `${"-".repeat(maxSymbolLength)} -------- --------\n`;

  signalsArray.forEach((s) => {
    const buyVal = s.buyPercentage.toFixed(2);
    const sellVal = (100 - s.buyPercentage).toFixed(2);
    const symbolPadded = padRight(s.symbol, maxSymbolLength);
    const buyStr = padLeft(buyVal, 5); // Ensure buyVal takes 5 chars e.g., " 5.25" or "55.25"
    const sellStr = padLeft(sellVal, 5); // Ensure sellVal takes 5 chars

    message += `${getEmojiForSignal(
      s.overallSignal
    )} ${symbolPadded} (B:${buyStr} | S:${sellStr})\n`; // Added % sign here for consistency with other parts
  });
  message += "```\n";

  // Check message length, Telegram has a limit of 4096 characters
  if (message.length > 4000) {
    // Truncate if too long, provide a generic message
    message =
      `*${title}*\n\nรายการสัญญาณยาวเกินไป.\n` +
      (serverTimeText && serverTimeText !== "N/A"
        ? `_ข้อมูล FXSSI ณ ${serverTimeText} (Server Time)_`
        : "");
  }
  await sendTelegramNotification(message.trim(), true); // true for special message (like /start)
}

function handleTelegramSendError(error) {
  if (
    error.response &&
    (error.response.statusCode === 403 ||
      (error.response.body && error.response.body.error_code === 403))
  ) {
    console.warn(
      `Failed to send Telegram notification to ${subscribedChatId}: Bot was blocked. Resetting subscription.`
    );
    subscribedChatId = null; // Reset chat ID
    try {
      if (fs.existsSync(CONFIG_FILE_PATH)) fs.unlinkSync(CONFIG_FILE_PATH); // Delete config file
    } catch (e) {
      console.error("Error deleting subscriber config file:", e);
    }
  } else {
    console.error(
      `Failed to send Telegram notification to ${subscribedChatId}:`,
      error.message
        ? error.message.substring(0, 200)
        : "Unknown Telegram send error"
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
    jsonDataCacheForStartup = jsonData; // Cache for /start command

    if (jsonData && jsonData.pairs) {
      lastServerTimeText = jsonData.server_time_text || "N/A";
      console.log(`FXSSI Data fetched. Server time: ${lastServerTimeText}`);
      const currentRunFxssiResults = [];

      // Process general FXSSI signals
      for (const pairSymbolFxssi in jsonData.pairs) {
        if (jsonData.pairs.hasOwnProperty(pairSymbolFxssi)) {
          const pairData = jsonData.pairs[pairSymbolFxssi];
          if (pairData && pairData.hasOwnProperty("average")) {
            const buyPercentage = parseFloat(pairData.average);
            if (isNaN(buyPercentage)) continue; // Skip if average is not a number

            let overallSignalFxssi = "HOLD";
            if (buyPercentage > 55) overallSignalFxssi = "SELL";
            // Note: FXSSI 'average' is BUY percentage. So >55 means more buyers -> potential SELL signal for contrarian. Or BUY for trend. Adjust as per your strategy. This example uses it as BUY percentage.
            else if (buyPercentage < 45) overallSignalFxssi = "BUY"; // <45 means fewer buyers -> potential BUY signal for contrarian.

            currentRunFxssiResults.push({
              symbol: pairSymbolFxssi.toUpperCase(),
              buyPercentage: buyPercentage,
              overallSignal: overallSignalFxssi,
            });
          }
        }
      }
      lastSuccessfulResults = [...currentRunFxssiResults]; // Update cache
      lastSuccessfulResults.sort((a, b) => b.buyPercentage - a.buyPercentage); // Sort by buy percentage

      // Check for general signal changes and notify
      const isFirstRunPopulatingGeneralSignals =
        Object.keys(previousSignals).length === 0;

      if (
        isFirstRunPopulatingGeneralSignals &&
        subscribedChatId &&
        lastSuccessfulResults.length > 0
      ) {
        console.log(
          "First successful FXSSI data fetch. Sending initial general signals snapshot..."
        );
        await sendInitialSignalsSnapshot(
          lastSuccessfulResults,
          "📊 สรุป Sentiment FXSSI (/start)", // Title for first snapshot
          lastServerTimeText
        );
      }

      let generalChangesDetected = 0;
      if (!isFirstRunPopulatingGeneralSignals) {
        lastSuccessfulResults.forEach((result) => {
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
              `   Sentiment : (B: ${sentimentBuyBase} | S: ${sentimentSellBase})`; // Added %
            sendTelegramNotification(message, false); // false for regular change
          }
        });
      }

      // Update previousSignals for the next run
      const newPreviousSignals = {};
      lastSuccessfulResults.forEach((result) => {
        newPreviousSignals[result.symbol] = result.overallSignal;
      });
      previousSignals = newPreviousSignals;

      if (
        isFirstRunPopulatingGeneralSignals &&
        lastSuccessfulResults.length > 0
      ) {
        console.log(
          "Initial general FXSSI signal data populated. Monitoring for changes."
        );
      } else if (generalChangesDetected > 0) {
        console.log(
          `${generalChangesDetected} general FXSSI signal change(s) detected and notified.`
        );
      } else {
        console.log("No general FXSSI signal changes detected.");
      }

      // --- XAUUSD vs USDX Special Signal Processing ---
      if (jsonData.pairs.XAUUSD?.average && jsonData.pairs.USDX?.average) {
        const xauusdAvg = parseFloat(jsonData.pairs.XAUUSD.average);
        const usdxAvg = parseFloat(jsonData.pairs.USDX.average);
        let currentXauUsdSpecialSignal = "HOLD GOLD"; // Default signal

        // --- APPLY NEW LOGIC HERE ---
        if (xauusdAvg > 55 && usdxAvg < 50) {
          currentXauUsdSpecialSignal = "SELL GOLD (USDX Weak)";
        } else if (xauusdAvg < 45 && usdxAvg > 50) {
          currentXauUsdSpecialSignal = "BUY GOLD (USDX Strong)";
        }
        // --- END OF NEW LOGIC ---

        // Calculate sell percentages and format all percentages
        const xauusdBuyFormatted = xauusdAvg.toFixed(2);
        const xauusdSellFormatted = (100 - xauusdAvg).toFixed(2); // Calculate XAUUSD sell %
        const usdxBuyFormatted = usdxAvg.toFixed(2);
        const usdxSellFormatted = (100 - usdxAvg).toFixed(2); // Calculate USDX sell %

        if (previousXauUsdSpecialSignal === null && subscribedChatId) {
          // First run with a subscriber, send initial special signal
          console.log(
            `Initial special XAUUSD signal: ${currentXauUsdSpecialSignal}. Sending notification.`
          );
          // MODIFIED MESSAGE FORMAT HERE
          const message =
            `*🚀 สัญญาณทองคำ (XAUUSD vs USDX) เริ่มต้น:*\n${getEmojiForSignal(
              currentXauUsdSpecialSignal
            )}\`${currentXauUsdSpecialSignal}\`\n` +
            `   XAUUSD : (B: ${xauusdBuyFormatted} | S: ${xauusdSellFormatted})\n` +
            `   USDX   : (B: ${usdxBuyFormatted} | S: ${usdxSellFormatted})`;
          sendTelegramNotification(message, true); // true for special message
        } else if (
          previousXauUsdSpecialSignal !== null &&
          currentXauUsdSpecialSignal !== previousXauUsdSpecialSignal
        ) {
          console.log(
            `Special XAUUSD signal changed: ${currentXauUsdSpecialSignal}. Sending notification.`
          );
          // MODIFIED MESSAGE FORMAT HERE
          const message =
            `🔔 *XAUUSD สัญญาณพิเศษ เปลี่ยนแปลง!* ${getEmojiForSignal(
              currentXauUsdSpecialSignal
            )}\n` +
            `   จาก: \`${previousXauUsdSpecialSignal}\`\n` +
            `   เป็น: \`${currentXauUsdSpecialSignal}\`\n` +
            `   เงื่อนไข:\n` + // "เงื่อนไข:" (Conditions:) label kept for clarity
            `     - XAUUSD : (B: ${xauusdBuyFormatted} | S: ${xauusdSellFormatted})\n` +
            `     - USDX   : (B: ${usdxBuyFormatted} | S: ${usdxSellFormatted})`;
          sendTelegramNotification(message, true); // true for special message
        }
        previousXauUsdSpecialSignal = currentXauUsdSpecialSignal;
      } else {
        console.log(
          "XAUUSD or USDX data not available for special signal processing."
        );
        // If previously there was a signal, and now data is missing, you might want to send a "Data N/A" message.
        // For simplicity, this is omitted here.
      }
    } else {
      console.log("Could not find 'pairs' data in the FXSSI response.");
      lastServerTimeText = "N/A (FXSSI API error)";
    }
  } catch (error) {
    console.error(
      "Error during FXSSI data fetch or processing:",
      error.message ? error.message.substring(0, 200) : "Unknown FXSSI error"
    );
    lastServerTimeText = "N/A (FXSSI Fetch error)";
  } finally {
    // Schedule next fetch with random variation
    const randomOffset =
      Math.random() * 2 * RANDOM_VARIATION_MS - RANDOM_VARIATION_MS; // -RANDOM_VARIATION_MS to +RANDOM_VARIATION_MS
    const nextInterval = BASE_INTERVAL_MS + randomOffset;
    setTimeout(fetchDataAndProcessFxssi, nextInterval);
    // console.log(`Next FXSSI fetch scheduled in approx ${(nextInterval / 1000 / 60).toFixed(1)} minutes.`);
  }
}

// --- Initialization ---
console.log(
  "Initializing FXSSI Signal Monitor with Immediate Webhook Confirmation (Notify on Match Only)..."
);
if (TELEGRAM_BOT_TOKEN) {
  fetchDataAndProcessFxssi(); // Initial fetch

  app
    .listen(WEBHOOK_PORT, () => {
      console.log(
        `Express server with Webhook listening on port ${WEBHOOK_PORT}`
      );
      // Attempt to get public IP (best effort)
      axios
        .get("https://api.ipify.org?format=json")
        .then((response) =>
          console.log(
            `Webhook endpoint accessible at: http://${response.data.ip}:${WEBHOOK_PORT}/tw (POST)`
          )
        )
        .catch(() =>
          console.log(
            `Webhook endpoint: http://<YOUR_PUBLIC_IP>:${WEBHOOK_PORT}/tw (POST) or http://localhost:${WEBHOOK_PORT}/tw`
          )
        );
    })
    .on("error", (err) => {
      console.error(
        `Failed to start Express server on port ${WEBHOOK_PORT}:`,
        err.message
      );
      if (err.code === "EADDRINUSE")
        console.error(`Port ${WEBHOOK_PORT} is already in use.`);
      process.exit(1); // Exit if server can't start
    });

  console.log(
    "FXSSI Signal Monitor & Immediate Webhook Confirmation running. Press Ctrl+C to stop."
  );
  if (!subscribedChatId)
    console.log("To receive Telegram notifications, send /start to your bot.");
  else
    console.log(
      `Subscribed to send notifications to Chat ID: ${subscribedChatId}.`
    );
} else {
  console.error(
    "CRITICAL ERROR: TELEGRAM_BOT_TOKEN is not set. Application cannot start."
  );
  process.exit(1); // Exit if critical config is missing
}
