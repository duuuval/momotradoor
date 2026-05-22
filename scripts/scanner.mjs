import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { createRequire } from 'module';

// Force the bulletproof CommonJS import
const require = createRequire(import.meta.url);
const yahooFinance = require('yahoo-finance2').default;

// The Math: Exponential Moving Average
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runScanner() {
  console.log("🚀 Starting Overnight Momentum Scan...");

  // 1. Fetch S&P 400 (Mid) and S&P 600 (Small) Tickers from Wikipedia
  const urls = [
    'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies',
    'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies'
  ];
  let universe = [];
  
  for (const url of urls) {
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);
    $('#constituents tbody tr').each((i, el) => {
      if (i === 0) return; // Skip header
      const ticker = $(el).find('td').eq(0).text().trim();
      // Skip tickers with dots (like BRK.B) as Yahoo format differs
      if (ticker && !ticker.includes('.')) universe.push(ticker); 
    });
  }
  
  console.log(`📡 Pulled ${universe.length} Mid/Small Cap Tickers.`);

  // 2. Filter for Liquidity (Price > 10, Vol > 500k) using Bulk Quotes
  let liquidTickers = [];
  const chunkSize = 100; // Bulk query Yahoo in chunks of 100
  for (let i = 0; i < universe.length; i += chunkSize) {
    const chunk = universe.slice(i, i + chunkSize);
    try {
      const quotes = await yahooFinance.quote(chunk);
      for (const q of quotes) {
        if (q.regularMarketPrice >= 10 && q.averageDailyVolume10Day >= 500000) {
          liquidTickers.push(q.symbol);
        }
      }
    } catch (e) {
      console.log('Error fetching quote chunk', e.message);
    }
  }

  console.log(`⚖️ Liquidity Filter complete. ${liquidTickers.length} stocks remain.`);

  // 3. The Momentum Math (Fetch Historical Data)
  const signals = [];
  // Grab ~4 months of data to calculate a 50-day EMA
  const queryOptions = { period1: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] }; 

  for (let i = 0; i < liquidTickers.length; i++) {
    const ticker = liquidTickers[i];
    try {
      const history = await yahooFinance.historical(ticker, queryOptions);
      if (history.length < 50) continue; // Not enough trading days

      const closes = history.map(day => day.close);
      const volumes = history.map(day => day.volume);
      
      const currentPrice = closes[closes.length - 1];
      const recentVolume = volumes[volumes.length - 1];
      
      const ema20 = calculateEMA(closes, 20);
      const ema50 = calculateEMA(closes, 50);
      
      // Calculate 10-day average volume (skipping today's breakout volume)
      const avgVolume = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10; 

      // The Strategy Rules
      const isAccelerating = ema20 > ema50;
      const isAboveSupport = currentPrice > ema20;
      const isVolumeSpiking = recentVolume > (avgVolume * 1.5);

      if (isAccelerating && isAboveSupport && isVolumeSpiking) {
        signals.push({
          ticker,
          price: currentPrice.toFixed(2),
          ema20: ema20.toFixed(2),
          stopLoss: (currentPrice * 0.93).toFixed(2), // Strict 7% Stop Loss
          volumeSpike: (recentVolume / avgVolume).toFixed(1) + 'x',
          dateFound: new Date().toISOString().split('T')[0]
        });
        console.log(`🔥 SIGNAL FOUND: ${ticker}`);
      }

      // Small 200ms pause to respect Yahoo's servers
      await sleep(200);

    } catch (e) {
      // Silently skip broken/delisted tickers
    }
  }

  // 4. Save directly into the Next.js public folder
  const outputPath = path.join(process.cwd(), 'public', 'signals.json');
  fs.writeFileSync(outputPath, JSON.stringify(signals, null, 2));
  console.log(`✅ Scan Complete. Saved ${signals.length} signals.`);
}

runScanner();
