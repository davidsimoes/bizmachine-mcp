# bizmachine-mcp

MCP server for [BizzMachine](https://bizmachine.com/) — Czech and Slovak company data API. Look up revenue, employee counts, NACE codes, and more for any Czech company by name or domain.

## Tools

| Tool | Description |
|------|-------------|
| `suggest` | Search companies by name or domain |
| `company` | Get full data by ICO (national ID) |
| `lookup` | Smart lookup: name/domain → best match → structured data with revenue |
| `bulk_lookup` | Batch lookup for multiple companies |

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
# Look up a company by domain
mcp__bizmachine__lookup("mixit.cz")

# Look up by name
mcp__bizmachine__lookup("Košík")

# Batch lookup
mcp__bizmachine__bulk_lookup(["alza.cz", "rohlik.cz", "mixit.cz"])

# Raw suggest search
mcp__bizmachine__suggest("alza")

# Get data by ICO
mcp__bizmachine__company("27082440")
```

## Features

- **Smart domain matching**: When given a domain, queries the API and matches results by website URL, then falls back to name matching
- **Revenue extraction**: Handles both exact values and range estimates (midpoint)
- **Name normalization**: Strips Czech legal suffixes (s.r.o., a.s., etc.) and diacritics for fuzzy matching
- **30-day file cache**: Results cached in `~/.cache/bizmachine/` to avoid redundant API calls
- **Rate limiting**: 150ms between API calls

## License

MIT
