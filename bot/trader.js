#!/usr/bin/env node
/**
 * Trading Bot — Paper trades BTC, ETH, SOL on 5-minute intervals.
 *
 * - Fetches live prices from CoinGecko (free, no key)
 * - Computes 14-period RSI from stored price history
 * - Generates BUY/SELL/HOLD signals
 * - Opens/closes paper positions based on signals
 * - Writes dashboard-data.json and pushes to GitHub
 *
 * Usage:
 *   node trader.js          # runs in a loop every 5 minutes
 *   node trader.js --once   # runs once and exits
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DATA_FILE = join(PROJECT_ROOT, 'dashboard-data.json');
const PRICE_HISTORY_FILE = join(__dirname, 'price-history.json');

// ─── Config ──────────────────────────────────────────────────────────
const TICKERS = ['BTC', 'ETH', 'SOL'];
const COINGECKO_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_BALANCE = 10000;

// RSI parameters
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

// Position sizing: risk a small fixed dollar amount per trade
const POSITION_SIZE_USD = 50; // $50 per position
const MAX_OPEN_POSITIONS = 3;

// ─── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function fetchPrices() {
  const ids = TICKERS.map(t => COINGECKO_IDS[t]).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`CoinGecko API error: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();
  const prices = {};
  for (const ticker of TICKERS) {
    const id = COINGECKO_IDS[ticker];
    if (json[id]?.usd) {
      prices[ticker] = json[id].usd;
    }
  }
  return prices;
}

// ─── Price History (for RSI) ─────────────────────────────────────────

function loadPriceHistory() {
  if (existsSync(PRICE_HISTORY_FILE)) {
    return JSON.parse(readFileSync(PRICE_HISTORY_FILE, 'utf8'));
  }
  // Initialize empty history per ticker
  const history = {};
  for (const t of TICKERS) history[t] = [];
  return history;
}

function savePriceHistory(history) {
  writeFileSync(PRICE_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function recordPrices(history, prices) {
  const now = new Date().toISOString();
  for (const ticker of TICKERS) {
    if (prices[ticker] !== undefined) {
      history[ticker].push({ time: now, price: prices[ticker] });
      // Keep last 100 data points (enough for RSI-14)
      if (history[ticker].length > 100) {
        history[ticker] = history[ticker].slice(-100);
      }
    }
  }
}

// ─── RSI Calculation ─────────────────────────────────────────────────

function calculateRSI(pricePoints) {
  if (pricePoints.length < RSI_PERIOD + 1) {
    return null; // Not enough data
  }

  const prices = pricePoints.map(p => p.price);
  const recent = prices.slice(-(RSI_PERIOD + 1));

  let gains = 0;
  let losses = 0;

  for (let i = 1; i < recent.length; i++) {
    const change = recent[i] - recent[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / RSI_PERIOD;
  const avgLoss = losses / RSI_PERIOD;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─── Signal Generation ───────────────────────────────────────────────

function generateSignal(ticker, rsi) {
  if (rsi === null) {
    return {
      symbol: ticker,
      signal: 'HOLD',
      reason: 'Insufficient data for RSI',
      confidence: 'LOW',
      rsi: 50,
      time: new Date().toISOString(),
    };
  }

  let signal = 'HOLD';
  let reason = `RSI neutral (${rsi.toFixed(1)})`;
  let confidence = 'LOW';

  if (rsi >= RSI_OVERBOUGHT) {
    signal = 'SELL';
    reason = `RSI overbought (${rsi.toFixed(1)})`;
    confidence = rsi >= 80 ? 'HIGH' : 'HIGH';
  } else if (rsi <= RSI_OVERSOLD) {
    signal = 'BUY';
    reason = `RSI oversold (${rsi.toFixed(1)})`;
    confidence = rsi <= 20 ? 'HIGH' : 'HIGH';
  } else if (rsi < 40) {
    signal = 'BUY';
    reason = `RSI approaching oversold (${rsi.toFixed(1)})`;
    confidence = 'LOW';
  } else if (rsi > 60) {
    signal = 'SELL';
    reason = `RSI approaching overbought (${rsi.toFixed(1)})`;
    confidence = 'LOW';
  }

  return {
    symbol: ticker,
    signal,
    reason,
    confidence,
    rsi: rsi !== null ? parseFloat(rsi.toFixed(1)) : 50,
    time: new Date().toISOString(),
  };
}

// ─── Dashboard Data ──────────────────────────────────────────────────

function loadDashboardData() {
  if (existsSync(DATA_FILE)) {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  }
  return {
    balance: INITIAL_BALANCE,
    positions: [],
    trades: [],
    equityHistory: [],
    signals: [],
    lastUpdated: null,
  };
}

function saveDashboardData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Trade Execution ─────────────────────────────────────────────────

function executeTradeLogic(data, signals, prices) {
  const now = new Date().toISOString();

  // --- Close positions that have opposing signals ---
  const positionsToClose = [];
  for (const pos of data.positions) {
    const signal = signals.find(s => s.symbol === pos.symbol);
    if (!signal) continue;

    const currentPrice = prices[pos.symbol];
    if (currentPrice === undefined) continue;

    // Close LONG if SELL signal with HIGH confidence
    if (pos.side === 'LONG' && signal.signal === 'SELL' && signal.confidence === 'HIGH') {
      positionsToClose.push({ pos, currentPrice, reason: signal.reason });
    }
    // Close SHORT if BUY signal with HIGH confidence
    if (pos.side === 'SHORT' && signal.signal === 'BUY' && signal.confidence === 'HIGH') {
      positionsToClose.push({ pos, currentPrice, reason: signal.reason });
    }
  }

  for (const { pos, currentPrice, reason } of positionsToClose) {
    const pnl = pos.side === 'LONG'
      ? (currentPrice - pos.entry) * pos.qty
      : (pos.entry - currentPrice) * pos.qty;
    const pnlPct = ((pnl / (pos.entry * pos.qty)) * 100);

    data.trades.push({
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      entry: pos.entry,
      exit: currentPrice,
      reason: `Closed: ${reason}`,
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      closedAt: now,
    });

    data.balance += (pos.entry * pos.qty) + pnl; // return capital + P&L
    data.positions = data.positions.filter(p => p !== pos);
    log(`CLOSED ${pos.side} ${pos.symbol}: P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
  }

  // --- Open new positions on HIGH confidence signals ---
  for (const signal of signals) {
    if (signal.confidence !== 'HIGH') continue;
    if (signal.signal === 'HOLD') continue;

    const currentPrice = prices[signal.symbol];
    if (currentPrice === undefined) continue;

    // Don't open if we already have a position in this ticker
    if (data.positions.some(p => p.symbol === signal.symbol)) continue;

    // Don't exceed max positions
    if (data.positions.length >= MAX_OPEN_POSITIONS) continue;

    // Don't trade if insufficient balance
    if (data.balance < POSITION_SIZE_USD) continue;

    const side = signal.signal === 'BUY' ? 'LONG' : 'SHORT';
    const qty = parseFloat((POSITION_SIZE_USD / currentPrice).toFixed(6));
    const cost = qty * currentPrice;

    data.balance -= cost;
    data.positions.push({
      symbol: signal.symbol,
      side,
      qty,
      entry: currentPrice,
      current: currentPrice,
      pnl: 0,
      pnlPct: 0,
    });

    log(`OPENED ${side} ${signal.symbol}: ${qty} @ $${currentPrice.toLocaleString()} ($${cost.toFixed(2)}) — ${signal.reason}`);
  }

  // --- Update current prices on open positions ---
  for (const pos of data.positions) {
    const currentPrice = prices[pos.symbol];
    if (currentPrice === undefined) continue;

    pos.current = currentPrice;
    const pnl = pos.side === 'LONG'
      ? (currentPrice - pos.entry) * pos.qty
      : (pos.entry - currentPrice) * pos.qty;
    const pnlPct = ((pnl / (pos.entry * pos.qty)) * 100);

    pos.pnl = parseFloat(pnl.toFixed(2));
    pos.pnlPct = parseFloat(pnlPct.toFixed(2));
  }

  // --- Update equity history ---
  const posValue = data.positions.reduce((sum, p) => sum + (p.qty * p.current), 0);
  const equity = parseFloat((data.balance + posValue).toFixed(2));
  data.equityHistory.push({ time: now, equity });

  // Keep last 200 equity points
  if (data.equityHistory.length > 200) {
    data.equityHistory = data.equityHistory.slice(-200);
  }

  // --- Finalize ---
  data.balance = parseFloat(data.balance.toFixed(2));
  data.lastUpdated = now;

  return data;
}

// ─── Git Push ────────────────────────────────────────────────────────

function pushToGitHub() {
  try {
    // Pull latest first to avoid conflicts
    try {
      execSync('git pull --rebase origin main', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    } catch (pullErr) {
      // If rebase conflicts, abort and do a merge-based pull preferring our changes
      try { execSync('git rebase --abort', { cwd: PROJECT_ROOT, stdio: 'pipe' }); } catch (_) {}
      try { execSync('git pull -X ours origin main', { cwd: PROJECT_ROOT, stdio: 'pipe' }); } catch (_) {}
    }

    execSync('git add dashboard-data.json .gitignore bot/', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    const timestamp = new Date().toISOString();
    execSync(`git commit -m "Bot update ${timestamp}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    log('Pushed update to GitHub');
  } catch (e) {
    const msg = (e.stderr?.toString() || '') + (e.stdout?.toString() || '');
    if (msg.includes('nothing to commit')) {
      log('No changes to push');
    } else {
      log(`Git push error: ${e.message}`);
    }
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────

async function tick() {
  log('─── Tick starting ───');

  // 1. Fetch prices
  let prices;
  try {
    prices = await fetchPrices();
    log(`Prices: ${TICKERS.map(t => `${t}=$${prices[t]?.toLocaleString() || '?'}`).join(', ')}`);
  } catch (e) {
    log(`Price fetch failed: ${e.message}`);
    return;
  }

  // 2. Record to price history and compute RSI
  const history = loadPriceHistory();
  recordPrices(history, prices);
  savePriceHistory(history);

  // 3. Generate signals
  const signals = [];
  for (const ticker of TICKERS) {
    const rsi = calculateRSI(history[ticker]);
    const signal = generateSignal(ticker, rsi);
    signals.push(signal);
    log(`${ticker}: RSI=${rsi !== null ? rsi.toFixed(1) : 'N/A'} → ${signal.signal} (${signal.confidence})`);
  }

  // 4. Load dashboard data and execute trades
  const data = loadDashboardData();
  data.signals = signals;
  executeTradeLogic(data, signals, prices);

  // 5. Save and push
  saveDashboardData(data);
  pushToGitHub();

  log(`Balance: $${data.balance.toFixed(2)} | Positions: ${data.positions.length} | Trades: ${data.trades.length}`);
  log('─── Tick complete ───\n');
}

// ─── Entry Point ─────────────────────────────────────────────────────

const runOnce = process.argv.includes('--once');

if (runOnce) {
  log('Running single tick...');
  await tick();
  log('Done.');
} else {
  log('Trading bot started — running every 5 minutes');
  log(`Tickers: ${TICKERS.join(', ')}`);
  log(`Position size: $${POSITION_SIZE_USD}`);
  log(`RSI period: ${RSI_PERIOD} | Overbought: ${RSI_OVERBOUGHT} | Oversold: ${RSI_OVERSOLD}`);

  // Run immediately, then every 5 minutes
  await tick();
  setInterval(async () => {
    try {
      await tick();
    } catch (e) {
      log(`Tick error: ${e.message}`);
    }
  }, INTERVAL_MS);
}
