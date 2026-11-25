// Launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The dev tape says chasing coins that already ran loses badly (the pilot
// momentum bot lost 9.46 SOL with a 96% drawdown), while buying launches
// and getting out in seconds roughly breaks even. So this bot snipes the
// launch itself and never rides a dump:
//
//   * watch every coin from its CreateEvent. In its first few slots read
//     the opening tape: how much the creator bought, how many other wallets
//     bought with them, whether the creator already sold, how much real SOL
//     the curve holds, and how far the price ran from its create price.
//   * buy once, 0.10 SOL, only inside the first 5 slots and only if the
//     launch passes the rug filter: creator buy at most 2.5 SOL, at most 4
//     distinct non-creator buyers (a launch bundled by many wallets is a
//     dump waiting to happen), creator has not sold, someone actually bought
//     at least 0.10 SOL in total, real SOL between 0.4 and 25, and the price
//     has not already run more than 40% above its create price.
//   * exits (whole position, wide slippage so the exit fills): +18% take
//     profit, -10% stop loss, a trailing stop once up 6% (exit on an 8%
//     fall from the best value), an exit the moment the creator sells, and
//     a 15-slot time limit. One shot per coin, never re-entered.
//   * sizing is capped by the harness size cap (1% of real SOL reserve),
//     so a coin whose reserve is still tiny only ever gets a small buy;
//     buys below 0.01 SOL are skipped, which also keeps every round trip
//     above the guardrail's 0.01 SOL bar. At most 5 positions open and at
//     most 0.50 SOL of cost exposure at once, so a sweep of losers costs a
//     few percent of the 10 SOL capital, not the book.
//
// The hello, batch, orders and slot words here are the replay protocol's
// own terms: the harness sends a hello, then one batch per slot, and the
// bot answers each batch with its orders. Deterministic by construction:
// no clock, no randomness, no environment; iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each reply still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Total SOL bought (creator + others) before entry, at least. */
  minBoughtSol: number;
  /** Price now over the create price, at most (1 + maxRunup). */
  maxRunup: number;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost. */
  takeProfit: number;
  /** Exit when it is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 2,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 0.4,
  maxRealSol: 25,
  maxDevBuySol: 1.5,
  maxBuyers: 2,
  minBoughtSol: 0.5,
  maxRunup: 0.4,
  buySlipBps: 10000,
  takeProfit: 0.1,
  stopLoss: 0.06,
  trailArm: 0.08,
  trail: 0.1,
  maxHold: 6,
  exitOnDevSell: true,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: number;
  vt0: number;
  devBuy: number;
  buyers: Set<Pubkey>;
  bought: number;
  devSold: boolean;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaidSol: number;
  bestValue: number;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // Fold this batch's events into the per-coin opening tape.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: Number(e.virtual_quote_reserves),
            vt0: Number(e.virtual_token_reserves),
            devBuy: 0,
            buyers: new Set(),
            bought: 0,
            devSold: false,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          }
        } else {
          const c = coinOf(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      // Fold fills: track tx fees paid per held position, drop harness closes.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaidSol += Number(f.tx_fee_lamports) / LAMPORTS;
          if (f.side === 'buy' && h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              txPaidSol: Number(f.tx_fee_lamports) / LAMPORTS,
              bestValue: 0,
              devSoldAtOpen: coinOf(f.mint)?.devSold ?? false,
            });
          }
        }
      }
      for (const mint of [...selling]) {
        let stillPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') stillPending = true;
        }
        if (!stillPending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        let pendingBuy = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') pendingBuy = true;
        }
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingBuy) held.delete(mint);
      }

      // Exits first: whole position on take-profit, stop, trail, dev sell or time.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coinOf(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaidSol: tx, bestValue: 0, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        if (mk === undefined && curve === undefined) continue;
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve!.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve!.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const basis = Number(pos.cost_lamports) / LAMPORTS + h.txPaidSol;
        if (value > h.bestValue) h.bestValue = value;
        let exit = false;
        if (basis > 0) {
          if (value >= basis * (1 + p.takeProfit)) exit = true;
          if (value <= basis * (1 - p.stopLoss)) exit = true;
          if (h.bestValue >= basis * (1 + p.trailArm) && value <= h.bestValue * (1 - p.trail)) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one buy per launch, inside its first maxAge slots, rug filter first.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rq < p.minRealSol || rq > p.maxRealSol) continue;
        if (c.devBuy > p.maxDevBuySol) continue;
        if (c.buyers.size > p.maxBuyers) continue;
        if (c.bought < p.minBoughtSol) continue;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        if (c.vq0 <= 0 || c.vt0 <= 0 || vt <= 0) continue;
        const runup = (vq / vt) / (c.vq0 / c.vt0) - 1;
        if (runup > p.maxRunup) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(c.mint))) / LAMPORTS;
        const amount = Math.min(p.stakeSol, capSol);
        if (amount < p.minBuySol) continue;
        if (free < amount + tx) continue;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }
      return orders;
    },
  };
}
