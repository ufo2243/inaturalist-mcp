# iNaturalist MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node.js-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)

Read-only Model Context Protocol server for the public iNaturalist API.

This version uses iNaturalist API v2 for compatible public read endpoints, including default `fields=all` responses so MCP clients receive useful resource data. A small set of identification tools still uses API v1 because equivalent public v2 endpoints are not currently available.

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
- `get_recent_species_nearby`: Get nearby species counts from public observations.
- `get_user_species_summary`: Summarize a user's observed species.
- `find_place_observations`: Find a place by name, then search observations there.
- `search_taxa`: Search taxa by scientific name, common name, rank, or iconic taxon.
- `search_places`: Search places by name.
- `search_users`: Autocomplete users by username or name.
- `get_observation_quality_grades`: Get casual / needs ID / research-grade counts for matching observations.
- `get_observation_iconic_taxa_species_counts`: Get species counts grouped by iconic taxon.
- `get_identification_similar_species`: Find taxa that appear as similar or competing identifications.
- `search`: Universal search across places, projects, taxa, and users.

<details>
<summary>Example Questions</summary>

- What bird observations were recently reported near Shanghai?
- Show recent research-grade spider observations in Guangdong.
- What species has user `misumena2243` observed most often?
- Find observations of `Misumena vatia` from the last year.
- What plants have been observed near latitude `31.2304`, longitude `121.4737` within 10 km?
- Find iNaturalist places matching Shanghai, then use the best place ID for observation searches.
- Find the best matching iNaturalist place for Shanghai and show recent bird observations there.
- Summarize the top species observed by user `misumena2243`.
- What species have been observed near latitude `31.2304`, longitude `121.4737` within 10 km?
- Search iNaturalist projects about urban biodiversity.
- Which iNaturalist places are near this bounding box?
- What annotation terms apply to birds?
- What are the most common observation field values for this project?
- Show recent identifications for spiders in a place.
- Who are the top observers of birds in Shanghai?
- Show a monthly histogram of research-grade observations in China this year.
- Get details for iNaturalist observation `358826279`.
- Search taxa matching `Panthera leo` and show their iNaturalist taxon IDs.
- How many Shanghai bird observations are research grade vs needs ID?
- Which iconic taxa have the most species observed near Shanghai?
- What species are commonly confused with `Panthera leo`?

</details>

<details>
<summary>All Tools</summary>

- `search_observations`: Search public observations by taxon, place, user, date, location, or text.
- `get_observation`: Fetch one observation by numeric ID or v2 UUID.
- `search_taxa`: Search taxa by scientific name, common name, rank, or iconic taxon.
- `get_taxon`: Fetch one taxon by ID.
- `get_observation_species_counts`: Fetch species counts for observation filters.
- `search_places`: Search places by name.
- `get_place`: Fetch one place by ID or slug.
- `search_projects`: Search projects by name, place, location, type, or member.
- `get_project`: Fetch one project by ID or slug.
- `search_users`: Autocomplete users by username or name.
- `get_user`: Fetch one user by ID or username.
- `search`: Universal search across places, projects, taxa, and users.
- `get_observation_histogram`: Fetch observation histograms by date/time interval.
- `get_observation_observers`: Fetch top observers for matching observations.
- `get_observation_identifiers`: Fetch top identifiers for matching observations.
- `get_observation_popular_field_values`: Fetch popular observation field values for matching observations.
- `get_observation_quality_grades`: Fetch observation quality-grade counts.
- `get_observation_identification_categories`: Fetch observation identification-category counts.
- `get_observation_iconic_taxa_species_counts`: Fetch species counts grouped by iconic taxon.
- `get_observation_quality_metrics`: Fetch data-quality assessment metrics for one observation.
- `get_observation_taxon_summary`: Fetch additional taxon summary information for one observation.
- `search_identifications`: Search public identifications by identifier, taxon, place, date, or category. Uses v1 fallback.
- `get_identification`: Fetch one or more identifications by ID. Uses v1 fallback.
- `get_identification_species_counts`: Fetch species counts from matching identifications. Uses v1 fallback.
- `get_identification_identifiers`: Fetch top identifiers from matching identifications. Uses v1 fallback.
- `get_identification_observers`: Fetch top observers from matching identifications. Uses v1 fallback.
- `get_identification_similar_species`: Fetch taxa that appear as similar or competing identifications.
- `get_identification_recent_taxa`: Fetch taxa from recent identifications in a taxon or clade.
- `get_places_nearby`: Fetch places intersecting a bounding box.
- `get_project_members`: Fetch project members by project ID.
- `get_user_projects`: Fetch projects associated with a user.
- `get_controlled_terms`: Fetch annotation controlled terms.
- `get_controlled_terms_for_taxon`: Fetch annotation controlled terms applicable to a taxon.
- `get_iconic_taxa`: Fetch iNaturalist iconic taxa.
- `get_taxon_wanted`: Fetch unobserved or wanted taxa in a clade.
- `get_sites`: Fetch iNaturalist network sites.
- `get_translated_locales`: Fetch translated locales.
- `get_recent_species_nearby`: Convenience wrapper for nearby species counts.
- `get_user_species_summary`: Convenience summary of a user's observed species.
- `find_place_observations`: Convenience wrapper that finds a place then searches observations there.

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

This server only wraps public read endpoints and does not require OAuth. Authenticated write operations are intentionally out of scope.

Most tools use [iNaturalist API v2](https://api.inaturalist.org/v2/docs/). The identification search, identification detail, identification species count, identification identifier, and identification observer tools remain on API v1 because API v2 does not currently provide equivalent public read endpoints with the same filter coverage.
