# Pump.fun Bot Sprint — Launch Sniper

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Efendiiii/pump-fun-bot-sprint-20261125/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Efendiiii/pump-fun-bot-sprint-20261125/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Competition bounty: https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

A Solana trading bot for the make.fun `pump-fun-bot-sprint` competition
(`agent-fun/replay/v2`). It trades paper SOL on a replay of pump.fun
bonding-curve chain data, ranked on net PnL.

## Strategy

Buy the launch, get out in seconds — never ride a dump:

- **Snipe:** every coin is watched from its `CreateEvent`. Inside its first
  2 slots the bot reads the opening tape (creator's own buy, distinct
  non-creator buyers, whether the creator sold, real SOL in the curve, price
  run-up vs the create price) and buys once, 0.10 SOL, only if the launch
  passes the rug filter: creator buy ≤ 1.5 SOL, ≤ 2 distinct non-creator
  buyers, creator has not sold, ≥ 0.50 SOL bought in total, real SOL
  0.4–25, run-up ≤ 40%.
- **Exits (whole position):** +10% take-profit, −6% stop-loss, a trailing
  stop once up 8% (exit on a 10% fall from the best value), exit the moment
  the creator sells, and a 6-slot time limit. One shot per coin.
- **Risk:** at most 5 positions open, 0.50 SOL max cost exposure on 10 SOL
  capital. Every buy is capped at 1% of the coin's real SOL reserve and
  buys under 0.01 SOL are skipped, so every round trip clears the
  competition's 0.01 SOL / 20-coin guardrail bar.

## Dev-window results (grade-local, --driver process)

Final settings: **−0.0996 SOL** (−1.0%), 290 fills over 145 coins,
win rate 9.7%, max drawdown 1.35%, 0 rejected orders,
guardrails met (145 coins ≥ 0.01 SOL round trips). Fees 0.075 SOL curve +
0.031 SOL tx. Top 3 coins made 62% of the gains; without them −0.15 SOL —
the score leans on a few runners, as every sniper does on this tape.
Stress (10 rebuilt copies of the dev window): median −0.11 SOL, p10
−0.20, p90 −0.07; 10 of 10 copies lost money; the dev score sits above
7 of 10. Honest read: slightly negative expected value on dev and on
surrogates; the final window is a fresh 6 h tape, and the prize needs
net PnL above 0, so this entry is a small, diversified sniper ticket
with a 1.35% max drawdown, not a tuned-to-dev winner.

Tuning sweep on the dev window (each step re-graded):

| variant | net PnL (SOL) | coins |
|---|---|---|
| momentum (age ≥120 slots, hold 900, stake 0.30) | −0.337 | 273 |
| TP 30% / SL 8% / hold 30 | −0.330 | 273 |
| stricter entry (age ≤3, ≥0.20 bought, ≤3 buyers), TP 15% / SL 8% / hold 10 | −0.223 | 238 |
| age ≤3, ≥0.30 bought, ≤2 buyers, TP 12% / SL 7% / hold 8 | −0.136 | 190 |
| **final: age ≤2, ≥0.50 bought, dev buy ≤1.5, TP 10% / SL 6% / hold 6** | **−0.100** | **145** |
| stricter still (≥0.80 bought, dev buy ≤1.0, TP 8% / SL 5% / hold 5) | −0.074 | 120 |

The strictest variant scored best on dev but was rejected: 120 coins on
the 24 h dev window implies ~30 on the 6 h final window, too close to the
20-coin guardrail, and its top-3 concentration (69%) was worse. The final
settings keep ~36 expected final-window coins. Every pilot baseline lost
money on dev too (momentum −9.46, reversion −3.89, sniper −0.47 SOL), so
the final window is a fresh 6 h tape and this entry is a small, diversified
sniper, not a tuned-to-dev winner.

## Layout

On the dev window the pilot momentum bot (buy after a run, hold up to 1500
slots, 2 SOL stakes) lost 9.46 SOL with a 96% drawdown, and the reversion
pilot lost 3.89 SOL. The pilot sniper (buy at launch, exit in 10 slots)
roughly broke even at −0.47 SOL over 351 coins with a 5.2% drawdown. This
bot keeps the sniper regime — launch-only entries, seconds-long holds,
small stakes, fast exits — with its own filters and a trailing stop.

## Layout

- `main.ts` — entrypoint: `node /bot/main.ts`
- `strategy.ts` — the strategy (no dependencies, deterministic: no clock,
  no randomness, no environment)
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored
  byte for byte
- `LICENSE` — MIT

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```
