# DSH Usage Statistics Panel

English | [中文](README.md)

![npm version](https://img.shields.io/npm/v/dsh-usage-statistics-panel)
![npm downloads](https://img.shields.io/npm/dm/dsh-usage-statistics-panel)
![License](https://img.shields.io/github/license/HaoyueQin/dsh-usage-statistics-panel)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)
![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4D6BFE)

A usage statistics panel plugin for the DSH web UI: per-day token trend, a GitHub-style activity heatmap, a cache hit-rate curve, and a per-model breakdown (donut + list), added as a "Usage statistics" page in Settings.

All charts are hand-drawn SVG with no chart library; the palette uses GitHub Primer's data-viz two-set tokens (the top five models each get a distinct rank colour, everything else collapses into a gray "Other" bucket) and adapts to the DSH theme.

## Preview

![Panel overview: summary cards, activity heatmap and daily token trend](docs/images/panel-overview.png)

![Model usage: donut, list and daily trend](docs/images/model-usage.png)

## Features

- **Time ranges**: last 7 / 14 / 30 / 90 days, or a custom from/to pair
- **Summary cards**: token usage, sessions (completed turns), requests, active days, average cache hit-rate, top model
- **26-week activity heatmap**: GitHub-style day cells, hover for the day's detail
- **Daily token trend**: stacked bars with a smooth cache hit-rate curve (Catmull-Rom), hover for the per-model breakdown
- **Model usage**: donut + list; the top five models keep distinct colours, the tail collapses into an expandable "Other" row
- **History backfill**: on first enable, the plugin enumerates and replays existing session logs (currently-live sessions are skipped, so their pre-boot history is not counted) so historical usage is accounted from day one
- **Local persistence**: data lands in `$DSH_HOME/storages/usage_history.json` (storage-domain), fully local, no external services

## Install

```sh
dsh plugin --profile <name> add dsh-usage-statistics-panel@latest
```

After mounting, **hard-refresh the browser** (Cmd/Ctrl+Shift+R): client-half changes hot-reload in DSH, no restart needed; only host-half updates (collector/storage/routes) require restarting DSH.

Once mounted, a "Usage statistics" page appears in the left navigation of the Settings shell.

## Data source

The collector is observational: it subscribes to the session event stream (`session/event`), reads provider-reported `TokenUsage` from `assistant/message` and `assistant/chunk` (input / output / cache-read / cache-write), dedupes by `(turn, step)` WITHIN one session (each call counts once, keeping the first report — the shipped adapters report identical values on the streaming sample and the final message; concurrent sessions never swallow each other's samples), and attributes to the provider/model from `request/context`. On first enable it also backfills by replaying persisted session logs.

> Note: usage accumulates from the day the panel is enabled (including the backfill). Sessions whose logs predate the feature carry no provider-reported usage and cannot be reconstructed.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsc declarations + tsdown (host ESM + dual-channel client bundles)
```

## Design & implementation

- **Host half** (`src/`): `collector` (event subscription + backfill fold), `store` (the `usage_history` storage domain), `query` (range aggregation, a TS translation of the reasonix query.go), `routes` (the fenced `/usage/api` JSON routes, same trust fence as the `/api` gateway)
- **Client half** (`src/client/`): `UsageStatsPanel.tsx` (hand-drawn SVG charts ported from the reasonix panel + Primer palette), `locales` (en / zh / zh-TW), `api` (the `/usage/api` fetch wrapper)
- **Dual-channel bundles**: `lib/client.js` (official profile channel, bundle id = package name) and `lib/client-registry.js` (plugin-registry channel, bundle id = manifest id)
- Full design notes: [docs/design.md](docs/design.md)

## Acknowledgements

This panel is a port of the usage statistics feature the author originally built for [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) (PR [#7238](https://github.com/esengine/DeepSeek-Reasonix/pull/7238) and [#7503](https://github.com/esengine/DeepSeek-Reasonix/pull/7503)). The front-end charts are largely reused from that implementation; the data layer is rebuilt on DSH's session logs and storage-domain.

## License

MIT
