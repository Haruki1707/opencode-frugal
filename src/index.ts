import { Model, Plugin } from "@opencode/plugin"

// ---------------------------------------------------------------------------
// OpenRouter models API
// https://openrouter.ai/docs/api/reference/list-available-models
// Public endpoint, no API key required.
// ---------------------------------------------------------------------------

const MODELS_URL = "https://openrouter.ai/api/v1/models"
const CACHE_TTL_MS = 30 * 60 * 1000

interface OpenRouterPricing {
  prompt?: string
  completion?: string
  input_cache_read?: string
}

interface DesignArenaEntry {
  arena?: string
  category?: string
  elo?: number
  win_rate?: number
  rank?: number
}

interface OpenRouterModel {
  id: string
  name?: string
  description?: string
  context_length?: number
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  pricing?: OpenRouterPricing
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
  }
  supported_parameters?: string[]
  benchmarks?: {
    design_arena?: DesignArenaEntry[]
    artificial_analysis?: {
      coding_index?: number | null
      intelligence_index?: number | null
    }
  }
}

const cache = new Map<string, { at: number; models: OpenRouterModel[] }>()
const inflight = new Map<string, Promise<OpenRouterModel[]>>()

async function fetchModels(category: string, signal?: AbortSignal): Promise<OpenRouterModel[]> {
  const cached = cache.get(category)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models

  const running = inflight.get(category)
  if (running) return running

  const task = (async () => {
    const url =
      category === "all" ? MODELS_URL : `${MODELS_URL}?category=${encodeURIComponent(category)}`
    const res = await fetch(url, { signal, headers: { accept: "application/json" } })
    if (!res.ok) throw new Error(`OpenRouter API returned HTTP ${res.status}`)
    const data = (await res.json()) as { data?: OpenRouterModel[] }
    const models = Array.isArray(data.data) ? data.data : []
    cache.set(category, { at: Date.now(), models })
    return models
  })()

  inflight.set(category, task)
  try {
    return await task
  } finally {
    inflight.delete(category)
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Convert OpenRouter's USD-per-token price string to USD per million tokens. */
function perMillion(perToken?: string): number | undefined {
  if (!perToken) return undefined
  const n = Number(perToken)
  if (!Number.isFinite(n)) return undefined
  return n * 1_000_000
}

function fmtUSD(n: number | undefined): string {
  if (n === undefined) return "?"
  if (n === 0) return "free"
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function fmtContext(n?: number): string {
  if (!n || n <= 0) return "?"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Artificial Analysis coding index (0-100), when available. */
function codingIndex(m: OpenRouterModel): number | null {
  const idx = m.benchmarks?.artificial_analysis?.coding_index
  return typeof idx === "number" ? idx : null
}

/** Design Arena "codecategories" ELO, when available. */
function codingElo(m: OpenRouterModel): number | null {
  const entry = m.benchmarks?.design_arena?.find((b) => b.category === "codecategories")
  return typeof entry?.elo === "number" ? entry.elo : null
}

function fmtCoding(m: OpenRouterModel): string {
  const idx = codingIndex(m)
  if (idx !== null) return idx.toFixed(0)
  const elo = codingElo(m)
  if (elo !== null) return `${Math.round(elo)} elo`
  return ""
}

function clean(text: string): string {
  return text.replaceAll("|", "/").replaceAll("\n", " ")
}

interface Row {
  model: OpenRouterModel
  inPerM: number | undefined
  outPerM: number | undefined
}

function blendedCost(row: Row): number {
  if (row.inPerM === undefined && row.outPerM === undefined) return Number.POSITIVE_INFINITY
  return ((row.inPerM ?? 0) + (row.outPerM ?? 0)) / 2
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "frugal",
  async setup(ctx) {
    const floorEnabled = ctx.options.floor !== false
    const filterEnabled = ctx.options.filter !== false
    const pricesEnabled = ctx.options.prices !== false
    let cleanup: (() => void) | undefined

    // --- #floor variant on every OpenRouter model --------------------------
    // Selecting `openrouter/<model>#floor` merges
    // `body: { provider: { sort: "price" } }` into every request, which makes
    // OpenRouter always route to the cheapest provider instead of balancing
    // price against throughput, latency, and reliability.
    if (floorEnabled) {
      await ctx.provider.transform((editor) => {
        const record = editor.get("openrouter")
        if (!record) return
        let touched = 0
        for (const modelID of record.models.keys()) {
          editor.models.update("openrouter", modelID, (model) => {
            const variants = (model.variants ??= [])
            if (Array.isArray(variants) && !variants.some((v) => v && v.id === "floor")) {
              variants.push({
                id: Model.VariantID.make("floor"),
                body: { provider: { sort: "price" } },
              })
              touched += 1
            }
          })
        }
        if (touched > 0) {
          console.log(`[opencode-frugal] registered #floor variant on ${touched} openrouter model(s)`)
        }
      })
    }

    // --- model picker: programming filter + prices in names -----------------
    // The OpenRouter model list itself is filtered to the programming category
    // and each model's display name gets its input/output price appended, e.g.
    // "GLM 5.3 Flash · $0.15/$0.50". Models missing from OpenRouter's catalog
    // are left untouched.
    if (filterEnabled || pricesEnabled) {
      const catalog: {
        programming: Set<string>
        known: Set<string>
        prices: Map<string, { in: number | undefined; out: number | undefined }>
      } = { programming: new Set(), known: new Set(), prices: new Map() }

      const refresh = async () => {
        const [all, programming] = await Promise.all([fetchModels("all"), fetchModels("programming")])
        catalog.programming = new Set(programming.map((m) => m.id))
        catalog.known = new Set(all.map((m) => m.id))
        catalog.prices = new Map(
          all.map((m) => [
            m.id,
            { in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion) },
          ]),
        )
      }

      await refresh().catch((err) => {
        console.error("[opencode-frugal] initial model catalog fetch failed:", err)
      })

      await ctx.model.transform((editor) => {
        // Never filter when the catalog failed to load: an empty programming
        // set would otherwise remove every OpenRouter model.
        for (const model of editor.list("openrouter")) {
          if (filterEnabled && catalog.known.has(model.id) && !catalog.programming.has(model.id)) {
            editor.remove(model.providerID, model.id)
            continue
          }
          if (pricesEnabled) {
            const price = catalog.prices.get(model.id)
            if (price && (price.in !== undefined || price.out !== undefined)) {
              const label = `${fmtUSD(price.in)}/${fmtUSD(price.out)}`
              editor.update(model.providerID, model.id, (m) => {
                m.name = `${m.name} · ${label}`
              })
            }
          }
        }
      })

      const timer = setInterval(() => {
        void refresh()
          .then(() => ctx.model.reload())
          .catch((err) => console.error("[opencode-frugal] model catalog refresh failed:", err))
      }, 60 * 60 * 1000)
      cleanup = () => clearInterval(timer)
    }

    // --- frugal_prices tool ------------------------------------------------
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "frugal",
        description: "Cost tools: OpenRouter model prices and cheapest-provider routing.",
      })

      editor.add({
        name: "prices",
        description:
          "Look up OpenRouter model prices (USD per million tokens). Defaults to the " +
          'programming category; set category to "all" for every model. Sort by price, ' +
          "coding benchmark, context, or name. Use this before recommending or switching " +
          "models when cost matters, and mention the `#floor` variant (routes to the " +
          "cheapest provider) as a way to save credits.",
        options: { namespace: "frugal", codemode: true },
        input: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Case-insensitive substring matched against model id, name, and description.",
            },
            category: {
              type: "string",
              description: 'OpenRouter category filter. Default "programming". Use "all" to list every model.',
            },
            sort: {
              type: "string",
              enum: ["price", "coding", "context", "name"],
              description: 'Sort order. Default "price" (cheapest blended cost first).',
            },
            limit: {
              type: "number",
              description: "Maximum number of models to list, 1-50. Default 15.",
            },
          },
          additionalProperties: false,
        },
        execute: async (rawInput, context) => {
          const input = (rawInput ?? {}) as {
            search?: string
            category?: string
            sort?: "price" | "coding" | "context" | "name"
            limit?: number
          }

          const category = input.category?.trim() || "programming"
          const sort = input.sort ?? "price"
          const limit = Math.min(Math.max(Math.trunc(input.limit ?? 15), 1), 50)
          const search = input.search?.trim().toLowerCase()

          let models: OpenRouterModel[]
          try {
            models = await fetchModels(category, context.signal)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return { content: `Failed to fetch OpenRouter models: ${message}` }
          }

          const rows: Row[] = models
            .filter((m) => {
              if (!m?.id) return false
              if (search && !`${m.id} ${m.name ?? ""} ${m.description ?? ""}`.toLowerCase().includes(search)) {
                return false
              }
              return true
            })
            .map((model) => ({
              model,
              inPerM: perMillion(model.pricing?.prompt),
              outPerM: perMillion(model.pricing?.completion),
            }))

          switch (sort) {
            case "coding":
              rows.sort(
                (a, b) =>
                  (codingIndex(b.model) ?? codingElo(b.model) ?? -1) -
                  (codingIndex(a.model) ?? codingElo(a.model) ?? -1),
              )
              break
            case "context":
              rows.sort((a, b) => (b.model.context_length ?? 0) - (a.model.context_length ?? 0))
              break
            case "name":
              rows.sort((a, b) => a.model.id.localeCompare(b.model.id))
              break
            case "price":
            default:
              rows.sort((a, b) => blendedCost(a) - blendedCost(b))
              break
          }

          const shown = rows.slice(0, limit)
          if (shown.length === 0) {
            return {
              content: `No OpenRouter models matched${search ? ` search "${input.search}"` : ""} in category "${category}".`,
            }
          }

          const lines = [
            `**OpenRouter models** — category: \`${category}\`, sorted by \`${sort}\`, ` +
              `${shown.length} of ${rows.length} match${rows.length === 1 ? "" : "es"}.`,
            "",
            "| Model | In $/M tok | Out $/M tok | Context | Tools | Coding |",
            "|---|---|---|---|---|---|",
          ]

          for (const row of shown) {
            const name = row.model.name ? ` — ${clean(row.model.name)}` : ""
            const tools = row.model.supported_parameters?.includes("tools") ? "yes" : ""
            lines.push(
              `| \`${row.model.id}\`${name} | ${fmtUSD(row.inPerM)} | ${fmtUSD(row.outPerM)} | ` +
                `${fmtContext(row.model.context_length)} | ${tools} | ${fmtCoding(row.model)} |`,
            )
          }

          lines.push(
            "",
            "Prices are OpenRouter list prices per million tokens; cache reads are usually cheaper. " +
              "Coding is the Artificial Analysis coding index (0-100) or a Design Arena code ELO when the index is unavailable. " +
              "Selecting the `#floor` variant (e.g. `openrouter/" +
              shown[0].model.id +
              "#floor`) makes OpenRouter route each request to the cheapest provider for that model.",
          )

          return { content: lines.join("\n") }
        },
      })
    })

    return cleanup
  },
})
