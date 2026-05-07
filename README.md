# iNaturalist MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node.js-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)

Read-only Model Context Protocol server for the public iNaturalist API.

## Tools

- `search_observations`: Search public observations by taxon, place, user, date, location, or text.
- `get_observation`: Fetch one observation by ID.
- `search_taxa`: Search taxa by scientific name, common name, rank, or iconic taxon.
- `get_taxon`: Fetch one taxon by ID.
- `get_observation_species_counts`: Fetch species counts for observation filters.

## Install

From npm:

```bash
npm install -g inaturalist-mcp
```

From source:

```bash
npm install
npm run build
```

## Run

Stdio transport, for local MCP clients:

```bash
inaturalist-mcp
```

HTTP transport, for deployed MCP clients:

```bash
node dist/index.js --transport http --host 127.0.0.1 --port 8890
```

You can also configure HTTP mode with environment variables:

```bash
MCP_TRANSPORT=http HOST=0.0.0.0 PORT=8890 node dist/index.js
```

The HTTP MCP endpoint is:

```text
http://127.0.0.1:8890/mcp
```

## Client Config

Example stdio MCP client configuration:

Using npm:

```json
{
  "mcpServers": {
    "inaturalist": {
      "command": "npx",
      "args": ["-y", "inaturalist-mcp"]
    }
  }
}
```

Using a local checkout:

```json
{
  "mcpServers": {
    "inaturalist": {
      "command": "node",
      "args": ["/path/to/inaturalist-mcp/dist/index.js"]
    }
  }
}
```

Example Streamable HTTP MCP client URL:

```text
http://127.0.0.1:8890/mcp
```

## Notes

This server only wraps public read endpoints and does not require OAuth. Authenticated write operations are intentionally out of scope for the initial version.
