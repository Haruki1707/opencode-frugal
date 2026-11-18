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
// Programming-model sources
// Two independent sources for "programming models" on OpenRouter:
//   frontend: the tag-based list the website itself uses (broader, ~48, undocumented)
//   api:      the documented curated shortlist (~20, stable)
// Both are unioned so one failing never removes models the other still knows
// about; a total failure keeps the last good set (fail open).
// ---------------------------------------------------------------------------

const SOURCES = {
  frontend: "https://openrouter.ai/api/frontend/v1/models/find?active=true&categories=programming",
  api: "https://openrouter.ai/api/v1/models?category=programming",
} as const

type SourceName = keyof typeof SOURCES
type SourceStatus = { ok: boolean; count: number; at: string; error?: string }

const status: Record<SourceName, SourceStatus> = {
  frontend: { ok: false, count: 0, at: "", error: "not fetched yet" },
  api: { ok: false, count: 0, at: "", error: "not fetched yet" },
}

function extract(name: SourceName, body: unknown): Set<string> {
  const ids = new Set<string>()
  const data = (body as { data?: Record<string, unknown> })?.data
  if (name === "frontend") {
    for (const model of (data as { models?: { slug?: unknown }[] } | undefined)?.models ?? []) {
      if (typeof model.slug === "string") ids.add(model.slug)
    }
  } else {
    for (const model of (data as { id?: unknown }[] | undefined) ?? []) {
      if (typeof model.id === "string") ids.add(model.id)
    }
  }
  return ids
}

async function loadSource(name: SourceName): Promise<Set<string>> {
  const at = new Date().toISOString()
  try {
    const response = await fetch(SOURCES[name], { headers: { accept: "application/json" } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const ids = extract(name, await response.json())
    if (ids.size === 0) throw new Error("empty model list")
    status[name] = { ok: true, count: ids.size, at }
    return ids
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status[name] = { ok: false, count: 0, at, error: message }
    console.error(`[opencode-frugal] source ${name} failed: ${message}`)
    return new Set()
  }
}

interface CostTier {
  input?: number
  output?: number
}

/** Compact price tag from OpenCode's own per-million USD cost tiers, e.g. "$0.15/$0.50". */
function priceTag(cost: readonly CostTier[] | undefined): string {
  const tier = cost?.[0]
  if (!tier) return ""
  const input = Number(tier.input ?? 0)
  const output = Number(tier.output ?? 0)
  if (input === 0 && output === 0) return "free"
  const fmt = (n: number) => String(n >= 100 ? Math.round(n) : Number(n.toFixed(3)))
  // "+" marks a model whose price rises above a context-length tier.
  return `$${fmt(input)}/$${fmt(output)}${(cost?.length ?? 0) > 1 ? "+" : ""}`
}

function report(keep: Set<string>, shown: number): string {
  const lines = ["**opencode-frugal — programming filter status**", ""]
  for (const name of Object.keys(status) as SourceName[]) {
    const s = status[name]
    const label = name === "api" ? "public api" : name
    lines.push(
      `- ${label}: ${s.ok ? "ok" : "FAILED"} — ${s.count} tagged${s.at ? `, ${new Date(s.at).toLocaleString()}` : ""}${s.error && !s.ok ? ` (${s.error})` : ""}`,
    )
  }
  lines.push("", `Union: ${keep.size} programming models`, `Shown in /models: ${shown}`)
  if (keep.size === 0) lines.push("", "Nothing fetched yet, so no filtering is applied.")
  return lines.join("\n")
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
    // Filtering unions both programming sources (see SOURCES above) so the
    // picker matches what the OpenRouter website shows. Prices come from
    // OpenCode's own cost data, so no extra fetch is needed for them.
    if (filterEnabled || pricesEnabled) {
      let keep = new Set<string>()

      const refresh = async () => {
        const loaded = await Promise.all((Object.keys(SOURCES) as SourceName[]).map(loadSource))
        const union = new Set<string>()
        for (const ids of loaded) for (const id of ids) union.add(id)

        // Fail open: keep the last good set rather than wiping the model list.
        if (union.size > 0) keep = union
        else if (keep.size > 0) {
          console.error("[opencode-frugal] both sources failed, keeping last good list")
        }

        await ctx.model.reload()
      }

      await refresh()

      await ctx.model.transform((editor) => {
        for (const model of editor.list("openrouter")) {
          editor.update(model.providerID, model.id, (draft) => {
            // Disable instead of remove: recoverable and survives refreshes.
            if (filterEnabled && keep.size > 0) draft.enabled = keep.has(model.id)
            if (!pricesEnabled) return
            // Rebuild the name from the catalog's own name so replays never stack tags.
            const base = draft.name.replace(/\s+·\s+(free|\$[^\s]+)$/, "")
            const tag = priceTag(draft.cost)
            draft.name = tag ? `${base} · ${tag}` : base
          })
        }
      })

      await ctx.command.transform((editor) => {
        editor.add({
          name: "frugal-status",
          description: "Re-check the OpenRouter programming-model sources and show their status",
          execute: async ({ sessionID }) => {
            await refresh()
            const models = (await ctx.model.list()) as unknown as {
              data?: { providerID?: string; enabled?: boolean }[]
            }
            const list = Array.isArray(models) ? models : (models?.data ?? [])
            const shown = list.filter(
              (model) => model.providerID === "openrouter" && model.enabled !== false,
            ).length
            await ctx.session.synthetic({ sessionID, text: report(keep, shown) })
          },
        })
      })

      const timer = setInterval(() => void refresh().catch(console.error), 6 * 60 * 60 * 1000)
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
