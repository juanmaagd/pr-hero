// The engine's own identity -- name, version, and the commit it was built from.
//
// This lives in git/ rather than beside deriveEngineIdentity in assets.ts, and the
// reason is a cycle. It was first moved into assets.ts, which then had to import
// git(); but review/preflight.ts already imports assets.ts, and git/git.ts imports
// review/preflight.ts, so the move closed review/preflight -> assets -> git ->
// review/preflight. A file-level cycle detector caught it: value-import cycles
// went from 6 to 8. The pure half, deriveEngineIdentity, stays in assets.ts where
// it belongs; only this impure wrapper -- the part that actually runs
// `git rev-parse` -- moves out, and nothing on that cycle imports this module.

import {
  deriveEngineIdentity,
  type EngineAssets,
  engineCheckoutRoot,
  resolveEngineAssets,
} from "../assets";
import { git } from "./git";

// The version comes from resolveEngineAssets(), never from a package.json
// read of its own. A compiled binary's `import.meta.dir` is /$bunfs/root and
// package.json is NOT among the embedded assets, so the old read rejected with
// `ENOENT: /$bunfs/package.json` inside a try/finally that had no catch —
// every `pr-hero upgrade` on a shipped binary died there. assets.version
// already answers the same question correctly in all three modes (the baked
// `__PRHERO_VERSION__` define when compiled, the guarded package.json
// otherwise), so a second source could only ever be the wrong one.
//
// The name is left to deriveEngineIdentity's documented "pr-hero" fallback:
// package.json's `name` IS "pr-hero", and a build cannot rename itself.
//
// `assets` is injectable because detectAssetMode() reads `import.meta.dir`,
// which under `bun test` always reports "dev" — without the seam the compiled
// branch below is unreachable from the offline suite, which is precisely how
// the ENOENT above survived it.
export async function engineIdentity(assets?: EngineAssets): Promise<{
  name: string;
  version: string;
  revision?: string;
}> {
  const resolved = assets ?? resolveEngineAssets();
  if (resolved.mode === "compiled") {
    // No spawn at all, rather than one that is guaranteed to fail: a compiled
    // binary carries no checkout, so `git rev-parse` in its virtual root can
    // only ever exit non-zero. deriveEngineIdentity already omits the field
    // for a failed lookup, so the artifact is identical either way — this
    // just declines to pay for a subprocess on every run to learn something
    // already known, and says so instead of pretending it tried.
    return deriveEngineIdentity(
      { version: resolved.version },
      { ok: false, stdout: "" },
    );
  }
  // `import.meta.dir` and not cwd: the revision that matters is the ENGINE's,
  // and in PR mode the process is routinely pointed at a worktree of somebody
  // else's repository. Reading that repo's HEAD here would stamp a review with
  // the reviewed project's commit and quietly make the field a lie.
  const revision = await git(engineCheckoutRoot(), [
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  return deriveEngineIdentity({ version: resolved.version }, revision);
}
