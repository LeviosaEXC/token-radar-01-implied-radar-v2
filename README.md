# Implied Radar — token-radar-01 (v2)

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/)
[![rank](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar-v2/rank.svg)](https://make.fun/)
[![reward](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar-v2/reward.svg)](https://make.fun/)

A pre-token valuation radar for the [make.fun](https://make.fun/) token-radar-01 bounty.
It reads the sealed DefiLlama snapshot, ranks every eligible protocol that
records no token by conditional implied value — what its token would be worth
if one were issued — and gives each row a 6-step farm plan with net capital
economics and break-even hurdles.

## How it works

- **Value model (v2):** frozen nested leave-one-out selection over functional
  form (global power law / offset / elasticity ladder), feature subsets
  (growth, tracking tenure, chain breadth), anonymous-ID group pooling, and a
  cap ablation — each stage decided inside training folds, with a paired
  bootstrap gate and a frozen 70/30 chronological audit. The snapshot
  established no feature or group edge under that protocol, so v2 ships the
  bare global power law and says so plainly.
- **Uncertainty:** stratified split-conformal value bands (P10/P25/P75/P90)
  with measured coverage, plus rank-percentile conformal rank intervals.
- **Farm economics:** deposit / drop-share / gas scenarios are disclosed
  assumptions; verdicts are Farm / Marginal / Research only / Skip, with a
  Research-only gate whenever the snapshot basis is missing.
- **Proof:** the dashboard re-derives every value, rank, band, interval and
  verdict from the raw embedded fields and verifies them against the board
  digests on every load (see the VERIFIED badge in the header).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

Node 22, standard library only, zero runtime network. The program writes
`board.json`, the dashboard data, the dashboard, the screenshots, and
`dossier.json` into the output directory.

## Layout

- `main.ts` — the entry program: census, nested model selection, scoring, economics, outputs.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`); `data.js` is written by the program.
- `screenshots/` — the three dashboard captures (1440×900).
- `vendor/makefun-board.ts` — the kit's dossier library, byte-identical to the kit copy.
