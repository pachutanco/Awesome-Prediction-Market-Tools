import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HERE, "state.json");
const SNAP_PATH = path.join(HERE, "snapshots.jsonl");
const REPORT_PATH = path.join(HERE, "report.json");

const ASSETS = [
  { key: "BTC", slug: "btc" },
  { key: "ETH", slug: "eth" },
  { key: "SOL", slug: "sol" },
];

const RUN_SECONDS = Number(process.env.RUN_SECONDS || 220);
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS || 10);
const QUOTE_SIZE = Number(process.env.QUOTE_SIZE || 5);
const MAX_INV = Number(process.env.MAX_INV || 25);
const PAPER_CAPITAL = Number(process.env.PAPER_CAPITAL || 1000);
const TAKER_FEE_RATE = 0.07;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    const existing = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!existing.startedAt) existing.startedAt = nowIso();
    existing.strategies.maker_inventory.quotes ||= {};
    existing.strategies.taker_pair.entered ||= {};
    return existing;
  }
  return {
    version: 1,
    startedAt: nowIso(),
    samples: 0,
    marketsSeen: {},
    settled: {},
    lastBooks: {},
    strategies: {
      maker_inventory: {
        realizedPnl: 0, grossProfit: 0, grossLoss: 0, fills: 0,
        positions: {}, quotes: {}, equityCurve: []
      },
      taker_pair: {
        realizedPnl: 0, grossProfit: 0, grossLoss: 0, fills: 0,
        positions: {}, entered: {}, equityCurve: []
      }
    }
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function getJson(url, opts={}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "accept": "application/json", "user-agent": "norm1e69-paper/1.0", ...(opts.headers||{}) }
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function parseMaybeJson(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch { return null; }
}

function marketSlug(asset, ms=Date.now()) {
  const epoch = Math.floor(Math.floor(ms / 1000) / 300) * 300;
  return `${asset.slug}-updown-5m-${epoch}`;
}

async function fetchMarketBySlug(slug) {
  const event = await getJson(`https://gamma-api.polymarket.com/events/slug/${slug}`);
  const m = event?.markets?.[0];
  if (!m) throw new Error(`No market in event ${slug}`);
  const tokens = parseMaybeJson(m.clobTokenIds);
  const outcomes = parseMaybeJson(m.outcomes) || ["Up", "Down"];
  if (!tokens || tokens.length < 2) throw new Error(`No CLOB tokens for ${slug}`);
  const indexUp = outcomes.findIndex(x => String(x).toLowerCase() === "up");
  const indexDown = outcomes.findIndex(x => String(x).toLowerCase() === "down");
  const upIdx = indexUp >= 0 ? indexUp : 0;
  const downIdx = indexDown >= 0 ? indexDown : 1;
  return { event, market: m, upToken: tokens[upIdx], downToken: tokens[downIdx] };
}

async function fetchBook(token) {
  return getJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(token)}`);
}

function levelPrice(level) { return Number(level?.price); }
function bestBid(book) {
  const vals=(book?.bids||[]).map(levelPrice).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : NaN;
}
function bestAsk(book) {
  const vals=(book?.asks||[]).map(levelPrice).filter(Number.isFinite);
  return vals.length ? Math.min(...vals) : NaN;
}
function tick(book) { const t=Number(book?.tick_size || book?.tickSize || 0.01); return Number.isFinite(t)&&t>0?t:0.01; }

function ensurePos(strategy, slug) {
  strategy.positions[slug] ||= {
    up: { qty: 0, avg: 0 },
    down: { qty: 0, avg: 0 },
  };
  return strategy.positions[slug];
}

function addBuy(pos, qty, price) {
  const cost = pos.qty * pos.avg + qty * price;
  pos.qty += qty;
  pos.avg = pos.qty ? cost / pos.qty : 0;
}
function addSell(strategy, pos, qty, price) {
  qty = Math.min(qty, pos.qty);
  if (qty <= 0) return;
  const pnl = (price - pos.avg) * qty;
  strategy.realizedPnl += pnl;
  if (pnl >= 0) strategy.grossProfit += pnl; else strategy.grossLoss += -pnl;
  pos.qty -= qty;
  if (pos.qty <= 1e-9) { pos.qty = 0; pos.avg = 0; }
}
function takerFee(price, qty) {
  return qty * TAKER_FEE_RATE * price * (1 - price);
}

function applyMakerFills(state, slug, snap) {
  const s = state.strategies.maker_inventory;
  const q = s.quotes[slug];
  if (!q) return;
  const p = ensurePos(s, slug);
  for (const side of ["up","down"]) {
    const cur = snap[side];
    const pos = p[side];
    const prev = q[side] || {};
    if (prev.buy && Number.isFinite(cur.ask) && cur.ask <= prev.buy && pos.qty + QUOTE_SIZE <= MAX_INV) {
      addBuy(pos, QUOTE_SIZE, prev.buy);
      s.fills++;
    }
    if (prev.sell && Number.isFinite(cur.bid) && cur.bid >= prev.sell && pos.qty >= QUOTE_SIZE) {
      addSell(s, pos, QUOTE_SIZE, prev.sell);
      s.fills++;
    }
  }
}

function makeMakerQuotes(state, slug, snap) {
  const s = state.strategies.maker_inventory;
  const p = ensurePos(s, slug);
  const quotes = {};
  for (const side of ["up","down"]) {
    const cur=snap[side];
    const pos=p[side];
    const t=cur.tick;
    let buy=null, sell=null;
    if (Number.isFinite(cur.bid) && Number.isFinite(cur.ask) && cur.ask-cur.bid >= 2*t) {
      if (pos.qty + QUOTE_SIZE <= MAX_INV) buy = Math.min(cur.ask - t, cur.bid + t);
      if (pos.qty >= QUOTE_SIZE) sell = Math.max(cur.bid + t, cur.ask - t);
    }
    quotes[side] = { buy, sell };
  }

  // Inventory skew: if one leg is heavier, stop adding to it until the other catches up.
  const delta = p.up.qty - p.down.qty;
  if (delta >= QUOTE_SIZE && quotes.up) quotes.up.buy = null;
  if (delta <= -QUOTE_SIZE && quotes.down) quotes.down.buy = null;
  s.quotes[slug] = quotes;
}

function maybeEnterTakerPair(state, slug, snap) {
  const s = state.strategies.taker_pair;
  if (s.entered[slug]) return;
  const up=snap.up.ask, dn=snap.down.ask;
  if (![up,dn].every(Number.isFinite)) return;
  const fees = takerFee(up, QUOTE_SIZE) + takerFee(dn, QUOTE_SIZE);
  const grossCost = (up + dn) * QUOTE_SIZE;
  const guaranteedPayout = QUOTE_SIZE;
  const edge = guaranteedPayout - grossCost - fees;
  // Only simulate if the observed executable prices leave a real net cushion.
  if (edge > 0.01 * QUOTE_SIZE) {
    const p=ensurePos(s,slug);
    addBuy(p.up,QUOTE_SIZE,up + takerFee(up,QUOTE_SIZE)/QUOTE_SIZE);
    addBuy(p.down,QUOTE_SIZE,dn + takerFee(dn,QUOTE_SIZE)/QUOTE_SIZE);
    s.entered[slug]={ts:nowIso(),up,dn,edge};
    s.fills += 2;
  }
}

function resolutionPrices(market) {
  const p=parseMaybeJson(market?.outcomePrices);
  if (!p || p.length < 2) return null;
  const nums=p.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  if (Math.max(...nums) < 0.98) return null;
  const outcomes=parseMaybeJson(market?.outcomes) || ["Up","Down"];
  const upIdx=outcomes.findIndex(x=>String(x).toLowerCase()==="up");
  const dnIdx=outcomes.findIndex(x=>String(x).toLowerCase()==="down");
  return {
    up: nums[upIdx>=0?upIdx:0],
    down: nums[dnIdx>=0?dnIdx:1],
  };
}

function settleStrategy(strategy, slug, prices) {
  const p=strategy.positions[slug];
  if (!p) return;
  for (const side of ["up","down"]) {
    const pos=p[side];
    if (pos.qty <= 0) continue;
    const pnl=(prices[side]-pos.avg)*pos.qty;
    strategy.realizedPnl += pnl;
    if (pnl>=0) strategy.grossProfit += pnl; else strategy.grossLoss += -pnl;
    pos.qty=0; pos.avg=0;
  }
}

async function settleOldMarkets(state) {
  const nowSec=Math.floor(Date.now()/1000);
  const slugs=Object.keys(state.marketsSeen).filter(slug => !state.settled[slug]);
  for (const slug of slugs.slice(-80)) {
    const m=slug.match(/-(\d{10})$/);
    if (!m) continue;
    const start=Number(m[1]);
    if (nowSec < start + 420) continue; // wait at least 2m after the 5m window
    try {
      const {market}=await fetchMarketBySlug(slug);
      const prices=resolutionPrices(market);
      if (!prices) continue;
      settleStrategy(state.strategies.maker_inventory,slug,prices);
      settleStrategy(state.strategies.taker_pair,slug,prices);
      state.settled[slug]={ts:nowIso(),prices};
    } catch {}
  }
}

function recordCurve(strategy) {
  strategy.equityCurve ||= [];
  strategy.equityCurve.push({ts:nowIso(),realizedPnl:strategy.realizedPnl});
  if (strategy.equityCurve.length > 5000) strategy.equityCurve = strategy.equityCurve.slice(-5000);
}

function calcDrawdownPct(curve) {
  let peak=PAPER_CAPITAL, maxDd=0;
  for (const x of curve||[]) {
    const eq=PAPER_CAPITAL + Number(x.realizedPnl||0);
    if (eq>peak) peak=eq;
    if (peak>0) maxDd=Math.max(maxDd,(peak-eq)/peak*100);
  }
  return maxDd;
}
function profitFactor(s) {
  return s.grossLoss > 0 ? s.grossProfit/s.grossLoss : (s.grossProfit>0 ? 999 : 0);
}

function writeReport(state) {
  const elapsed=(Date.now()-Date.parse(state.startedAt))/3600000;
  const markets=Object.keys(state.marketsSeen).length;
  const maker=state.strategies.maker_inventory;
  const pair=state.strategies.taker_pair;
  const pf=profitFactor(maker);
  const dd=calcDrawdownPct(maker.equityCurve);
  let gate="RUNNING";
  if (elapsed>=48 && markets>=200) {
    gate = maker.realizedPnl>0 && pf>1.15 && dd<10 ? "PASS_CANDIDATE" : "FAIL";
  }
  const report={
    updatedAt:nowIso(), startedAt:state.startedAt,
    elapsedHours:Number(elapsed.toFixed(2)), samples:state.samples, marketsSeen:markets,
    gate,
    gateRules:{minHours:48,minMarkets:200,minProfitFactor:1.15,maxDrawdownPct:10,positiveNetPnl:true},
    makerInventory:{
      realizedPnl:Number(maker.realizedPnl.toFixed(4)),
      profitFactor:Number(pf.toFixed(3)),
      maxDrawdownPct:Number(dd.toFixed(3)),
      fills:maker.fills
    },
    takerPair:{
      realizedPnl:Number(pair.realizedPnl.toFixed(4)),
      profitFactor:Number(profitFactor(pair).toFixed(3)),
      fills:pair.fills,
      marketsEntered:Object.keys(pair.entered||{}).length
    },
    note:"Paper only. No wallet keys, signing, deposits, or real orders are used."
  };
  fs.writeFileSync(REPORT_PATH,JSON.stringify(report,null,2)+"\n");
  return report;
}

async function sampleAsset(state, asset) {
  const slug=marketSlug(asset);
  const {market,upToken,downToken}=await fetchMarketBySlug(slug);
  const [upBook,downBook]=await Promise.all([fetchBook(upToken),fetchBook(downToken)]);
  const snap={
    ts:nowIso(), asset:asset.key, slug,
    secondsIntoMarket:Math.floor(Date.now()/1000)-Number(slug.match(/-(\d{10})$/)?.[1]||0),
    up:{bid:bestBid(upBook),ask:bestAsk(upBook),tick:tick(upBook),last:Number(upBook.last_trade_price||upBook.lastTradePrice||NaN)},
    down:{bid:bestBid(downBook),ask:bestAsk(downBook),tick:tick(downBook),last:Number(downBook.last_trade_price||downBook.lastTradePrice||NaN)}
  };
  snap.combinedAsk = snap.up.ask + snap.down.ask;
  snap.combinedBid = snap.up.bid + snap.down.bid;
  state.marketsSeen[slug] ||= {asset:asset.key,firstSeen:snap.ts,lastSeen:snap.ts};
  state.marketsSeen[slug].lastSeen=snap.ts;
  applyMakerFills(state,slug,snap);
  makeMakerQuotes(state,slug,snap);
  maybeEnterTakerPair(state,slug,snap);
  fs.appendFileSync(SNAP_PATH,JSON.stringify(snap)+"\n");
  state.samples++;
}

async function main() {
  const state=loadState();
  const deadline=Date.now()+RUN_SECONDS*1000;
  await settleOldMarkets(state);
  while (Date.now()<deadline) {
    const started=Date.now();
    const results=await Promise.allSettled(ASSETS.map(a=>sampleAsset(state,a)));
    for (let i=0;i<results.length;i++) {
      if (results[i].status==="rejected") {
        fs.appendFileSync(SNAP_PATH,JSON.stringify({ts:nowIso(),asset:ASSETS[i].key,error:String(results[i].reason?.message||results[i].reason)})+"\n");
      }
    }
    saveState(state);
    writeReport(state);
    const wait=Math.max(1000,SAMPLE_SECONDS*1000-(Date.now()-started));
    await sleep(wait);
  }
  await settleOldMarkets(state);
  recordCurve(state.strategies.maker_inventory);
  recordCurve(state.strategies.taker_pair);
  saveState(state);
  const report=writeReport(state);
  console.log(JSON.stringify(report,null,2));
}

main().catch(err=>{ console.error(err); process.exitCode=1; });
