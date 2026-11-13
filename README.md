# Bitcoin Pulse Board
Static single-page BTC dashboard: multi-source prices, an up/down call every 15 minutes, play-money bets and a prediction log.
For fun only — not financial advice, play money only. No ads, no sign-in, no data collection; everything is stored in your browser's localStorage.
Chart.js (MIT) is vendored as `chart.umd.min.js`.

## Pulse Board 2
A separate, standalone copy of the board with the "callers v2" features (six callers incl. Flippy, confidence, short/phase memory, Grokky Archive, tallies, crowd layer, volatility gate; see `docs/callers-v2.md`). It was copied from `callers-v2` (f7b8c64) of the first board. Every browser-storage key uses the `pulseboard2.` prefix, so its scores, caller memory and archive are completely separate from the first board even though both live on the same github.io origin. Read-only Kalshi relay and the Ask AI Worker are shared with the first board.
