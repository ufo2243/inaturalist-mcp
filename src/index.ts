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

type TransportMode = "stdio" | "http";

function createServer(): McpServer {
  const server = new McpServer({
    name: "inaturalist-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "search_observations",
    {
      description: "Search public iNaturalist observations by taxon, place, user, date, location, or free text.",
      inputSchema: {
        q: z.string().optional().describe("Free-text search query."),
        taxon_id: z.number().int().positive().optional().describe("iNaturalist taxon ID."),
        place_id: z.number().int().positive().optional().describe("iNaturalist place ID."),
        user_id: z.string().optional().describe("iNaturalist username or user ID."),
        lat: z.number().min(-90).max(90).optional().describe("Latitude for geo search."),
        lng: z.number().min(-180).max(180).optional().describe("Longitude for geo search."),
        radius: z.number().positive().optional().describe("Radius in kilometers when lat/lng are provided."),
        d1: z.string().optional().describe("Observed date lower bound, YYYY-MM-DD."),
        d2: z.string().optional().describe("Observed date upper bound, YYYY-MM-DD."),
        observed_on: z.string().optional().describe("Exact observed date, YYYY-MM-DD."),
        quality_grade: z
          .enum(["casual", "needs_id", "research"])
          .optional()
          .describe("Observation quality grade."),
        order_by: z
          .enum(["created_at", "observed_on", "species_guess", "votes", "id"])
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
        rank: z
          .enum(["kingdom", "phylum", "class", "order", "family", "genus", "species", "subspecies"])
          .optional()
          .describe("Taxonomic rank filter."),
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
        taxon_id: z.number().int().positive().optional().describe("iNaturalist taxon ID."),
        place_id: z.number().int().positive().optional().describe("iNaturalist place ID."),
        user_id: z.string().optional().describe("iNaturalist username or user ID."),
        lat: z.number().min(-90).max(90).optional().describe("Latitude for geo search."),
        lng: z.number().min(-180).max(180).optional().describe("Longitude for geo search."),
        radius: z.number().positive().optional().describe("Radius in kilometers when lat/lng are provided."),
        d1: z.string().optional().describe("Observed date lower bound, YYYY-MM-DD."),
        d2: z.string().optional().describe("Observed date upper bound, YYYY-MM-DD."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
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
