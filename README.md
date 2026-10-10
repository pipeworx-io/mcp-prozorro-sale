# @pipeworx/prozorro-sale

Prozorro.Sale, Ukraine's public auction system for state and municipal asset sales and leases: land-lease and land-sale auctions, municipal and state property leases, small privatisation, bankruptcy estates, timber, railway cargo and subsoil rights, with bids, awards, contracts and the repeat-auction chain.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1764+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `prozorro_sale_search(direction?, status?, region?, locality?, query?, selling_method?, category?, min_value?, max_value?, modified_since?, limit?, page?)` — find auctions, e.g. land-lease auctions open for bids in Kyiv oblast. Newest-modified first, with status, start price, region, seller and bid count.
- `prozorro_sale_procedure(id, include_chain?)` — one auction by public id (`LRE001-UA-20260813-89379`) or internal id: items with cadastral numbers and areas, bids with amounts, awards, signed contracts, cancellations, related registry assets, and the earlier/later repeats of the same lot.
- `prozorro_sale_asset(id)` — a registry asset (`RAS001-UA-…`) with its holder, status and the auctions it was offered in.
- `prozorro_sale_changes(since, limit?)` — the upstream modified-date feed, oldest first, with `next_since` to continue.

Every response carries `data_as_of`. An unknown id returns `found: false`; an upstream failure throws with the upstream status.

## Auth

Keyless.

## Data sources

- <https://procedure.prozorro.sale/api> — the public Prozorro.Sale CBD API.

Notes for the next person:

- `POST /api/search/procedures` accepts only `{limit, page, sort, filters}`; each filter is `{field, operator, value}`. A wrong field returns a 422 that lists every allowed field — read it rather than guessing.
- `metaInfo.directions` is not the sellingMethod prefix: small privatisation is `sellOut`, basicSell is `otherAssets`. Filtering on the prefix returns zero rows, not an error.
- Region filters need the Ukrainian oblast name exactly as published (`Київська область`); the pack translates common English names.
- `GET /api/search/procedures` (no body) answers 204, which looks like an empty result; it is the wrong method.
- `_protected` / `_protect_level` are passed through verbatim. Upstream masks bidder addresses and contacts; the pack also drops contact-person names and individual tax numbers (UA-IPN).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "prozorro-sale": {
      "url": "https://gateway.pipeworx.io/prozorro-sale/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/prozorro-sale/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1764+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/prozorro_sale_search \
  -H 'Content-Type: application/json' \
  -d '{"direction":"landRental","region":"Київська область","status":"active_tendering","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/prozorro_sale_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "prozorro-sale": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-prozorro-sale"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-prozorro-sale
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Prozorro Sale data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
