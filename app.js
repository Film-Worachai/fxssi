require("dotenv").config();

const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express");

// --- Configuration ---
const API_URL_FXSSI = "https://c.fxssi.com/api/current-ratios";
const BASE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes for FXSSI fetch
const RANDOM_VARIATION_MS = 1 * 60 * 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CONFIG_FILE_PATH = "./telegram_subscriber.json";
const WEBHOOK_PORT = process.env.PORT || 80;
const WEBHOOK_CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to keep webhook signal for confirmation
// --- End Configuration ---

let bot;
let subscribedChatId = null;
let previousSignals = {}; // For FXSSI general signals
let lastSuccessfulResults = []; // Last FXSSI general results
let lastServerTimeText = "N/A";
let previousXauUsdSpecialSignal = null; // For FXSSI XAUUSD vs USDX special signal
let jsonDataCacheForStartup = null;

// --- State for Webhook Confirmation ---
let pendingWebhookSignals = []; // Array to store webhook signals awaiting FXSSI confirmation
// Structure: { id: string, timestamp: number, data: webhookDataJson, confirmed: boolean, fxssiSymbol: string }
// --- End State ---

// --- Express App Setup ---
const app = express();
app.use(express.text({ type: "*/*" }));

// Helper to extract base symbol (e.g., "XAUUSD" from "EIGHTCAP:XAUUSD")
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
    if (subscribedChatId && bot) {
      const errorMessage = `⚠️ *TradingView Webhook Error!*\n\nCould not parse incoming data.`;
      sendTelegramNotification(errorMessage, true);
    }
    return res.status(400).send("Webhook data could not be parsed as JSON.");
  }

  res.status(200).send("Webhook processed successfully by Express server.");

  if (webhookDataJson && webhookDataJson.symbol && webhookDataJson.signal) {
    const baseSymbolFromWebhook = extractBaseSymbol(webhookDataJson.symbol);
    if (!baseSymbolFromWebhook) {
      console.warn(
        "Could not extract base symbol from webhook data:",
        webhookDataJson.symbol
      );
      return;
    }

    const signalId = `${baseSymbolFromWebhook}_${webhookDataJson.signal}_${receivedAt}`;
    pendingWebhookSignals.push({
      id: signalId,
      timestamp: receivedAt,
      data: webhookDataJson,
      confirmed: false,
      fxssiSymbol: baseSymbolFromWebhook, // Store the cleaned symbol
    });
    console.log(
      `Webhook signal for ${baseSymbolFromWebhook} (${webhookDataJson.signal}) added to pending list. ID: ${signalId}`
    );

    // Send initial notification about the TradingView signal
    const {
      symbol,
      signal,
      timeframe,
      ob_bottom,
      ob_top,
      retest_price,
      alert_timestamp,
    } = webhookDataJson;
    const signalEmoji = signal.toUpperCase().includes("BUY")
      ? "📈"
      : signal.toUpperCase().includes("SELL")
      ? "📉"
      : "🔔";
    const signalAction = signal.replace("_RETEST", "");
    const alertDate = new Date(Number(alert_timestamp)).toLocaleString(
      "th-TH",
      { timeZone: "Asia/Bangkok", hour12: false }
    );

    const initialWebhookMessage =
      `${signalEmoji} *TradingView: ${baseSymbolFromWebhook} ${signalAction} Potential!*\n\n` +
      `*Symbol:* \`${symbol}\` (Base: \`${baseSymbolFromWebhook}\`)\n` +
      `*Signal:* \`${signal}\`\n` +
      `*Timeframe:* \`${timeframe}\`\n` +
      `*Order Block:* \`${ob_bottom} - ${ob_top}\`\n` +
      `*Retest Price:* \`${retest_price}\`\n` +
      `*TV Alert Time:* \`${alertDate}\`\n\n` +
      `⏳ _Awaiting FXSSI confirmation..._`;
    sendTelegramNotification(initialWebhookMessage, true);
  }
});

app.get("/", (req, res) => {
  res.send("FXSSI Telegram Bot with TradingView Webhook is running!");
});
// --- End Express App Setup ---

function getEmojiForSignal(signal) {
  if (!signal) return "❔";
  const upperSignal = signal.toUpperCase();
  if (upperSignal.includes("BUY GOLD")) return "📈";
  if (upperSignal.includes("SELL GOLD")) return "📉";
  if (upperSignal.includes("HOLD GOLD")) return "⚖️";
  if (upperSignal.includes("BUY")) return "📈"; // General BUY
  if (upperSignal.includes("SELL")) return "📉"; // General SELL
  if (upperSignal.includes("HOLD")) return "⚖️"; // General HOLD
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
    bot.sendMessage(chatId, responseMessage);
    console.log(
      `User ${userName} (Chat ID: ${chatId}) subscribed via /start command.`
    );
    if (lastSuccessfulResults.length > 0 && subscribedChatId) {
      sendInitialSignalsSnapshot(
        lastSuccessfulResults,
        `📊 สรุป Sentiment FXSSI (ข้อมูลล่าสุด)`,
        lastServerTimeText
      );
    }
    if (previousXauUsdSpecialSignal && subscribedChatId) {
      const xauAvg = jsonDataCacheForStartup?.pairs?.XAUUSD?.average
        ? parseFloat(jsonDataCacheForStartup.pairs.XAUUSD.average).toFixed(2)
        : "N/A";
      const usdxAvg = jsonDataCacheForStartup?.pairs?.USDX?.average
        ? parseFloat(jsonDataCacheForStartup.pairs.USDX.average).toFixed(2)
        : "N/A";
      const specialXauMessage = `*🚀 สัญญาณทองคำพิเศษ (XAUUSD vs USDX):*\n${getEmojiForSignal(
        previousXauUsdSpecialSignal
      )} \`${previousXauUsdSpecialSignal}\`\n   XAUUSD avg: ${xauAvg}%\n   USDX avg: ${usdxAvg}%`;
      sendTelegramNotification(specialXauMessage, true);
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
    message =
      `*${title}*\n\nรายการสัญญาณยาวเกินไป.\n` +
      (serverTimeText && serverTimeText !== "N/A"
        ? `_ข้อมูล FXSSI ณ ${serverTimeText} (Server Time)_`
        : "");
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
      `Failed to send Telegram notification to ${subscribedChatId}: Bot was blocked. Resetting subscription.`
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
        ? error.message.substring(0, 200)
        : "Unknown Telegram send error"
    );
  }
}

// Function to clean up old pending webhook signals
function cleanupPendingWebhooks() {
  const now = Date.now();
  pendingWebhookSignals = pendingWebhookSignals.filter((signal) => {
    if (now - signal.timestamp > WEBHOOK_CONFIRMATION_TIMEOUT_MS) {
      console.log(
        `Pending webhook signal ID ${signal.id} for ${signal.fxssiSymbol} timed out and removed.`
      );
      return false;
    }
    return true;
  });
}

async function fetchDataAndProcessFxssi() {
  const fetchTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
  });
  console.log(`\n[${fetchTime}] Fetching new data from FXSSI...`);

  cleanupPendingWebhooks(); // Clean up old webhooks before fetching new FXSSI data

  try {
    const response = await axios.get(API_URL_FXSSI);
    const jsonData = response.data;
    jsonDataCacheForStartup = jsonData;

    if (jsonData && jsonData.pairs) {
      lastServerTimeText = jsonData.server_time_text || "N/A";
      console.log(`FXSSI Data fetched. Server time: ${lastServerTimeText}`);
      const currentRunResults = [];

      // --- Process General FXSSI Signals ---
      for (const pairSymbolFxssi in jsonData.pairs) {
        // e.g., XAUUSD, EURUSD
        if (jsonData.pairs.hasOwnProperty(pairSymbolFxssi)) {
          const pairData = jsonData.pairs[pairSymbolFxssi];
          if (pairData && pairData.hasOwnProperty("average")) {
            const buyPercentage = parseFloat(pairData.average);
            if (isNaN(buyPercentage)) continue;
            let overallSignalFxssi = "HOLD"; // FXSSI Overall Signal
            if (buyPercentage > 55)
              overallSignalFxssi =
                "SELL"; // High buyers -> potential SELL (contrarian for FXSSI sentiment)
            else if (buyPercentage < 45) overallSignalFxssi = "BUY"; // Low buyers -> potential BUY
            currentRunResults.push({
              symbol: pairSymbolFxssi.toUpperCase(), // Ensure uppercase for matching
              buyPercentage: buyPercentage,
              overallSignal: overallSignalFxssi,
            });

            // --- Check for Webhook Confirmation ---
            const pendingSignalsForThisSymbol = pendingWebhookSignals.filter(
              (pSignal) =>
                pSignal.fxssiSymbol === pairSymbolFxssi.toUpperCase() &&
                !pSignal.confirmed
            );

            for (const pendingSignal of pendingSignalsForThisSymbol) {
              const webhookSignalType = pendingSignal.data.signal; // e.g., "BUY_RETEST", "SELL_RETEST"
              let match = false;

              if (
                overallSignalFxssi === "BUY" &&
                webhookSignalType.toUpperCase().startsWith("BUY")
              ) {
                match = true;
              } else if (
                overallSignalFxssi === "SELL" &&
                webhookSignalType.toUpperCase().startsWith("SELL")
              ) {
                match = true;
              }

              if (match) {
                console.log(
                  `CONFIRMED: FXSSI ${overallSignalFxssi} for ${pairSymbolFxssi} matches Webhook ${webhookSignalType}`
                );
                const {
                  symbol,
                  timeframe,
                  ob_bottom,
                  ob_top,
                  retest_price,
                  alert_timestamp,
                } = pendingSignal.data;
                const alertDateTV = new Date(
                  Number(alert_timestamp)
                ).toLocaleString("th-TH", {
                  timeZone: "Asia/Bangkok",
                  hour12: false,
                });

                const confirmationMessage =
                  `✅ *CONFIRMED SIGNAL: ${pairSymbolFxssi} ${overallSignalFxssi}!*\n\n` +
                  `*TradingView Signal:* \`${webhookSignalType}\` (on \`${timeframe}\`)\n` +
                  `*FXSSI Sentiment:* \`${overallSignalFxssi}\` (Buyers: ${buyPercentage.toFixed(
                    2
                  )}%)\n\n` +
                  `*Details from TradingView:*\n` +
                  `  Symbol: \`${symbol}\`\n` +
                  `  Order Block: \`${ob_bottom} - ${ob_top}\`\n` +
                  `  Retest Price: \`${retest_price}\`\n` +
                  `  TV Alert Time: \`${alertDateTV}\`\n\n` +
                  `_Signal confirmed by FXSSI at ${new Date().toLocaleTimeString(
                    "th-TH",
                    { timeZone: "Asia/Bangkok", hour12: false }
                  )}_`;
                sendTelegramNotification(confirmationMessage, true);
                pendingSignal.confirmed = true; // Mark as confirmed
              }
            }
          }
        }
      }
      // Remove confirmed signals from pending list
      pendingWebhookSignals = pendingWebhookSignals.filter((s) => !s.confirmed);

      currentRunResults.sort((a, b) => b.buyPercentage - a.buyPercentage);
      lastSuccessfulResults = [...currentRunResults];

      // ... (rest of your FXSSI general signal change detection logic) ...
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
          "📊 สรุป Sentiment FXSSI (ข้อมูลแรก)",
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
            const message = `🔔 *${
              result.symbol
            } FXSSI เปลี่ยนแปลง!* ${getEmojiForSignal(
              currentOverallSignal
            )}\n   จาก: \`${lastOverallSignal}\`  เป็น: \`${currentOverallSignal}\`\n   Sentiment (ผู้ซื้อ): ${sentimentBuyBase}%`;
            sendTelegramNotification(message, false);
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
      }

      // ... (rest of your XAUUSD special signal logic) ...
      if (jsonData.pairs.XAUUSD?.average && jsonData.pairs.USDX?.average) {
        const xauusdAvg = parseFloat(jsonData.pairs.XAUUSD.average);
        const usdxAvg = parseFloat(jsonData.pairs.USDX.average);
        let currentXauUsdSpecialSignal = "HOLD GOLD";
        if (xauusdAvg < 45 && usdxAvg < 50)
          currentXauUsdSpecialSignal =
            "BUY GOLD (XAU Low Buyers, USDX Neutral/Weak)";
        else if (xauusdAvg > 55 && usdxAvg > 50)
          currentXauUsdSpecialSignal =
            "SELL GOLD (XAU High Buyers, USDX Strong)";
        else if (xauusdAvg < 45)
          currentXauUsdSpecialSignal = "Consider BUY GOLD (XAU Low Buyers)";
        else if (xauusdAvg > 55)
          currentXauUsdSpecialSignal = "Consider SELL GOLD (XAU High Buyers)";

        if (previousXauUsdSpecialSignal === null && subscribedChatId) {
          /* console.log(`Initial special XAUUSD signal: ${currentXauUsdSpecialSignal}`); */
        } else if (
          previousXauUsdSpecialSignal !== null &&
          currentXauUsdSpecialSignal !== previousXauUsdSpecialSignal
        ) {
          console.log(
            `Special XAUUSD signal changed: ${currentXauUsdSpecialSignal}. Sending notification.`
          );
          const message = `🔔 *XAUUSD สัญญาณพิเศษ เปลี่ยนแปลง!* ${getEmojiForSignal(
            currentXauUsdSpecialSignal
          )}\n   จาก: \`${previousXauUsdSpecialSignal}\`\n   เป็น: \`${currentXauUsdSpecialSignal}\`\n   ข้อมูล:\n     - XAUUSD Sentiment (ผู้ซื้อ): ${xauusdAvg.toFixed(
            2
          )}%\n     - USDX Sentiment (ผู้ซื้อ): ${usdxAvg.toFixed(2)}%`;
          sendTelegramNotification(message, true);
        }
        previousXauUsdSpecialSignal = currentXauUsdSpecialSignal;
      } else {
        console.log(
          "XAUUSD or USDX data not available for special signal processing."
        );
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
    const randomOffset =
      Math.random() * 2 * RANDOM_VARIATION_MS - RANDOM_VARIATION_MS;
    const nextInterval = BASE_INTERVAL_MS + randomOffset;
    setTimeout(fetchDataAndProcessFxssi, nextInterval);
  }
}

// --- Initialization ---
console.log(
  "Initializing FXSSI Signal Monitor with TradingView Webhook Confirmation..."
);
if (TELEGRAM_BOT_TOKEN) {
  app
    .listen(WEBHOOK_PORT, () => {
      console.log(
        `Express server with Webhook listening on port ${WEBHOOK_PORT}`
      );
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
      process.exit(1);
    });
  fetchDataAndProcessFxssi();
  console.log(
    "FXSSI Signal Monitor & Webhook Confirmation running. Press Ctrl+C to stop."
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
  process.exit(1);
}
