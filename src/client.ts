// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// client module: typed RPC client over Unix domain socket or local HTTP.
//
// Invariant: Callers do not open SQLite directly. All store interactions
// go through this client.

import type { FindingsDocument } from "./findings";
import type { StoredComparison } from "./ledger";
import type {
  FindingDetail,
  HealthResponse,
  ListRunsQuery,
  ListRunsResponse,
  SaveRunRequestBody,
  SaveRunResponse,
  SearchFindingsResponse,
  SearchQueryParams,
  UsageQueryParams,
  UsageResponse,
} from "./server-preflight";
import type { CanonicalRunRow, ProjectedCompleteRun } from "./store-preflight";

export class StoreClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`Store client error (${statusCode}): ${message}`);
    this.name = "StoreClientError";
  }
}

export interface StoreClientOptions {
  socketPath?: string;
  baseUrl?: string;
}

export class ProductStoreClient {
  private readonly socketPath?: string;
  private readonly baseUrl: string;

  constructor(options: StoreClientOptions) {
    this.socketPath = options.socketPath;
    this.baseUrl = options.baseUrl ?? "http://localhost";
  }

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${pathname}`;
    const options: RequestInit & { unix?: string } = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      ...(this.socketPath ? { unix: this.socketPath } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let res: Response;
    try {
      res = await fetch(url, options as RequestInit);
    } catch (err) {
      throw new StoreClientError(
        0,
        `Failed to reach store server: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      let errorMsg = res.statusText;
      try {
        const errorJson = (await res.json()) as { error?: string };
        if (errorJson?.error) {
          errorMsg = errorJson.error;
        }
      } catch {}
      throw new StoreClientError(res.status, errorMsg);
    }

    return (await res.json()) as T;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  async saveRun(projected: ProjectedCompleteRun): Promise<SaveRunResponse> {
    const body: SaveRunRequestBody = { projected };
    return this.request<SaveRunResponse>("POST", "/v1/runs", body);
  }

  async listRuns(query?: ListRunsQuery): Promise<CanonicalRunRow[]> {
    const params = new URLSearchParams();
    if (query?.repo_id) params.set("repo_id", query.repo_id);
    if (query?.pr !== undefined) params.set("pr", String(query.pr));
    if (query?.limit !== undefined) params.set("limit", String(query.limit));

    const qs = params.toString();
    const path = `/v1/runs${qs ? `?${qs}` : ""}`;
    const res = await this.request<ListRunsResponse>("GET", path);
    return res.runs;
  }

  async getRun(id: number): Promise<CanonicalRunRow | null> {
    try {
      const res = await this.request<{ run: CanonicalRunRow }>(
        "GET",
        `/v1/runs/${id}`,
      );
      return res.run;
    } catch (err) {
      if (err instanceof StoreClientError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getFindingsDocument(id: number): Promise<FindingsDocument | null> {
    try {
      return await this.request<FindingsDocument>(
        "GET",
        `/v1/runs/${id}/findings-document`,
      );
    } catch (err) {
      if (err instanceof StoreClientError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getComparison(id: number): Promise<StoredComparison | null> {
    try {
      const res = await this.request<{ comparison: StoredComparison | null }>(
        "GET",
        `/v1/runs/${id}/comparison`,
      );
      return res.comparison;
    } catch (err) {
      if (err instanceof StoreClientError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getUsage(query?: UsageQueryParams): Promise<UsageResponse> {
    const params = new URLSearchParams();
    if (query?.all) params.set("all", "true");
    if (query?.repo_id) params.set("repo_id", query.repo_id);

    const qs = params.toString();
    const path = `/v1/usage${qs ? `?${qs}` : ""}`;
    return this.request<UsageResponse>("GET", path);
  }

  async searchFindings(query?: SearchQueryParams): Promise<FindingDetail[]> {
    const params = new URLSearchParams();
    if (query?.repo_id) params.set("repo_id", query.repo_id);
    if (query?.run_id !== undefined) params.set("run_id", String(query.run_id));
    if (query?.tier) params.set("tier", query.tier);
    if (query?.path) params.set("path", query.path);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));

    const qs = params.toString();
    const path = `/v1/findings${qs ? `?${qs}` : ""}`;
    const res = await this.request<SearchFindingsResponse>("GET", path);
    return res.findings;
  }
}
