#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const API_BASE_URL = "https://api.inaturalist.org/v1";
const USER_AGENT = "inaturalist-mcp/1.0 (https://github.com/ufo2243/inaturalist-mcp)";

type QueryValue = string | number | boolean | undefined | null;
type QueryParams = Record<string, QueryValue | QueryValue[]>;

class INaturalistApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

function buildUrl(path: string, params: QueryParams = {}): URL {
  const url = new URL(`${API_BASE_URL}/${path.replace(/^\/+/, "")}`);

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function getJson(path: string, params: QueryParams = {}): Promise<unknown> {
  const url = buildUrl(path, params);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new INaturalistApiError(
      `iNaturalist API request failed with HTTP ${response.status}`,
      response.status,
      body.slice(0, 1000),
    );
  }

  return response.json();
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof INaturalistApiError
      ? `${error.message}\n\n${error.body}`
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

const paginationSchema = {
  page: z.number().int().min(1).optional().describe("Page number. Defaults to 1."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Results per page, capped at 50. Defaults to iNaturalist's API default."),
};

const taxonRankSchema = z.enum([
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
  "subspecies",
]);

const observationFilterSchema = {
  q: z.string().optional().describe("Free-text observation search query."),
  taxon_id: z.number().int().positive().optional().describe("iNaturalist taxon ID."),
  taxon_name: z.string().optional().describe("Scientific or common taxon name."),
  iconic_taxa: z
    .string()
    .optional()
    .describe("Comma-separated iconic taxa, e.g. Aves,Mammalia,Plantae,Arachnida."),
  place_id: z.union([z.number().int().positive(), z.string()]).optional().describe("iNaturalist place ID or slug."),
  project_id: z.string().optional().describe("iNaturalist project ID or slug."),
  user_id: z.string().optional().describe("iNaturalist username or user ID."),
  user_login: z.string().optional().describe("iNaturalist username."),
  lat: z.number().min(-90).max(90).optional().describe("Latitude for radius search."),
  lng: z.number().min(-180).max(180).optional().describe("Longitude for radius search."),
  radius: z.number().positive().optional().describe("Radius in kilometers when lat/lng are provided."),
  nelat: z.number().min(-90).max(90).optional().describe("Northeast latitude for bounding-box search."),
  nelng: z.number().min(-180).max(180).optional().describe("Northeast longitude for bounding-box search."),
  swlat: z.number().min(-90).max(90).optional().describe("Southwest latitude for bounding-box search."),
  swlng: z.number().min(-180).max(180).optional().describe("Southwest longitude for bounding-box search."),
  d1: z.string().optional().describe("Observed date lower bound, YYYY-MM-DD."),
  d2: z.string().optional().describe("Observed date upper bound, YYYY-MM-DD."),
  observed_on: z.string().optional().describe("Exact observed date, YYYY-MM-DD."),
  created_d1: z.string().optional().describe("Created date lower bound, YYYY-MM-DD."),
  created_d2: z.string().optional().describe("Created date upper bound, YYYY-MM-DD."),
  updated_since: z.string().optional().describe("Only observations updated since this ISO timestamp or date."),
  quality_grade: z
    .enum(["casual", "needs_id", "research"])
    .optional()
    .describe("Observation quality grade."),
  verifiable: z.boolean().optional().describe("Observations with needs_id or research quality grade."),
  photos: z.boolean().optional().describe("Only observations with photos."),
  sounds: z.boolean().optional().describe("Only observations with sounds."),
  captive: z.boolean().optional().describe("Captive or cultivated observations."),
  identified: z.boolean().optional().describe("Observations that have community identifications."),
  geo: z.boolean().optional().describe("Observations with coordinates."),
  mappable: z.boolean().optional().describe("Observations that can be shown on maps."),
  hrank: taxonRankSchema.optional().describe("Taxon must have this rank or lower."),
  lrank: taxonRankSchema.optional().describe("Taxon must have this rank or higher."),
  search_on: z.enum(["names", "tags", "description", "place"]).optional().describe("Field to search when using q."),
  locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
  preferred_place_id: z.number().int().positive().optional().describe("Place preference for regional common names."),
};

type TransportMode = "stdio" | "http";

function createServer(): McpServer {
  const server = new McpServer({
    name: "inaturalist-mcp",
    version: "1.1.0",
  });

  server.registerTool(
    "search_observations",
    {
      description: "Search public iNaturalist observations by taxon, place, user, date, location, or free text.",
      inputSchema: {
        ...observationFilterSchema,
        order_by: z
          .enum(["created_at", "geo_score", "id", "observed_on", "random", "species_guess", "updated_at", "votes"])
          .optional()
          .describe("Sort field."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation",
    {
      description: "Get one public iNaturalist observation by observation ID.",
      inputSchema: {
        id: z.number().int().positive().describe("iNaturalist observation ID."),
      },
    },
    async ({ id }) => {
      try {
        return toolResult(await getJson(`observations/${id}`));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_taxa",
    {
      description: "Search iNaturalist taxa by name, common name, rank, or iconic taxon.",
      inputSchema: {
        q: z.string().optional().describe("Taxon name or common name query."),
        rank: taxonRankSchema.optional().describe("Taxonomic rank filter."),
        iconic_taxa: z
          .string()
          .optional()
          .describe("Comma-separated iconic taxa, e.g. Aves,Mammalia,Plantae."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("taxa", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_taxon",
    {
      description: "Get one iNaturalist taxon by taxon ID.",
      inputSchema: {
        id: z.number().int().positive().describe("iNaturalist taxon ID."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
      },
    },
    async ({ id, locale }) => {
      try {
        return toolResult(await getJson(`taxa/${id}`, { locale }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_species_counts",
    {
      description: "Get species counts from public iNaturalist observations for a place, taxon, user, date range, or location.",
      inputSchema: {
        ...observationFilterSchema,
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/species_counts", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_places",
    {
      description: "Autocomplete iNaturalist places by name.",
      inputSchema: {
        q: z.string().describe("Place name query, e.g. Shanghai."),
        order_by: z.enum(["area"]).optional().describe("Sort places by area."),
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("places/autocomplete", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_place",
    {
      description: "Get one iNaturalist place by ID or slug.",
      inputSchema: {
        id: z.union([z.number().int().positive(), z.string()]).describe("iNaturalist place ID or slug."),
        admin_level: z
          .string()
          .optional()
          .describe("Optional comma-separated admin levels, e.g. 0,10,20."),
      },
    },
    async ({ id, admin_level }) => {
      try {
        return toolResult(await getJson(`places/${id}`, { admin_level }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_projects",
    {
      description: "Search iNaturalist projects by name, place, location, type, or member.",
      inputSchema: {
        q: z.string().optional().describe("Project name query."),
        id: z.string().optional().describe("Project ID or slug."),
        not_id: z.string().optional().describe("Exclude project ID or slug."),
        lat: z.number().min(-90).max(90).optional().describe("Latitude for location search."),
        lng: z.number().min(-180).max(180).optional().describe("Longitude for location search."),
        radius: z.number().positive().optional().describe("Radius in kilometers when lat/lng are provided."),
        place_id: z.string().optional().describe("Associated place ID or slug."),
        featured: z.boolean().optional().describe("Only featured projects."),
        noteworthy: z.boolean().optional().describe("Only noteworthy projects."),
        type: z.enum(["collection", "umbrella"]).optional().describe("Project type."),
        member_id: z.string().optional().describe("Only projects with this member user ID or username."),
        order_by: z
          .enum(["recent_posts", "created", "updated", "distance", "featured"])
          .optional()
          .describe("Sort field."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("projects", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_project",
    {
      description: "Get one iNaturalist project by ID or slug.",
      inputSchema: {
        id: z.union([z.number().int().positive(), z.string()]).describe("iNaturalist project ID or slug."),
        rule_details: z.boolean().optional().describe("Include project rule details."),
      },
    },
    async ({ id, rule_details }) => {
      try {
        return toolResult(await getJson(`projects/${id}`, { rule_details }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_users",
    {
      description: "Autocomplete iNaturalist users by username or name.",
      inputSchema: {
        q: z.string().describe("Username or name query."),
        project_id: z.string().optional().describe("Limit to users associated with this project ID or slug."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("users/autocomplete", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user",
    {
      description: "Get one iNaturalist user by ID or username.",
      inputSchema: {
        id: z.union([z.number().int().positive(), z.string()]).describe("iNaturalist user ID or username."),
      },
    },
    async ({ id }) => {
      try {
        return toolResult(await getJson(`users/${id}`));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search",
    {
      description: "Universal iNaturalist search across places, projects, taxa, and users.",
      inputSchema: {
        q: z.string().optional().describe("Search query."),
        sources: z
          .string()
          .optional()
          .describe("Comma-separated sources: places,projects,taxa,users."),
        place_id: z.string().optional().describe("Associated place ID or slug."),
        include_taxon_ancestors: z.boolean().optional().describe("Include taxon ancestors in taxon search results."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
        preferred_place_id: z.number().int().positive().optional().describe("Place preference for regional common names."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("search", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_histogram",
    {
      description: "Get a date/time histogram for public iNaturalist observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        date_field: z.enum(["observed", "created"]).optional().describe("Date field to histogram."),
        interval: z.enum(["hour", "day", "week", "month", "year"]).optional().describe("Histogram interval."),
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/histogram", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_observers",
    {
      description: "Get top observers for public iNaturalist observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/observers", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_identifiers",
    {
      description: "Get top identifiers for public iNaturalist observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/identifiers", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getTransportMode(): TransportMode {
  const value = getArgValue("--transport") ?? process.env.MCP_TRANSPORT ?? "stdio";
  if (value === "stdio" || value === "http") {
    return value;
  }

  throw new Error(`Unsupported transport "${value}". Use "stdio" or "http".`);
}

function getPort(): number {
  const value = getArgValue("--port") ?? process.env.PORT ?? "3000";
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port "${value}".`);
  }

  return port;
}

function getHost(): string {
  return getArgValue("--host") ?? process.env.HOST ?? "127.0.0.1";
}

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iNaturalist MCP server running on stdio");
}

async function runHttp() {
  const host = getHost();
  const port = getPort();
  const app = createMcpExpressApp({ host });
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      let transport: StreamableHTTPServerTransport;

      if (typeof sessionId === "string" && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            delete transports[closedSessionId];
          }
        };

        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: missing session ID or initialize request",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transports[sessionId].handleRequest(req, res);
  });

  const httpServer = app.listen(port, host, () => {
    console.error(`iNaturalist MCP server listening at http://${host}:${port}/mcp`);
  });

  process.on("SIGINT", async () => {
    for (const transport of Object.values(transports)) {
      await transport.close();
    }
    httpServer.close(() => process.exit(0));
  });
}

async function main() {
  if (getTransportMode() === "http") {
    await runHttp();
    return;
  }

  await runStdio();
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
