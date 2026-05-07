# iNaturalist MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node.js-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)

Read-only Model Context Protocol server for the public iNaturalist API.

## MCP Config

Use the published npm package:

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

After adding the config, restart or reload your MCP client.

## Main Tools

- `search_observations`: Search public observations by taxon, place, user, date, location, or text.
- `search_taxa`: Search taxa by scientific name, common name, rank, or iconic taxon.
- `search_places`: Autocomplete places by name.
- `search_users`: Autocomplete users by username or name.
- `search`: Universal search across places, projects, taxa, and users.

<details>
<summary>Example Questions</summary>

- What bird observations were recently reported near Shanghai?
- Show recent research-grade spider observations in Guangdong.
- What species has user `misumena2243` observed most often?
- Find observations of `Misumena vatia` from the last year.
- What plants have been observed near latitude `31.2304`, longitude `121.4737` within 10 km?
- Find iNaturalist places matching Shanghai, then use the best place ID for observation searches.
- Search iNaturalist projects about urban biodiversity.
- Who are the top observers of birds in Shanghai?
- Show a monthly histogram of research-grade observations in China this year.
- Get details for iNaturalist observation `358826279`.
- Search taxa matching `Panthera leo` and show their iNaturalist taxon IDs.

</details>

<details>
<summary>All Tools</summary>

- `search_observations`: Search public observations by taxon, place, user, date, location, or text.
- `get_observation`: Fetch one observation by ID.
- `search_taxa`: Search taxa by scientific name, common name, rank, or iconic taxon.
- `get_taxon`: Fetch one taxon by ID.
- `get_observation_species_counts`: Fetch species counts for observation filters.
- `search_places`: Autocomplete places by name.
- `get_place`: Fetch one place by ID or slug.
- `search_projects`: Search projects by name, place, location, type, or member.
- `get_project`: Fetch one project by ID or slug.
- `search_users`: Autocomplete users by username or name.
- `get_user`: Fetch one user by ID or username.
- `search`: Universal search across places, projects, taxa, and users.
- `get_observation_histogram`: Fetch observation histograms by date/time interval.
- `get_observation_observers`: Fetch top observers for matching observations.
- `get_observation_identifiers`: Fetch top identifiers for matching observations.

</details>

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

## More Client Config

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
