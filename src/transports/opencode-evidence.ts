import type { DiagnosticEvidence } from "../execution/contracts";

import { redactEvidence } from "../security/evidence-redaction";

export {
  redactEvidence,
  redactEvidenceText,
} from "../security/evidence-redaction";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 10000;
// #228: a real production capture hit the 10,000-record cap at ~57.7s into a
// 242-286s attempt — the silence window that needed diagnosing happened
// AFTER the cap was already exhausted, so stopping at the cap threw away
// exactly the part that mattered. The first HEAD_MAX_RECORDS/HEAD_MAX_BYTES
// (whichever comes first) are kept PERMANENTLY — this is where
// session-identity and the prompt's http_request/response/request_body
// naturally land, since they happen at the very start of a turn. Everything
// after that is a rolling TAIL of the most recent records, which is where a
// terminal readback naturally lands, since it happens at the very end.
const HEAD_MAX_RECORDS = 1000;
const HEAD_MAX_BYTES = 1 * 1024 * 1024;
export interface OpenCodeObservation {
  seq: number;
  observedMs: number;
  kind: string;
  data: unknown;
}
interface TailEntry {
  readonly record: OpenCodeObservation;
  readonly size: number;
}
export class OpenCodeEvidenceCollector {
  private head: OpenCodeObservation[] = [];
  private headBytes = 0;
  private headClosed = false;
  private tail: TailEntry[] = [];
  private tailBytes = 0;
  private elidedCount = 0;
  private elidedBytes = 0;
  // Fixed the FIRST time anything is ever elided, and reused for every
  // subsequent marker-size estimate AND the final emitted marker — so the
  // marker's own serialized size, once it exists, never drifts between the
  // budget decisions made while collecting and what `snapshot()` actually
  // writes. Growth in `elidedCount`/`elidedBytes` (their digit width) is the
  // only thing allowed to change the marker's size across those checks.
  private elidedObservedMs?: number;
  private nextSeq = 1;
  private incomplete = false;
  private pending = 0;
  private frozen?: DiagnosticEvidence;
  private wrapperBytesCache?: number;
  constructor(
    private correlation: { sessionId: string; attempt: number },
    private maxBytes = MAX_BYTES,
  ) {}
  // `snapshot()` serializes `{"schemaVersion":1,...correlation,"records":[...]}`
  // — every record beyond the first costs one extra byte for its join comma,
  // and the object wrapper itself (schemaVersion/correlation/brackets) costs a
  // fixed amount too. `record()` used to reserve a flat 256-byte slack for
  // both, which a few thousand records blow through on commas alone (each is
  // 1 byte, but there is one per record past the first) — the final
  // `redactedJson` could then land past `maxBytes` even though every
  // individual record fit under it. Computed once here (the wrapper shape
  // never changes after construction) so `record()` can budget the exact
  // overhead instead of guessing at it.
  private wrapperBytes(): number {
    if (this.wrapperBytesCache === undefined)
      this.wrapperBytesCache = Buffer.byteLength(
        JSON.stringify({
          schemaVersion: 1,
          ...this.correlation,
          records: [],
        }),
      );
    return this.wrapperBytesCache;
  }
  private markerRecord(): OpenCodeObservation {
    return {
      seq: 0, // never collides with a real record's seq, which starts at 1
      observedMs: this.elidedObservedMs ?? 0,
      kind: "elided",
      data: { records: this.elidedCount, bytes: this.elidedBytes },
    };
  }
  private markerSize(): number {
    return Buffer.byteLength(JSON.stringify(this.markerRecord()));
  }
  // Exact accounting for the FINAL emitted sequence (head, then the marker
  // if anything was ever elided, then tail) given candidate head/tail
  // sizes — the same join-comma/wrapper formula `record()`'s overhead fix
  // established, extended to a marker that may or may not exist yet.
  private fits(
    headCount: number,
    headBytes: number,
    tailCount: number,
    tailBytes: number,
  ): boolean {
    const hasMarker = this.elidedCount > 0;
    const totalCount = headCount + (hasMarker ? 1 : 0) + tailCount;
    if (totalCount > MAX_RECORDS) return false;
    const totalBytes =
      this.wrapperBytes() +
      headBytes +
      (hasMarker ? this.markerSize() : 0) +
      tailBytes +
      Math.max(0, totalCount - 1);
    return totalBytes <= this.maxBytes;
  }
  record(kind: string, data: unknown): void {
    if (this.frozen || this.incomplete) return;
    try {
      const safe = redactEvidence(data);
      const rec: OpenCodeObservation = {
        seq: this.nextSeq,
        observedMs: performance.now(),
        kind,
        data: safe,
      };
      const size = Buffer.byteLength(JSON.stringify(rec));

      if (!this.headClosed) {
        const withinHeadBudget =
          this.head.length + 1 <= HEAD_MAX_RECORDS &&
          this.headBytes + size <= HEAD_MAX_BYTES;
        if (
          withinHeadBudget &&
          this.fits(this.head.length + 1, this.headBytes + size, 0, 0)
        ) {
          this.head.push(rec);
          this.headBytes += size;
          this.nextSeq++;
          return;
        }
        this.headClosed = true;
      }

      // Tail phase: append `rec`, evicting the oldest tail entries first if
      // needed to stay within both the record cap and `maxBytes` — the
      // moment the FIRST eviction happens, a marker starts existing, and
      // every fit check from then on (including this same loop's later
      // iterations) accounts for it.
      let candidateTailBytes = this.tailBytes + size;
      let candidateTailCount = this.tail.length + 1;
      for (;;) {
        if (
          this.fits(
            this.head.length,
            this.headBytes,
            candidateTailCount,
            candidateTailBytes,
          )
        ) {
          this.tail.push({ record: rec, size });
          this.tailBytes = candidateTailBytes;
          this.nextSeq++;
          return;
        }
        const oldest = this.tail.shift();
        if (oldest === undefined) throw new Error("capture limit");
        this.tailBytes -= oldest.size;
        if (this.elidedCount === 0) this.elidedObservedMs = performance.now();
        this.elidedCount += 1;
        this.elidedBytes += oldest.size;
        candidateTailBytes = this.tailBytes + size;
        candidateTailCount = this.tail.length + 1;
      }
    } catch {
      this.incomplete = true;
    }
  }
  private body(
    message: Request | Response,
    kind: string,
    requestId: number,
  ): void {
    this.pending++;
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        reader = message.body?.getReader();
        if (!reader) {
          this.record(kind, { requestId, body: null });
          return;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("capture read deadline")),
            100,
          );
        });
        for (;;) {
          const chunk = await Promise.race([reader.read(), deadline]);
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > this.maxBytes) throw new Error("capture body limit");
          chunks.push(chunk.value);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {}
        // Body is kept as the actual serialized object, correlated separately.
        this.record(kind, { requestId, body });
      } catch {
        this.incomplete = true;
      } finally {
        clearTimeout(timer);
        void reader?.cancel().catch(() => {});
        this.pending--;
      }
    })();
  }
  wrapFetch(inner: (request: Request) => Promise<Response>): typeof fetch {
    let requests = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request && init === undefined
          ? input
          : new Request(input, init);
      const requestId = ++requests;
      this.record("http_request", {
        requestId,
        method: request.method,
        url: request.url,
      });
      try {
        if (request.body) this.body(request.clone(), "request_body", requestId);
      } catch {
        this.incomplete = true;
      }
      try {
        const response = await inner(request);
        this.record("http_response", { requestId, status: response.status });
        if (
          !response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          try {
            this.body(response.clone(), "response_body", requestId);
          } catch {
            this.incomplete = true;
          }
        }
        return response;
      } catch (error) {
        this.record("http_error", {
          requestId,
          error: error instanceof Error ? error.message : "request failed",
        });
        throw error;
      }
    }) as typeof fetch;
  }
  snapshot(): DiagnosticEvidence {
    if (!this.frozen) {
      const records: OpenCodeObservation[] = [...this.head];
      if (this.elidedCount > 0) records.push(this.markerRecord());
      for (const entry of this.tail) records.push(entry.record);
      this.frozen = {
        schema: "pr-hero.opencode-observations.v1",
        status:
          this.incomplete || this.pending > 0 || this.elidedCount > 0
            ? "incomplete"
            : "complete",
        redactedJson: JSON.stringify({
          schemaVersion: 1,
          ...this.correlation,
          records,
        }),
      };
    }
    return this.frozen;
  }
}

interface CapturedMessage {
  info: {
    id?: string;
    sessionID?: string;
    role?: string;
    parentID?: string;
    path?: { cwd?: string };
    error?: unknown;
    finish?: string;
    time?: { completed?: number };
  };
  parts: Array<{
    id?: string;
    messageID?: string;
    sessionID?: string;
    type?: string;
    state?: { status?: string };
    text?: unknown;
    synthetic?: boolean;
    ignored?: boolean;
  }>;
}
export type EvidenceClassification =
  | "demonstrated_reconstruction_defect"
  | "persisted_final_empty"
  | "external_rejection"
  | "inconclusive";
/** Independent evidence check: raw readback plus known submitted ownership, never StepResult-derived facts. */
export function classifyObservationEvidence(
  capture: DiagnosticEvidence | undefined,
  localText: string,
): EvidenceClassification {
  if (
    capture?.status !== "complete" ||
    capture.schema !== "pr-hero.opencode-observations.v1"
  )
    return "inconclusive";
  try {
    const data = JSON.parse(capture.redactedJson);
    const records: OpenCodeObservation[] = data.records;
    if (
      !Array.isArray(records) ||
      typeof data.sessionId !== "string" ||
      !Number.isInteger(data.attempt) ||
      data.attempt < 1
    )
      return "inconclusive";
    const identities = records.find((r) => r.kind === "session_identity")
      ?.data as
      | { sessionId?: string; userMessageId?: string; cwd?: string }
      | undefined;
    const requests = records
      .filter((r) => r.kind === "http_request")
      .map((r) => r.data as { requestId: number; url: string; method: string });
    const promptIds = requests
      .filter(
        (r) =>
          r.method === "POST" &&
          /\/session\/[^/]+\/message(?:\?|$)/.test(r.url),
      )
      .map((r) => r.requestId);
    if (
      records.some(
        (r) =>
          r.kind === "http_response" &&
          promptIds.includes((r.data as { requestId: number }).requestId) &&
          (r.data as { status: number }).status >= 400,
      )
    )
      return "external_rejection";
    if (
      !identities ||
      typeof identities.sessionId !== "string" ||
      !identities.sessionId ||
      typeof identities.userMessageId !== "string" ||
      !identities.userMessageId ||
      typeof identities.cwd !== "string" ||
      !identities.cwd
    )
      return "inconclusive";
    const readback = records.filter((r) => r.kind === "readback").at(-1)
      ?.data as
      | {
          sessionId?: string;
          cwd?: string;
          coverage?: string;
          messages?: unknown[];
        }
      | undefined;
    if (
      readback?.coverage !== "complete" ||
      readback.sessionId !== identities.sessionId ||
      readback.cwd !== identities.cwd ||
      !Array.isArray(readback.messages)
    )
      return "inconclusive";
    if (
      records.some(
        (r) =>
          r.kind === "event" &&
          (r.data as { type?: string; properties?: { sessionID?: string } })
            ?.type === "session.error" &&
          (r.data as { properties?: { sessionID?: string } }).properties
            ?.sessionID === identities.sessionId,
      )
    )
      return "inconclusive";
    const messageIds = new Set<string>();
    const partIds = new Set<string>();
    const assistants: CapturedMessage[] = [];
    for (const item of readback.messages) {
      if (!item || typeof item !== "object") return "inconclusive";
      const row = item as CapturedMessage;
      if (
        typeof row.info?.id !== "string" ||
        !row.info.id ||
        messageIds.has(row.info.id) ||
        row.info.sessionID !== identities.sessionId
      )
        return "inconclusive";
      messageIds.add(row.info.id);
      if (row.info.role !== "user" && row.info.role !== "assistant")
        return "inconclusive";
      if (row.info.role !== "assistant") continue;
      if (
        row.info.parentID !== identities.userMessageId ||
        row.info.path?.cwd !== identities.cwd ||
        !Array.isArray(row.parts) ||
        row.info.error
      )
        return "inconclusive";
      for (const part of row.parts) {
        if (
          typeof part.id !== "string" ||
          !part.id ||
          partIds.has(part.id) ||
          (part.type === "text" && typeof part.text !== "string") ||
          part.messageID !== row.info.id ||
          part.sessionID !== identities.sessionId ||
          (part.type === "tool" &&
            !["completed", "error"].includes(part.state?.status ?? ""))
        )
          return "inconclusive";
        partIds.add(part.id);
      }
      assistants.push(row);
    }
    const final = assistants.at(-1);
    if (
      final?.info.finish !== "stop" ||
      !Number.isFinite(final.info.time?.completed)
    )
      return "inconclusive";
    const text = final.parts
      .filter(
        (p) => p.type === "text" && p.synthetic !== true && p.ignored !== true,
      )
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    if (!text.trim()) return "persisted_final_empty";
    if (text !== String(redactEvidence(localText)))
      return "demonstrated_reconstruction_defect";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

/** Qualification additionally requires actual wire capture and the arbiter's same final identity. */
export function hasCapturedTerminal(
  capture: DiagnosticEvidence,
  eventId: string,
  observedAt: string,
): boolean {
  const classification = classifyObservationEvidence(capture, "");
  if (
    classification !== "persisted_final_empty" &&
    classification !== "demonstrated_reconstruction_defect"
  )
    return false;
  try {
    const value = JSON.parse(capture.redactedJson) as {
      records: OpenCodeObservation[];
    };
    const identity = value.records.find((r) => r.kind === "session_identity")
      ?.data as { sessionId: string; userMessageId: string };
    const readback = value.records.filter((r) => r.kind === "readback").at(-1)
      ?.data as { messages: CapturedMessage[] };
    const final = readback.messages
      .filter((m) => m.info.role === "assistant")
      .at(-1);
    if (
      final?.info.id !== eventId ||
      new Date(final.info.time?.completed ?? NaN).toISOString() !== observedAt
    )
      return false;
    const request = value.records.find((r) => {
      if (r.kind !== "http_request") return false;
      const data = r.data as { url: string; method: string };
      return (
        data.method === "POST" &&
        new URL(data.url).pathname === `/session/${identity.sessionId}/message`
      );
    })?.data as { requestId: number } | undefined;
    return (
      !!request &&
      value.records.some(
        (r) =>
          r.kind === "http_response" &&
          (r.data as { requestId: number }).requestId === request.requestId,
      ) &&
      value.records.some(
        (r) =>
          r.kind === "request_body" &&
          (r.data as { requestId: number; body?: { messageID?: string } })
            .requestId === request.requestId &&
          (r.data as { body?: { messageID?: string } }).body?.messageID ===
            identity.userMessageId,
      ) &&
      value.records.some((r) => r.kind === "subscription_ready")
    );
  } catch {
    return false;
  }
}
