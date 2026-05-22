import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] !== null) {
        ema = prices[i] * k + ema * (1 - k);
    }
  }
  return ema;
}

async function runScanner() {
  console.log("🚀 Starting Overnight Momentum Scan...");

  // 1. Fetch Universe from Wikipedia
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
      if (i === 0) return;
      const ticker = $(el).find('td').eq(0).text().trim();
      if (ticker && !ticker.includes('.')) universe.push(ticker); 
    });
  }
  
  console.log(`📡 Pulled ${universe.length} Mid/Small Cap Tickers.`);

  const signals = [];

  // 2. Loop through and pull raw JSON from Yahoo's public chart API
  for (let i = 0; i < universe.length; i++) {
    const ticker = universe[i];
    
    try {
      // Pull 6 months of historical daily candles
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=6mo`;
      const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const data = await res.json();
      
      if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
          await sleep(200);
          continue;
      }
      
      const result = data.chart.result[0];
      const currentPrice = result.meta.regularMarketPrice;
      
      const quotes = result.indicators.quote[0];
      const closes = quotes.close || [];
      const volumes = quotes.volume || [];
      
      // Clean data (Yahoo sometimes returns null for halted days)
      const validCloses = closes.filter(c => c !== null);
      const validVolumes = volumes.filter(v => v !== null);

      // Filter: Must have enough history and be over $10
      if (validCloses.length < 50 || currentPrice < 10) {
          await sleep(200);
          continue;
      }
      
      const recentVolume = validVolumes[validVolumes.length - 1];
      const avgVolume = validVolumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
      
      // Filter: Must trade at least 500k shares a day
      if (avgVolume < 500000) {
          await sleep(200);
          continue;
      }

      // The Momentum Math
      const ema20 = calculateEMA(validCloses, 20);
      const ema50 = calculateEMA(validCloses, 50);

      const isAccelerating = ema20 > ema50;
      const isAboveSupport = currentPrice > ema20;
      const isVolumeSpiking = recentVolume > (avgVolume * 1.5);

      if (isAccelerating && isAboveSupport && isVolumeSpiking) {
        signals.push({
          ticker,
          price: currentPrice.toFixed(2),
          ema20: ema20.toFixed(2),
          stopLoss: (currentPrice * 0.93).toFixed(2),
          volumeSpike: (recentVolume / avgVolume).toFixed(1) + 'x',
          dateFound: new Date().toISOString().split('T')[0]
        });
        console.log(`🔥 SIGNAL FOUND: ${ticker}`);
      }
      
    } catch (e) {
      // Silently skip broken tickers so the loop doesn't die
    }

    // Log progress every 100 stocks so GitHub Actions doesn't timeout the visual log
    if (i > 0 && i % 100 === 0) {
        console.log(`⏳ Processed ${i}/${universe.length} stocks...`);
    }

    // Pause 200ms between calls to stay under Yahoo's radar
    await sleep(200); 
  }

  // 3. Save the payload
  const outputPath = path.join(process.cwd(), 'public', 'signals.json');
  fs.writeFileSync(outputPath, JSON.stringify(signals, null, 2));
  console.log(`✅ Scan Complete. Saved ${signals.length} signals.`);
}

runScanner();
