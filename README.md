# bizmachine-mcp

MCP server for [BizMachine](https://bizmachine.com/) — Czech and Slovak company data API. Look up revenue, employees, financials, contacts, risk signals, engagement scores, ownership, NACE classification and more for any Czech or Slovak company by name, domain, or ICO.

## Tools

### Search & core

| Tool | Description |
|------|-------------|
| `suggest` | Search companies by name or domain → ICO |
| `company` | Get full raw aggregated data by ICO |
| `lookup` | Smart lookup: name/domain → best match → structured data with revenue |
| `bulk_lookup` | Batch lookup for multiple companies |

### Company profile & areas

Every tool below accepts **either** an `ico` **or** a `query` (name/domain, auto-resolved CZ→SK):

| Tool | Description |
|------|-------------|
| `profile` | Rich connector-style profile: identity, address, classification, size, financials, scores, contacts, risk, signal counts — in one call |
| `contacts` | Phone, email, website, LinkedIn, Facebook, Twitter |
| `financials` | Revenue, growth, EBIT, EBITDA, margins, assets, registered capital, personnel cost, exporter/importer |
| `risks` | Risk signals (insolvency, liquidation, executions, tax arrears) + health status |
| `metrics` | All available BizMachine metrics, normalized |
| `indicators` | Engagement scores (activity, growth, reachability) with top weighted drivers |
| `nace` | NACE industry classification (primary + secondary) |
| `owned_companies` | Subsidiaries / held stakes (downward ownership graph) |

## Setup

### 1. Get API Key

Sign up at [bizmachine.com](https://bizmachine.com/) and get your API key.

### 2. Install

```bash
git clone https://github.com/davidsimoes/bizmachine-mcp.git
cd bizmachine-mcp
npm install
```

### 3. Configure Claude Code

Add to your `~/.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "bizmachine": {
      "command": "node",
      "args": ["/path/to/bizmachine-mcp/index.mjs"],
      "env": {
        "BIZMACHINE_API_KEY": "your_key"
      }
    }
  }
}
```

## Usage

Once registered, Claude gets these tools automatically:

```
# Quick lookup by domain or name
mcp__bizmachine__lookup("mixit.cz")
mcp__bizmachine__lookup("Košík")

# Batch lookup
mcp__bizmachine__bulk_lookup(["alza.cz", "rohlik.cz", "mixit.cz"])

# Rich, connector-style profile (by name/domain or ICO)
mcp__bizmachine__profile({ query: "alza.cz" })
mcp__bizmachine__profile({ ico: "27082440" })

# Focused areas (each accepts ico OR query)
mcp__bizmachine__contacts({ query: "alza.cz" })       # incl. LinkedIn
mcp__bizmachine__financials({ ico: "27082440" })
mcp__bizmachine__risks({ query: "Sberbank" })          # liquidation, insolvency…
mcp__bizmachine__indicators({ query: "rohlik.cz" })    # engagement scores
mcp__bizmachine__nace({ ico: "24836451" })
mcp__bizmachine__owned_companies({ ico: "27082440" })
mcp__bizmachine__metrics({ query: "mixit.cz" })

# Raw search / full data
mcp__bizmachine__suggest("alza")
mcp__bizmachine__company("27082440")
```

## Features

- **Smart domain matching**: When given a domain, queries the API and matches results by website URL, then falls back to name matching
- **One composite call**: `profile` and the area tools all read BizMachine's `aggregated-data` endpoint, so a single fetch (cached) powers identity, financials, contacts, risk, scores and classification
- **Revenue extraction**: Handles both exact values and range estimates (midpoint)
- **Name normalization**: Strips Czech legal suffixes (s.r.o., a.s., etc.) and diacritics for fuzzy matching
- **CZ + SK with auto-fallback**: Query tools try the Czech database first, then Slovak
- **30-day file cache**: Results cached in `~/.cache/bizmachine/` to avoid redundant API calls
- **Rate limiting**: 150ms between API calls

## API plan tiers

The data each tool can return depends on your BizMachine API plan. The tools above are built on the endpoints available to a standard data key (`suggest`, `aggregated-data`, `indicators`, `owned-companies`). Some BizMachine datasets — detailed financial statements (line items), individual vehicle/fleet records, public-tender and job-posting listings, subsidies, and individual-person contacts — require a higher plan tier and are exposed by BizMachine as separate endpoints. Where only summary/count-level data is available on the standard tier (e.g. fleet size, open-job count, e-shop count), it is surfaced via `metrics` and `profile.signals`.

## License

MIT
