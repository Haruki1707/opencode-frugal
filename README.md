# opencode-frugal

[OpenCode](https://opencode.ai) plugin for spending fewer credits on OpenRouter models:

- **`frugal_prices` tool** — look up current OpenRouter model prices (USD per million tokens), with a
  programming/development category filter, coding-benchmark scores, and sorting by price, coding ability,
  context, or name.
- **`#floor` variant** — registers a `floor` variant on every OpenRouter model so you can select
  `openrouter/<model>#floor` and make OpenRouter always route each request to the **cheapest provider**
  for that model, instead of balancing price against speed and reliability.

Powered by the public [OpenRouter models API](https://openrouter.ai/api/v1/models) — no OpenRouter API key
required for price lookups.

## Install

From GitHub:

```sh
opencode plugin add github:YOUR_USERNAME/opencode-frugal
```

Or add it to `opencode.json(c)` directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:YOUR_USERNAME/opencode-frugal"]
}
```

Pin a branch, tag, or commit if you want a fixed version:

```sh
opencode plugin add "github:YOUR_USERNAME/opencode-frugal#v0.1.0"
```

## Usage

### Prices

Ask your agent things like:

- "Show me the cheapest models for coding"
- "Compare prices for deepseek models"
- "Which OpenRouter models are good for programming and under $1/M tokens?"

The agent calls `frugal_prices` with the filters:

| Parameter  | Type                                    | Default         | Description                                                        |
| ---------- | --------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `search`   | string                                  | —               | Case-insensitive substring match on id, name, and description      |
| `category` | string                                  | `"programming"` | OpenRouter category filter; use `"all"` for every model            |
| `sort`     | `price` \| `coding` \| `context` \| `name` | `"price"`    | Sort order                                                         |
| `limit`    | number                                  | `15`            | Max rows (1–50)                                                    |

The **Coding** column is the Artificial Analysis coding index (0–100), or a Design Arena code ELO when the
index is not published for a model.

### Floor routing

After installing, every OpenRouter model gains a `floor` variant. Select it like any other variant:

```sh
opencode run --model "openrouter/z-ai/glm-5.3-flash#floor" "Fix this bug"
```

or pick `… #floor` in the `/models` selector. Requests then include
`provider: { sort: "price" }`, which bypasses OpenRouter's default balanced routing and tries providers in
price order (cheapest first).

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
        "floor": false
      }
    }
  ]
}
```

| Option  | Default | Description                                              |
| ------- | ------- | -------------------------------------------------------- |
| `floor` | `true`  | Register the `#floor` variant on every OpenRouter model. |

## Development

```sh
npm install
npx tsc --noEmit
```

For local testing, you can also symlink or clone this directory into
`~/.config/opencode/plugins/opencode-frugal` — plugins there load automatically.

## License

[MIT](./LICENSE)
