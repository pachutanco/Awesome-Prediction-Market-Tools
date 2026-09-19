# norm1e69 paper experiment

This is a **paper-only** Polymarket experiment inspired by the observed behavior of `norm1e69`.

It samples the live BTC/ETH/SOL 5-minute Up/Down CLOB, records executable best bid/ask prices, and runs two synthetic strategies:

- `maker_inventory`: posts simulated maker quotes one tick inside the spread and maintains dynamic UP/DOWN inventory.
- `taker_pair`: only takes both legs when the *executable* combined cost remains below the guaranteed payout after the Polymarket crypto taker-fee formula.

No private key, wallet, signing, deposit, or real order endpoint is used.

## Fixed gate

The experiment remains paper-only until at least **48 hours** and **200 distinct markets** are observed. The maker strategy must then have:

- net realized PnL > 0
- profit factor > 1.15
- max realized-equity drawdown < 10%

Passing produces `PASS_CANDIDATE`, not automatic live trading. A tiny live test would still require a separate explicit decision.

The current machine-readable result is in `report.json`; raw samples are appended to `snapshots.jsonl`.
