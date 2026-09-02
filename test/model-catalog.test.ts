import { describe, expect, test } from "bun:test";
import {
  aliasCanonical,
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
    expect(sonnet.canonical).toBe("anthropic/sonnet");
    expect(sonnet.defaultBackend).toBe("claude-code");

    expect(aliasCanonical("opus")).toBe("anthropic/opus");
    expect(aliasCanonical("haiku")).toBe("anthropic/haiku");
  });

  test("provider catalog is loaded from JSON and frozen at import", () => {
    const anthropic = providerCatalog("anthropic");
    expect(anthropic.provider).toBe("anthropic");
    expect(anthropic.aliases).toEqual(["sonnet", "opus", "haiku"]);
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true);
  });
});
