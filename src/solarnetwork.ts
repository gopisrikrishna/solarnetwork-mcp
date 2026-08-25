import { createHmac, createHash } from "node:crypto";

/**
 * Minimal client for SolarNetwork's SolarQuery API.
 *
 * SolarQuery exposes two parallel path prefixes:
 *   /pub/...  anonymous access to publicly-shared nodes
 *   /sec/...  token-authenticated access to your own nodes
 *
 * We prefer /sec when a token pair is configured and fall back to /pub
 * otherwise, so the same tool surface works with or without credentials.
 */

const DEFAULT_HOST = "data.solarnetwork.net";
const API_PATH = "/solarquery/api/v1";

/**
 * Aggregation periods SolarQuery accepts. Verified against the live API —
 * note `Minute` is explicitly rejected even though the sequence suggests it.
 */
export const AGGREGATIONS = [
  "None",
  "FiveMinute",
  "TenMinute",
  "FifteenMinute",
  "ThirtyMinute",
  "Hour",
  "HourOfDay",
  "SeasonalHourOfDay",
  "Day",
  "DayOfWeek",
  "SeasonalDayOfWeek",
  "DayOfYear",
  "Week",
  "Month",
  "Year",
  "RunningTotal",
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** Reading types for the /datum/reading endpoint. */
export const READING_TYPES = [
  "Difference",
  "DifferenceWithin",
  "NearestDifference",
  "CalculatedAt",
  "CalculatedAtDifference",
] as const;
export type ReadingType = (typeof READING_TYPES)[number];

export interface SolarNetworkConfig {
  host?: string;
  tokenId?: string;
  tokenSecret?: string;
}

export interface PagedResult<T> {
  results: T[];
  totalResults: number;
  startingOffset: number;
  returnedResultCount: number;
}

/** A datum record. Property names vary by source, hence the index signature. */
export interface Datum {
  created: string;
  nodeId: number;
  sourceId: string;
  localDate?: string;
  localTime?: string;
  [property: string]: unknown;
}

export interface DataRange {
  startDate: string;
  endDate: string;
  timeZone: string;
  dayCount: number;
  monthCount: number;
  yearCount: number;
}

/**
 * A meter reading over a range. Accumulating properties appear three times:
 * `x_start`, `x_end`, and `x` for the difference between them.
 */
export interface Reading {
  nodeId: number;
  sourceId: string;
  localDate?: string;
  localEndDate?: string;
  timeZone?: string;
  [property: string]: unknown;
}

export class SolarNetworkError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SolarNetworkError";
  }
}

export class SolarNetworkClient {
  private readonly host: string;
  private readonly tokenId?: string;
  private readonly tokenSecret?: string;

  constructor(config: SolarNetworkConfig = {}) {
    this.host = config.host ?? DEFAULT_HOST;
    this.tokenId = config.tokenId;
    this.tokenSecret = config.tokenSecret;
  }

  /** True when a token pair is present, so /sec endpoints are reachable. */
  get authenticated(): boolean {
    return Boolean(this.tokenId && this.tokenSecret);
  }

  get mode(): "authenticated" | "public" {
    return this.authenticated ? "authenticated" : "public";
  }

  // ---------------------------------------------------------------- endpoints

  /** Source IDs reporting on the given node. */
  async listSources(nodeId: number): Promise<string[]> {
    return this.request<string[]>("/range/sources", { nodeId });
  }

  /** The overall window for which a node has data, plus its timezone. */
  async dataRange(nodeId: number): Promise<DataRange | null> {
    const data = await this.request<DataRange | undefined>("/range/interval", {
      nodeId,
    });
    // SolarQuery answers `{"success":true}` with no `data` key for nodes that
    // exist but have never reported, so absence here is a real "no data" signal.
    return data ?? null;
  }

  /** Latest datum per source for a node. */
  async mostRecent(nodeId: number, sourceIds?: string[]): Promise<Datum[]> {
    const page = await this.request<PagedResult<Datum>>("/datum/mostRecent", {
      nodeId,
      sourceIds: sourceIds?.length ? sourceIds.join(",") : undefined,
    });
    return page.results ?? [];
  }

  /**
   * Datum over a time range, optionally rolled up by an aggregation period.
   * Accepts multiple nodes so a whole fleet can be fetched in one round trip.
   */
  async listDatum(params: {
    nodeIds: number[];
    sourceIds?: string[];
    startDate: string;
    endDate: string;
    aggregation?: Aggregation;
    partialAggregation?: Aggregation;
    max?: number;
  }): Promise<PagedResult<Datum>> {
    const query = {
      nodeIds: params.nodeIds.join(","),
      sourceIds: params.sourceIds?.length
        ? params.sourceIds.join(",")
        : undefined,
      startDate: params.startDate,
      endDate: params.endDate,
      aggregation: params.aggregation,
      partialAggregation: params.partialAggregation,
      max: params.max,
    };

    const first = await this.request<PagedResult<Datum>>("/datum/list", query);
    const results = first.results ?? [];

    // SolarQuery caps a page at 1000 rows and says so only in `totalResults`.
    // Without following the offsets the caller gets a silently short answer,
    // and short answers here are worse than errors: a source whose rows fell
    // off the end looks like a device that stopped reporting, which is exactly
    // the fault these tools exist to detect. Explicit `max` is treated as the
    // caller asking for a single capped page, so it is left alone.
    if (params.max === undefined) {
      const total = first.totalResults ?? results.length;
      let guard = 0;
      while (results.length < total && guard++ < 50) {
        const next = await this.request<PagedResult<Datum>>("/datum/list", {
          ...query,
          offset: results.length,
        });
        const rows = next.results ?? [];
        if (rows.length === 0) break;
        results.push(...rows);
      }
    }

    return { ...first, results, returnedResultCount: results.length };
  }

  /**
   * Meter readings over a range, i.e. true accumulated energy rather than
   * averaged power. SolarQuery time-projects accumulating properties across
   * bucket boundaries, which averaging `watts` cannot reproduce.
   */
  async reading(params: {
    nodeIds: number[];
    sourceIds?: string[];
    localStartDate: string;
    localEndDate: string;
    readingType?: ReadingType;
    aggregation?: Aggregation;
  }): Promise<PagedResult<Reading>> {
    const page = await this.request<PagedResult<Reading>>("/datum/reading", {
      nodeIds: params.nodeIds.join(","),
      sourceIds: params.sourceIds?.length
        ? params.sourceIds.join(",")
        : undefined,
      localStartDate: params.localStartDate,
      localEndDate: params.localEndDate,
      readingType: params.readingType ?? "Difference",
      aggregation: params.aggregation,
    });
    return { ...page, results: page.results ?? [] };
  }

  /** Node/source pairs that have datum metadata registered. */
  async sourceMetadata(nodeId: number): Promise<Array<{ nodeId: number; sourceId: string }>> {
    const page = await this.request<PagedResult<{ nodeId: number; sourceId: string }>>(
      `/datum/meta/${nodeId}`,
      {},
    );
    return page.results ?? [];
  }

  // ----------------------------------------------------------------- internals

  private async request<T>(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<T> {
    const prefix = this.authenticated ? "/sec" : "/pub";
    const search = new URLSearchParams();
    // Sort keys: the signing scheme hashes the canonical (sorted) query string,
    // so the signed bytes and the sent bytes must be built the same way.
    for (const key of Object.keys(query).sort()) {
      const value = query[key];
      if (value !== undefined && value !== null && value !== "") {
        search.set(key, String(value));
      }
    }

    const canonicalPath = `${API_PATH}${prefix}${path}`;
    const url = `https://${this.host}${canonicalPath}?${search.toString()}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.authenticated) {
      Object.assign(headers, this.signRequest(canonicalPath, search));
    }

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (cause) {
      throw new SolarNetworkError(
        `Could not reach SolarNetwork at ${this.host}: ${(cause as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new SolarNetworkError(
        `SolarNetwork returned HTTP ${response.status} for ${path}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      success: boolean;
      message?: string;
      code?: string;
      data?: T;
    };

    if (!body.success) {
      throw new SolarNetworkError(
        body.message ?? body.code ?? `Request to ${path} was rejected`,
      );
    }
    return body.data as T;
  }

  /**
   * SolarNetwork's V2 token auth: an AWS-SigV4-style scheme where the client
   * builds a canonical request, hashes it, signs the hash with a date-scoped
   * derived key, and sends the result in an Authorization header.
   */
  private signRequest(
    canonicalPath: string,
    search: URLSearchParams,
  ): Record<string, string> {
    const now = new Date();
    const isoDate = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const shortDate = isoDate.slice(0, 10).replace(/-/g, "");

    const emptyBodyHash = createHash("sha256").update("").digest("hex");

    const canonicalRequest = [
      "GET",
      canonicalPath,
      search.toString(),
      `host:${this.host}`,
      `x-sn-date:${now.toUTCString()}`,
      "",
      "host;x-sn-date",
      emptyBodyHash,
    ].join("\n");

    const signingData = [
      "SNWS2-HMAC-SHA256",
      isoDate,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const signingKey = createHmac("sha256", `SNWS2${this.tokenSecret}`)
      .update(shortDate)
      .digest();
    const signature = createHmac("sha256", signingKey)
      .update(signingData)
      .digest("hex");

    return {
      "X-SN-Date": now.toUTCString(),
      Authorization:
        `SNWS2 Credential=${this.tokenId},` +
        `SignedHeaders=host;x-sn-date,Signature=${signature}`,
    };
  }
}
