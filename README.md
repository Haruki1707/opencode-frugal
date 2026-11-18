# opencode-frugal

[OpenCode](https://opencode.ai) plugin for OpenRouter model discovery: filter to programming models,
sort and compare their prices, and — when you want it — route every request through the `#floor`
variant to the cheapest provider.

## Features

### 1. Programming-only filtering

Model discovery defaults to OpenRouter's **programming** category, so the list only contains models
built for coding and development work — no chat toys, no image generators. This applies in two places:

- The **`/models` picker** only lists OpenRouter models that belong to the programming category.
- The `frugal_prices` tool defaults to the programming category; set `category: "all"` to see every
  model, or pass any other [OpenRouter category](https://openrouter.ai/models).

Models that don't appear in OpenRouter's catalog at all are left untouched, so custom or provider-side
entries never disappear.

### 2. Prices, sorting, and coding benchmarks

Model names in the **`/models` picker get their price appended**, e.g.
`GLM 5.3 Flash · $0.150/$0.500` (input/output per million tokens), so cost is visible before you
select. The `frugal_prices` tool adds on top of that:

- **Sort by** `price` (cheapest blended cost first), `coding`, `context`, or `name`
- **Coding column** — the Artificial Analysis coding index (0–100), or a Design Arena code ELO when
  the index is not published, so cheap models can be compared by actual coding ability
- **Context window** and tool-call support at a glance
- Free-text **search** across model ids, names, and descriptions

### 3. `#floor` variant — always route to the cheapest provider

The plugin registers a `floor` variant on **every OpenRouter model**. Selecting
`openrouter/<model>#floor` merges `provider: { sort: "price" }` into each request, which bypasses
OpenRouter's default balanced routing and tries providers in price order (cheapest first). Same model,
same quality, lowest provider price — an easy way to save credits.

Powered by the public [OpenRouter models API](https://openrouter.ai/api/v1/models) — no OpenRouter
API key required for price lookups.

## Install

From GitHub:

```sh
opencode plugin add github:Haruki1707/opencode-frugal
```

Or add it to `opencode.json(c)` directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:Haruki1707/opencode-frugal"]
}
```

## Usage

### Prices

Ask your agent things like:

- "Show me the cheapest models for coding"
- "Compare prices for deepseek models"
- "Which OpenRouter models are good for programming and under $1/M tokens?"

The agent calls `frugal_prices` with the filters:

| Parameter  | Type                                       | Default         | Description                                                   |
| ---------- | ------------------------------------------ | --------------- | ------------------------------------------------------------- |
| `search`   | string                                     | —               | Case-insensitive substring match on id, name, and description |
| `category` | string                                     | `"programming"` | OpenRouter category filter; use `"all"` for every model       |
| `sort`     | `price` \| `coding` \| `context` \| `name` | `"price"`       | Sort order                                                    |
| `limit`    | number                                     | `15`            | Max rows (1–50)                                               |

### Floor routing

After installing, every OpenRouter model gains a `floor` variant. Select it like any other variant:

```sh
opencode run --model "openrouter/z-ai/glm-5.3-flash#floor" "Fix this bug"
```

or pick `… #floor` in the `/models` selector.

> **Note** — OpenRouter's native `:floor` slug is a superset of the price sort: it also makes
> [flex service tier](https://openrouter.ai/docs/guides/features/service-tiers) endpoints eligible. The
> plugin's variant implements the safe subset (price sort). If you want flex-tier eligibility, disable the
> plugin's variant injection (see below) and ask your provider config to use the raw slug form.

### Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-frugal",
      "options": {
        "floor": false,
        "filter": false,
        "prices": false
      }
    }
  ]
}
```

| Option   | Default | Description                                                                                     |
| -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `floor`  | `true`  | Register the `#floor` variant on every OpenRouter model.                                        |
| `filter` | `true`  | Only show OpenRouter programming models in the `/models` picker.                                |
| `prices` | `true`  | Append input/output prices to OpenRouter model names in the `/models` picker.                   |

## Development

```sh
npm install
npx tsc --noEmit
```

For local testing, you can also symlink or clone this directory into
`~/.config/opencode/plugins/opencode-frugal` — plugins there load automatically.

## License

[MIT](./LICENSE)
