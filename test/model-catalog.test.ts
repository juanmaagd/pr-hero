import { describe, expect, test } from "bun:test";
import {
  aliasCanonical,
  aliasModelFamily,
  aliasModelSnapshot,
  allModelAliases,
  lookupAlias,
  MODEL_CATALOG,
  providerCatalog,
} from "../src/model-catalog";

describe("model catalog", () => {
  test("anthropic aliases match the engine's logical alias set", () => {
    expect([...allModelAliases()].sort()).toEqual(["haiku", "opus", "sonnet"]);
  });

  test("lookupAlias resolves canonical identities from config/models/*.json", () => {
    const sonnet = lookupAlias("sonnet");
    expect(sonnet.provider).toBe("anthropic");
    expect(sonnet.canonical).toBe("anthropic/claude-sonnet-5");
    expect(sonnet.modelFamily).toBe("claude-sonnet-5");
    expect(sonnet.modelSnapshot).toBe("claude-sonnet-5");
    expect(sonnet.defaultBackend).toBe("claude-code");

    expect(aliasCanonical("opus")).toBe("anthropic/claude-opus-5");
    expect(aliasModelFamily("haiku")).toBe("claude-haiku-4-5");
    expect(aliasModelSnapshot("haiku")).toBe("claude-haiku-4-5");
  });

  test("provider catalog is loaded from JSON and frozen at import", () => {
    const anthropic = providerCatalog("anthropic");
    expect(anthropic.provider).toBe("anthropic");
    expect(anthropic.aliases.sonnet.modelFamily).toBe("claude-sonnet-5");
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true);
  });
});
