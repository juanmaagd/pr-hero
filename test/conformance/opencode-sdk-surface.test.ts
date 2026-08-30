// The drift-kill for issue #121.
//
// `OpenCodeSdkLike` / `OpenCodeSdkClientApi` are HAND-WRITTEN narrow
// interfaces: pr-hero ships with zero required runtime dependencies, so the
// transport may never import the SDK for its values. Nothing ever compared
// those interfaces to the real module, and `transport-registry.ts` handed the
// dynamic import straight through `as unknown as OpenCodeSdkLike` — the
// strongest assertion TypeScript has, pointed at a guess. The guess was
// wrong: the SDK exports `createOpencodeClient`, never `createClient`, so
// every live OpenCode step died with "sdk.createClient is not a function"
// while 2810 offline tests stayed green, because every mock was shaped to the
// same guess.
//
// The type-level block below is the compile-time half of the fix: it asserts
// the REAL module type is assignable to the local interface, so tsc fails the
// moment the two stop matching. It lives in `test/` and not in `src/` on
// purpose — package.json `exports` points consumers at `./src/index.ts`, so a
// src-level `import type "@opencode-ai/sdk"` would break typecheck for every
// consumer that installed pr-hero without the OPTIONAL dependency. tsconfig
// includes `test/**`, so `bun run typecheck` still runs this gate.

import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  assertOpenCodeSdk,
  type OpenCodeSdkClientApi,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";

// ---------------------------------------------------------------------------
// Compile-time conformance. No runtime cost, no runtime dependency: `declare`
// and `import type` are both erased.
// ---------------------------------------------------------------------------

// Neither function is ever CALLED — the assertion is the `return`, which tsc
// checks and the runtime never reaches. Written as identity functions rather
// than casts on purpose: a cast is what shipped the defect, and there is no
// `as` anywhere below that could absorb a mismatch.

// If this stops compiling, the local factory name or its config no longer
// matches the SDK's. Do not widen the local interface to make it pass — a
// conformance check that passes by being weakened is worth nothing, and is
// exactly how the `createClient` guess shipped.
function moduleConformance(
  module: typeof import("@opencode-ai/sdk"),
): OpenCodeSdkLike {
  return module;
}

// If this stops compiling, one of session.{create,prompt,messages,status,abort},
// event.subscribe or tool.ids changed shape. The declared results must keep
// BOTH arms of the SDK's `RequestResult` union: with the default
// `ThrowOnError = false` an API error returns `{ data: undefined, error }`,
// and an interface that declares only `{ data: T }` erases that arm and turns
// a handled API error into a TypeError on `.data`.
function clientConformance(client: OpencodeClient): OpenCodeSdkClientApi {
  return client;
}

void moduleConformance;
void clientConformance;

// ---------------------------------------------------------------------------
// Runtime validation. `import type` cannot guard the dynamic import the
// registry performs, so the loaded value is validated instead of asserted.
// ---------------------------------------------------------------------------

describe("assertOpenCodeSdk", () => {
  test("accepts a module exposing the real factory", () => {
    const factory = () => ({}) as unknown as OpenCodeSdkClientApi;
    const module = { createOpencodeClient: factory };

    expect(assertOpenCodeSdk(module)).toBe(module);
  });

  test("rejects a module without the factory, naming what it looked for", () => {
    expect(() => assertOpenCodeSdk({})).toThrow(/createOpencodeClient/);
  });

  // The exact defect this file exists for: the SDK surface the transport was
  // built against. A module carrying only the guessed name must be refused,
  // not accepted and then crashed on.
  test("rejects the guessed `createClient` surface", () => {
    expect(() => assertOpenCodeSdk({ createClient: () => ({}) })).toThrow(
      /createOpencodeClient/,
    );
  });

  test("rejects a non-object", () => {
    expect(() => assertOpenCodeSdk(undefined)).toThrow(/createOpencodeClient/);
    expect(() => assertOpenCodeSdk("@opencode-ai/sdk")).toThrow(
      /createOpencodeClient/,
    );
  });
});

describe("the installed @opencode-ai/sdk", () => {
  // Belt to the type block's braces: the declaration files and the shipped
  // JavaScript are two different artifacts, and the transport calls the
  // second one.
  test("really exports createOpencodeClient and really has no createClient", async () => {
    const module = (await import("@opencode-ai/sdk")) as unknown as Record<
      string,
      unknown
    >;

    expect(typeof module.createOpencodeClient).toBe("function");
    expect(module.createClient).toBeUndefined();
    expect(() => assertOpenCodeSdk(module)).not.toThrow();
  });

  // Issue #122's half of the same drift-kill. The transport now READS the
  // provider's tool surface instead of writing its own canonical names into an
  // open map and hoping — so `tool.ids` is load-bearing, and it is served by
  // `GET /experimental/tool/ids`. An experimental-prefixed endpoint is exactly
  // the kind that gets renamed, and a rename would take the enumeration with
  // it: no enumeration means no proven denial, while production-runtime.ts
  // keeps reporting `allowMapEnforced: true` to the admission gate.
  //
  // Constructing the client is offline — the generated hey-api client dials
  // nothing until a call is made — so the unroutable baseUrl is never reached.
  test("really exposes tool.ids(), the enumeration the allow map is built from", async () => {
    const module = (await import("@opencode-ai/sdk")) as unknown as {
      createOpencodeClient: (config: { baseUrl: string }) => {
        tool?: { ids?: unknown };
      };
    };

    const client = module.createOpencodeClient({
      baseUrl: "http://127.0.0.1:1",
    });

    expect(typeof client.tool?.ids).toBe("function");
  });

  // Issue #127's half of the drift-kill. The poll observer's turn boundary is
  // `GET /session/status`, and it has to be a DIFFERENT endpoint from
  // session.messages() or §197 has two pipes onto one fact instead of two
  // observers. Losing this method would take the boundary with it and leave
  // the poll reading "last completed assistant message" again — which is step
  // 1 until step 2 exists, the whole of #127.
  test("really exposes session.status(), the poll observer's turn boundary", async () => {
    const module = (await import("@opencode-ai/sdk")) as unknown as {
      createOpencodeClient: (config: { baseUrl: string }) => {
        session?: { status?: unknown; messages?: unknown };
      };
    };

    const client = module.createOpencodeClient({
      baseUrl: "http://127.0.0.1:1",
    });

    expect(typeof client.session?.status).toBe("function");
    expect(client.session?.status).not.toBe(client.session?.messages);
  });
});
