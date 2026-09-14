import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { redactEvidence } from "../security/evidence-redaction";
import { attemptEvidencePath, type StepSpec } from "../step-runner";
import { writeJsonAtomically } from "./atomic-write";
import type { TransportOutcome, TransportRequest } from "./contracts";
import type { SettlementReceipt } from "./settlement";

export const evidenceSha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export interface ExecutionAttemptEvidence {
  schemaVersion: 1;
  sessionId: string;
  attempt: number;
  stepName: string;
  identity: {
    route: TransportRequest["route"];
    executionModel: string;
    systemPromptSha256: string;
    userPromptSha256: string;
    canonicalCwdSha256: string;
    toolsConfigSha256?: string;
    executableSha256?: string;
  };
  outcome?: Pick<
    TransportOutcome,
    "completion" | "protocolIntegrity" | "terminalProof" | "usage"
  >;
  settlement: SettlementReceipt;
  delivered: boolean;
  outputSha256?: string;
  outputPath?: string;
  requestPlan?: { relativePath: string; sha256: string };
  capture?: {
    schema: string;
    status: "complete" | "incomplete" | "unavailable";
    sha256: string;
    relativePath: string;
  };
}
/** Diagnostic control-plane persistence. Failure never changes execution/billing. */
export async function persistAttemptEvidence(
  step: StepSpec,
  request: TransportRequest,
  execution: {
    outcome?: TransportOutcome;
    receipt: SettlementReceipt;
    delivery?: { delivered: boolean };
    frozenIdentity?: {
      toolsConfigSha256?: string;
      executableSha256?: string;
      requestPlan?: { relativePath: string; sha256: string };
    };
  },
): Promise<void> {
  const file = attemptEvidencePath(step.outPath, step.name, request.attempt);
  const outcome = execution.outcome;
  const evidence: ExecutionAttemptEvidence = {
    schemaVersion: 1,
    sessionId: request.sessionId,
    attempt: request.attempt,
    stepName: step.name,
    identity: {
      route: request.route,
      executionModel: request.executionModel,
      systemPromptSha256: request.systemPromptSha256,
      userPromptSha256: evidenceSha256(request.userPrompt),
      canonicalCwdSha256: evidenceSha256(request.cwd),
    },
    settlement: execution.receipt,
    delivered: execution.delivery?.delivered === true,
  };
  if (outcome)
    evidence.outcome = {
      completion: outcome.completion,
      protocolIntegrity: outcome.protocolIntegrity,
      ...(outcome.terminalProof
        ? { terminalProof: outcome.terminalProof }
        : {}),
      usage: outcome.usage,
    };
  if (execution.frozenIdentity) {
    const { requestPlan, ...identity } = execution.frozenIdentity;
    Object.assign(evidence.identity, identity);
    if (requestPlan) evidence.requestPlan = requestPlan;
  }
  if (evidence.delivered) {
    evidence.outputSha256 = evidenceSha256(await readFile(step.outPath));
    evidence.outputPath = path.basename(step.outPath);
  }
  const capture = outcome?.diagnosticEvidence;
  if (
    capture &&
    Buffer.byteLength(capture.redactedJson) <= 4 * 1024 * 1024 &&
    /^pr-hero\.[a-z0-9.-]+$/.test(capture.schema)
  ) {
    try {
      const safe = redactEvidence(JSON.parse(capture.redactedJson));
      const captureFile = file.replace(/\.json$/, ".capture.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeJsonAtomically(captureFile, safe);
      const bytes = await readFile(captureFile);
      evidence.capture = {
        schema: capture.schema,
        status: capture.status,
        sha256: evidenceSha256(bytes),
        relativePath: path.basename(captureFile),
      };
    } catch {
      /* Qualification requires an actual usable capture. */
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomically(file, redactEvidence(evidence));
}
/** Untrusted artifact references cannot read outside their owned run root. */
export async function readEvidenceFile(
  root: string,
  relative: string,
  maxBytes = 5 * 1024 * 1024,
  parseJson = true,
): Promise<{ bytes: Uint8Array; value: unknown }> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error("unsafe evidence path");
  const base = await realpath(root);
  const file = await realpath(path.resolve(root, relative));
  if (!file.startsWith(`${base}${path.sep}`))
    throw new Error("evidence escapes run root");
  const handle = await import("node:fs/promises").then((fs) =>
    fs.open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    ),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("evidence is not a regular file");
    if (metadata.size > maxBytes) throw new Error("evidence exceeds bound");
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error("evidence exceeds bound");
    const bounded = bytes.subarray(0, bytesRead);
    return {
      bytes: bounded,
      value: parseJson ? JSON.parse(bounded.toString("utf8")) : undefined,
    };
  } finally {
    await handle.close();
  }
}

export async function freezeAttemptEvidenceIdentity(
  request: TransportRequest,
  step: StepSpec,
): Promise<{
  toolsConfigSha256?: string;
  executableSha256?: string;
  requestPlan?: { relativePath: string; sha256: string };
}> {
  const frozen: {
    toolsConfigSha256?: string;
    executableSha256?: string;
    requestPlan?: { relativePath: string; sha256: string };
  } = {};
  try {
    frozen.toolsConfigSha256 = evidenceSha256(
      JSON.stringify({
        tools: request.tools,
        mcp: request.mcpConfigPath
          ? await readFile(request.mcpConfigPath, {
              encoding: "utf8",
              signal: AbortSignal.timeout(100),
            })
          : null,
      }),
    );
  } catch {}
  try {
    frozen.executableSha256 = evidenceSha256(
      await readFile(request.isolation.verifiedBinaryPath, {
        signal: AbortSignal.timeout(100),
      }),
    );
  } catch {}
  const file = attemptEvidencePath(
    step.outPath,
    step.name,
    request.attempt,
  ).replace(/\.json$/, ".request.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const plan = {
          schemaVersion: 1,
          sessionId: request.sessionId,
          attempt: request.attempt,
          stepName: step.name,
          route: request.route,
          systemPromptSha256: request.systemPromptSha256,
          userPromptSha256: evidenceSha256(request.userPrompt),
          systemPromptPath: path.relative(
            path.dirname(file),
            step.systemPromptPath,
          ),
          ...frozen,
        };
        await mkdir(path.dirname(file), { recursive: true });
        await writeJsonAtomically(file, plan);
        frozen.requestPlan = {
          relativePath: path.basename(file),
          sha256: evidenceSha256(await readFile(file)),
        };
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(100, Math.max(1, step.timeoutMs)));
      }),
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
  }
  return { ...frozen };
}
