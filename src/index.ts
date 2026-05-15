#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const SERVER_VERSION = "1.3.0";
const API_BASE_URLS = {
  v1: "https://api.inaturalist.org/v1",
  v2: "https://api.inaturalist.org/v2",
} as const;
const USER_AGENT = `inaturalist-mcp/${SERVER_VERSION} (https://github.com/ufo2243/inaturalist-mcp)`;

type ApiVersion = keyof typeof API_BASE_URLS;
type QueryValue = string | number | boolean | undefined | null;
type QueryParams = Record<string, QueryValue | QueryValue[]>;
type GetJsonOptions = {
  apiVersion?: ApiVersion;
  defaultFields?: boolean | string;
};

const COMPACT_TAXON_COUNT_FIELDS =
  "count,taxon.id,taxon.name,taxon.preferred_common_name,taxon.rank,taxon.iconic_taxon_name,taxon.observations_count,taxon.default_photo";

class INaturalistApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

function buildUrl(path: string, params: QueryParams = {}, apiVersion: ApiVersion = "v2"): URL {
  const url = new URL(`${API_BASE_URLS[apiVersion]}/${path.replace(/^\/+/, "")}`);

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

async function getJson(path: string, params: QueryParams = {}, options: GetJsonOptions = {}): Promise<unknown> {
  const apiVersion = options.apiVersion ?? "v2";
  const requestParams = { ...params };

  if (
    apiVersion === "v2" &&
    options.defaultFields &&
    (requestParams.fields === undefined || requestParams.fields === null || requestParams.fields === "")
  ) {
    requestParams.fields = typeof options.defaultFields === "string" ? options.defaultFields : "all";
  }

  const url = buildUrl(path, requestParams, apiVersion);
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function resultsOf(value: unknown): unknown[] {
  const results = asRecord(value).results;
  return Array.isArray(results) ? results : [];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolveObservationUuid(id: number | string): Promise<string> {
  if (typeof id === "string" && isUuid(id)) {
    return id;
  }

  const observations = await getJson(
    "observations",
    {
      id,
      per_page: 1,
      fields: "id,uuid",
    },
    { apiVersion: "v2" },
  );
  const firstObservation = asRecord(resultsOf(observations)[0]);
  const uuid = firstObservation.uuid;

  if (typeof uuid !== "string") {
    throw new Error(`No iNaturalist observation matched "${id}".`);
  }

  return uuid;
}

function countByIconicTaxon(items: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of items) {
    const itemRecord = asRecord(item);
    const taxon = asRecord(itemRecord.taxon);
    const iconicTaxonName = typeof taxon.iconic_taxon_name === "string" ? taxon.iconic_taxon_name : "unknown";
    const count = typeof itemRecord.count === "number" ? itemRecord.count : 0;
    counts[iconicTaxonName] = (counts[iconicTaxonName] ?? 0) + count;
  }

  return counts;
}

function summarizeSpeciesCounts(data: unknown) {
  return resultsOf(data).map((item) => {
    const itemRecord = asRecord(item);
    const taxon = asRecord(itemRecord.taxon);

    return {
      count: itemRecord.count,
      taxon_id: taxon.id,
      name: taxon.name,
      common_name: taxon.preferred_common_name,
      rank: taxon.rank,
      iconic_taxon_name: taxon.iconic_taxon_name,
    };
  });
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

const fieldsSchema = {
  fields: z
    .string()
    .optional()
    .describe('iNaturalist API v2 response fields, e.g. "id,uuid,name" or "all". Defaults to "all" for v2 tools.'),
};

const observationIdSchema = z
  .union([z.number().int().positive(), z.string()])
  .describe("iNaturalist observation numeric ID or v2 UUID.");

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
  id: z.string().optional().describe("Observation ID, or comma-separated observation IDs."),
  not_id: z.string().optional().describe("Observation ID, or comma-separated observation IDs, to exclude."),
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
  month: z.string().optional().describe("Observed month number, or comma-separated month numbers."),
  year: z.string().optional().describe("Observed year, or comma-separated years."),
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

const identificationFilterSchema = {
  id: z.string().optional().describe("Comma-separated identification IDs."),
  user_id: z.string().optional().describe("Identifier user ID."),
  user_login: z.string().optional().describe("Identifier username."),
  taxon_id: z.string().optional().describe("Identification taxon ID, or comma-separated taxon IDs."),
  observation_taxon_id: z.string().optional().describe("Observation taxon ID, or comma-separated taxon IDs."),
  place_id: z.string().optional().describe("Observation place ID, or comma-separated place IDs."),
  category: z
    .enum(["improving", "supporting", "leading", "maverick"])
    .optional()
    .describe("Identification category."),
  quality_grade: z.enum(["casual", "needs_id", "research"]).optional().describe("Observation quality grade."),
  current: z.union([z.boolean(), z.literal("any")]).optional().describe("Most recent ID on an observation by a user."),
  current_taxon: z.boolean().optional().describe("Identification taxon matches the observation taxon."),
  own_observation: z.boolean().optional().describe("Identification was added by the observer."),
  is_change: z.boolean().optional().describe("Identification was created as a result of a taxon change."),
  taxon_active: z.boolean().optional().describe("Identification taxon is currently active."),
  observation_taxon_active: z.boolean().optional().describe("Observation taxon is currently active."),
  iconic_taxon_id: z.string().optional().describe("Identification iconic taxon ID, or comma-separated IDs."),
  observation_iconic_taxon_id: z.string().optional().describe("Observation iconic taxon ID, or comma-separated IDs."),
  rank: z.string().optional().describe("Identification taxon rank."),
  observation_rank: z.string().optional().describe("Observation taxon rank."),
  lrank: z.string().optional().describe("Identification taxon must have this rank or higher."),
  hrank: z.string().optional().describe("Identification taxon must have this rank or lower."),
  observation_lrank: z.string().optional().describe("Observation taxon must have this rank or higher."),
  observation_hrank: z.string().optional().describe("Observation taxon must have this rank or lower."),
  without_taxon_id: z.string().optional().describe("Exclude identifications of these taxa and descendants."),
  without_observation_taxon_id: z.string().optional().describe("Exclude observations of these taxa and descendants."),
  d1: z.string().optional().describe("Identification created on or after this date/time."),
  d2: z.string().optional().describe("Identification created on or before this date/time."),
  observed_d1: z.string().optional().describe("Observation observed on or after this date."),
  observed_d2: z.string().optional().describe("Observation observed on or before this date."),
  observation_created_d1: z.string().optional().describe("Observation created on or after this date."),
  observation_created_d2: z.string().optional().describe("Observation created on or before this date."),
};

type TransportMode = "stdio" | "http";

function createServer(): McpServer {
  const server = new McpServer({
    name: "inaturalist-mcp",
    version: SERVER_VERSION,
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation",
    {
      description: "Get one public iNaturalist observation by numeric observation ID or v2 UUID.",
      inputSchema: {
        id: observationIdSchema,
        ...fieldsSchema,
      },
    },
    async ({ id, fields }) => {
      try {
        if (typeof id === "string" && isUuid(id)) {
          return toolResult(await getJson(`observations/${id}`, { fields }, { apiVersion: "v2", defaultFields: true }));
        }

        return toolResult(
          await getJson("observations", { id, per_page: 1, fields }, { apiVersion: "v2", defaultFields: true }),
        );
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
        preferred_place_id: z.number().int().positive().optional().describe("Place preference for regional common names."),
        ...paginationSchema,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("taxa", args, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async ({ id, locale, fields }) => {
      try {
        return toolResult(await getJson(`taxa/${id}`, { locale, fields }, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/species_counts", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_places",
    {
      description: "Search iNaturalist places by name using the v2 places endpoint.",
      inputSchema: {
        q: z.string().describe("Place name query, e.g. Shanghai."),
        order_by: z.enum(["area"]).optional().describe("Sort places by area."),
        geo: z.boolean().optional().describe("Only return places with geometry."),
        per_page: paginationSchema.per_page,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("places", args, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async ({ id, admin_level, fields }) => {
      try {
        return toolResult(await getJson(`places/${id}`, { admin_level, fields }, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        const { featured, ...projectArgs } = args;
        return toolResult(
          await getJson(
            "projects",
            {
              ...projectArgs,
              features: featured,
            },
            { apiVersion: "v2", defaultFields: true },
          ),
        );
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
        ...fieldsSchema,
      },
    },
    async ({ id, rule_details, fields }) => {
      try {
        return toolResult(await getJson(`projects/${id}`, { rule_details, fields }, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("users/autocomplete", args, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async ({ id, fields }) => {
      try {
        return toolResult(await getJson(`users/${id}`, { fields }, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("search", args, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/histogram", args, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/observers", args, { apiVersion: "v2", defaultFields: true }));
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
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/identifiers", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_popular_field_values",
    {
      description: "Get popular observation field values for public observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        ...paginationSchema,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/popular_field_values", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_identifications",
    {
      description:
        "Search public iNaturalist identifications by identifier, taxon, observation taxon, place, date, or category. Uses the v1 endpoint because v2 does not provide equivalent public search coverage.",
      inputSchema: {
        ...identificationFilterSchema,
        order_by: z.enum(["created_at", "id"]).optional().describe("Sort field."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("identifications", args, { apiVersion: "v1" }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_identification",
    {
      description: "Get one or more public iNaturalist identifications by ID. Uses v1 because v2 has no public GET-by-ID endpoint.",
      inputSchema: {
        id: z.string().describe("Identification ID, or comma-separated IDs."),
      },
    },
    async ({ id }) => {
      try {
        return toolResult(await getJson(`identifications/${id}`, {}, { apiVersion: "v1" }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_identification_species_counts",
    {
      description:
        "Get species counts from public iNaturalist identifications matching filters. Uses v1 because v2 has no equivalent endpoint.",
      inputSchema: {
        ...identificationFilterSchema,
        taxon_of: z
          .enum(["identification", "observation"])
          .optional()
          .describe("Whether to count identification taxa or observation taxa."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("identifications/species_counts", args, { apiVersion: "v1" }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_identification_identifiers",
    {
      description:
        "Get top identifiers from public iNaturalist identifications matching filters. Uses v1 to preserve the broader filter set.",
      inputSchema: {
        ...identificationFilterSchema,
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("identifications/identifiers", args, { apiVersion: "v1" }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_identification_observers",
    {
      description:
        "Get top observers from public iNaturalist identifications matching filters. Uses v1 because v2 has no equivalent endpoint.",
      inputSchema: {
        ...identificationFilterSchema,
        ...paginationSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("identifications/observers", args, { apiVersion: "v1" }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_places_nearby",
    {
      description: "Find iNaturalist places intersecting a bounding box.",
      inputSchema: {
        nelat: z.number().min(-90).max(90).describe("Northeast latitude."),
        nelng: z.number().min(-180).max(180).describe("Northeast longitude."),
        swlat: z.number().min(-90).max(90).describe("Southwest latitude."),
        swlng: z.number().min(-180).max(180).describe("Southwest longitude."),
        name: z.string().optional().describe("Optional place name filter."),
        per_page: paginationSchema.per_page,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("places/nearby", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_project_members",
    {
      description: "Get members of an iNaturalist project by project ID.",
      inputSchema: {
        id: z.number().int().positive().describe("iNaturalist project ID."),
        role: z.enum(["curator", "manager"]).optional().describe("Membership role filter."),
        skip_counts: z.boolean().optional().describe("Skip expensive count fields when supported by the API."),
        ...paginationSchema,
        ...fieldsSchema,
      },
    },
    async ({ id, role, skip_counts, page, per_page, fields }) => {
      try {
        return toolResult(
          await getJson(
            `projects/${id}/members`,
            { role, skip_counts, page, per_page, fields },
            { apiVersion: "v2", defaultFields: true },
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user_projects",
    {
      description: "Get projects associated with an iNaturalist user by user ID or username.",
      inputSchema: {
        id: z.union([z.number().int().positive(), z.string()]).describe("iNaturalist user ID or username."),
        rule_details: z.boolean().optional().describe("Include project rule details."),
        project_type: z.enum(["collection", "umbrella"]).optional().describe("Project type filter."),
        ...paginationSchema,
        ...fieldsSchema,
      },
    },
    async ({ id, rule_details, project_type, page, per_page, fields }) => {
      try {
        return toolResult(
          await getJson(
            `users/${id}/projects`,
            { rule_details, project_type, page, per_page, fields },
            { apiVersion: "v2", defaultFields: true },
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_controlled_terms",
    {
      description: "Get iNaturalist controlled terms used for annotations.",
      inputSchema: {
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("controlled_terms", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_controlled_terms_for_taxon",
    {
      description: "Get annotation controlled terms applicable to a taxon.",
      inputSchema: {
        taxon_id: z.number().int().positive().describe("iNaturalist taxon ID."),
        ...fieldsSchema,
      },
    },
    async ({ taxon_id, fields }) => {
      try {
        return toolResult(
          await getJson(`controlled_terms/for_taxon/${taxon_id}`, { fields }, { apiVersion: "v2", defaultFields: true }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_quality_grades",
    {
      description: "Get quality-grade counts for public iNaturalist observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("observations/quality_grades", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_identification_categories",
    {
      description: "Get identification-category counts for public iNaturalist observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(
          await getJson("observations/identification_categories", args, { apiVersion: "v2", defaultFields: true }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_iconic_taxa_species_counts",
    {
      description: "Get species counts grouped by iconic taxon for public iNaturalist observations matching filters.",
      inputSchema: {
        ...observationFilterSchema,
        ...paginationSchema,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(
          await getJson("observations/iconic_taxa_species_counts", args, {
            apiVersion: "v2",
            defaultFields: COMPACT_TAXON_COUNT_FIELDS,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_quality_metrics",
    {
      description: "Get data-quality assessment metrics for an iNaturalist observation by numeric ID or v2 UUID.",
      inputSchema: {
        id: observationIdSchema,
        ...fieldsSchema,
      },
    },
    async ({ id, fields }) => {
      try {
        const uuid = await resolveObservationUuid(id);
        return toolResult(
          await getJson(`observations/${uuid}/quality_metrics`, { fields }, { apiVersion: "v2", defaultFields: true }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_observation_taxon_summary",
    {
      description: "Get additional taxon summary information for an iNaturalist observation by numeric ID or v2 UUID.",
      inputSchema: {
        id: observationIdSchema,
        community: z.boolean().optional().describe("Show information about the community taxon instead of the observation taxon."),
      },
    },
    async ({ id, community }) => {
      try {
        const uuid = await resolveObservationUuid(id);
        return toolResult(await getJson(`observations/${uuid}/taxon_summary`, { community }, { apiVersion: "v2" }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_iconic_taxa",
    {
      description: "Get the standard iconic taxa used by iNaturalist, such as Aves, Mammalia, Plantae, and Insecta.",
      inputSchema: {
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("taxa/iconic", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_taxon_wanted",
    {
      description: "Get unobserved or wanted taxa in a clade by iNaturalist taxon ID.",
      inputSchema: {
        id: z.number().int().positive().describe("iNaturalist taxon ID for the clade."),
        ...paginationSchema,
        fields: fieldsSchema.fields.describe(
          "iNaturalist API v2 response fields. Defaults to a compact response for this endpoint; use all for full taxon data.",
        ),
      },
    },
    async ({ id, page, per_page, fields }) => {
      try {
        return toolResult(
          await getJson(`taxa/${id}/wanted`, { page, per_page, fields }, { apiVersion: "v2", defaultFields: false }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_identification_similar_species",
    {
      description: "Get taxa that have appeared as similar or competing identifications for a taxon.",
      inputSchema: {
        taxon_id: z.number().int().positive().describe("iNaturalist taxon ID."),
        quality_grade: z.enum(["casual", "needs_id", "research"]).optional().describe("Observation quality grade."),
        ...paginationSchema,
        fields: fieldsSchema.fields.describe("iNaturalist API v2 response fields. Defaults to compact taxon count fields."),
      },
    },
    async (args) => {
      try {
        return toolResult(
          await getJson("identifications/similar_species", args, {
            apiVersion: "v2",
            defaultFields: COMPACT_TAXON_COUNT_FIELDS,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_identification_recent_taxa",
    {
      description: "Get taxa from recent identifications within a taxon or clade.",
      inputSchema: {
        taxon_id: z.string().describe("Taxon ID, or comma-separated taxon IDs."),
        quality_grade: z.enum(["casual", "needs_id", "research"]).optional().describe("Observation quality grade."),
        rank: z.string().optional().describe("Identification taxon rank."),
        category: z
          .enum(["improving", "supporting", "leading", "maverick"])
          .optional()
          .describe("Identification category."),
        verifiable: z.boolean().optional().describe("Only observations with needs_id or research quality grade."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
        ...paginationSchema,
        fields: fieldsSchema.fields.describe("iNaturalist API v2 response fields. Defaults to compact taxon count fields."),
      },
    },
    async (args) => {
      try {
        return toolResult(
          await getJson("identifications/recent_taxa", args, {
            apiVersion: "v2",
            defaultFields: COMPACT_TAXON_COUNT_FIELDS,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_sites",
    {
      description: "List iNaturalist network sites.",
      inputSchema: {
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("sites", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_translated_locales",
    {
      description: "List locales translated by iNaturalist.",
      inputSchema: {
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        return toolResult(await getJson("translations/locales", args, { apiVersion: "v2", defaultFields: true }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_recent_species_nearby",
    {
      description: "Convenience tool: get recent species counts near a latitude/longitude using public observations.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("Latitude."),
        lng: z.number().min(-180).max(180).describe("Longitude."),
        radius: z.number().positive().default(10).describe("Radius in kilometers."),
        iconic_taxa: z.string().optional().describe("Comma-separated iconic taxa, e.g. Aves,Plantae."),
        d1: z.string().optional().describe("Observed date lower bound, YYYY-MM-DD."),
        d2: z.string().optional().describe("Observed date upper bound, YYYY-MM-DD."),
        quality_grade: z.enum(["casual", "needs_id", "research"]).optional().describe("Observation quality grade."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
        per_page: paginationSchema.per_page,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        const speciesCounts = await getJson("observations/species_counts", args, { apiVersion: "v2", defaultFields: true });
        return toolResult({
          query: args,
          summary: {
            species_taxa_returned: resultsOf(speciesCounts).length,
            total_species_taxa_matching: asRecord(speciesCounts).total_results,
          },
          top_species: summarizeSpeciesCounts(speciesCounts),
          raw: speciesCounts,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user_species_summary",
    {
      description: "Convenience tool: summarize a user's observed species from public observations.",
      inputSchema: {
        user_id: z.string().describe("iNaturalist username or user ID."),
        iconic_taxa: z.string().optional().describe("Comma-separated iconic taxa, e.g. Aves,Plantae."),
        d1: z.string().optional().describe("Observed date lower bound, YYYY-MM-DD."),
        d2: z.string().optional().describe("Observed date upper bound, YYYY-MM-DD."),
        quality_grade: z.enum(["casual", "needs_id", "research"]).optional().describe("Observation quality grade."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
        per_page: paginationSchema.per_page,
        ...fieldsSchema,
      },
    },
    async (args) => {
      try {
        const [observations, speciesCounts] = await Promise.all([
          getJson("observations", { ...args, per_page: 1 }, { apiVersion: "v2", defaultFields: true }),
          getJson("observations/species_counts", args, { apiVersion: "v2", defaultFields: true }),
        ]);
        const topSpecies = summarizeSpeciesCounts(speciesCounts);

        return toolResult({
          query: args,
          summary: {
            total_observations: asRecord(observations).total_results,
            total_species_taxa_matching: asRecord(speciesCounts).total_results,
            species_taxa_returned: topSpecies.length,
            counts_by_iconic_taxon_in_returned_species: countByIconicTaxon(resultsOf(speciesCounts)),
          },
          top_species: topSpecies,
          raw: {
            observations,
            species_counts: speciesCounts,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "find_place_observations",
    {
      description: "Convenience tool: find a place by name, then search public observations in the best-matching place.",
      inputSchema: {
        q: z.string().describe("Place name query, e.g. Shanghai."),
        iconic_taxa: z.string().optional().describe("Comma-separated iconic taxa, e.g. Aves,Plantae."),
        taxon_id: z.number().int().positive().optional().describe("iNaturalist taxon ID."),
        taxon_name: z.string().optional().describe("Scientific or common taxon name."),
        d1: z.string().optional().describe("Observed date lower bound, YYYY-MM-DD."),
        d2: z.string().optional().describe("Observed date upper bound, YYYY-MM-DD."),
        quality_grade: z.enum(["casual", "needs_id", "research"]).optional().describe("Observation quality grade."),
        order_by: z
          .enum(["created_at", "geo_score", "id", "observed_on", "random", "species_guess", "updated_at", "votes"])
          .optional()
          .describe("Observation sort field."),
        order: z.enum(["asc", "desc"]).optional().describe("Observation sort direction."),
        locale: z.string().optional().describe("Locale for common names, e.g. en, zh-CN."),
        per_page: paginationSchema.per_page,
        ...fieldsSchema,
      },
    },
    async ({ q, ...observationArgs }) => {
      try {
        const places = await getJson("places", { q, per_page: 1, fields: "all" }, { apiVersion: "v2" });
        const selectedPlace = resultsOf(places)[0];
        const selectedPlaceRecord = asRecord(selectedPlace);

        if (!selectedPlaceRecord.id) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `No iNaturalist place matched "${q}".`,
              },
            ],
          };
        }

        const observations = await getJson("observations", {
          ...observationArgs,
          place_id: String(selectedPlaceRecord.id),
        }, { apiVersion: "v2", defaultFields: true });

        return toolResult({
          place_query: q,
          selected_place: selectedPlace,
          observations,
        });
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
