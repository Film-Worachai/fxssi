const axios = require("axios");

const url = "https://c.fxssi.com/api/current-ratios";

axios
  .get(url)
  .then((response) => {
    const jsonData = response.data;

    if (jsonData && jsonData.pairs) {
      const results = []; // Array สำหรับเก็บผลลัพธ์เพื่อนำไปเรียงลำดับ

      for (const pairSymbol in jsonData.pairs) {
        if (jsonData.pairs.hasOwnProperty(pairSymbol)) {
          const pairData = jsonData.pairs[pairSymbol];
          if (pairData && pairData.hasOwnProperty("average")) {
            const averageValue = parseFloat(pairData.average);

            if (isNaN(averageValue)) {
              // อาจจะเลือกที่จะ log หรือข้ามไปเลยก็ได้
              // console.log(`${pairSymbol}: Average data is not a valid number (${pairData.average})`);
              continue;
            }

            let signal = "HOLD (or no signal)";
            if (averageValue > 55) {
              signal = "SELL";
            } else if (averageValue < 45) {
              signal = "BUY";
            }

            results.push({
              symbol: pairSymbol,
              average: averageValue,
              signal: signal,
            });
          }
        }
      }

      // เรียงลำดับ results array ตาม average จากมากไปน้อย
      results.sort((a, b) => b.average - a.average);

      console.log(
        "Trading signals based on average values (sorted high to low):"
      );
      results.forEach((result) => {
        console.log(
          `${result.symbol} (Average: ${result.average.toFixed(2)}): ${
            result.signal
          }`
        );
      });
    } else {
      console.log("Could not find 'pairs' data in the response.");
    }
  })
  .catch((error) => {
    console.error("Error fetching data:", error.message);
    if (error.response) {
      // เซิร์ฟเวอร์ตอบกลับมาด้วยสถานะที่ไม่ใช่ 2xx
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    } else if (error.request) {
      // request ถูกส่งไปแล้วแต่ไม่ได้รับการตอบกลับ
      console.error("No response received:", error.request);
    } else {
      // เกิดข้อผิดพลาดบางอย่างในการตั้งค่า request
      console.error("Error setting up request:", error.message);
    }
  });
