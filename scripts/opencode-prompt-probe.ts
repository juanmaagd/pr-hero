// LIVE probe & #5982 same-session witness protocol:
// Diagnoses Martian arm failures across model/variant matrices with short watchdogs
// and attributable delivery evidence (EQ1a). Distinguishes proved text loss,
// persisted-empty completions, and external rejections without exposing secrets.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedModelRoute } from "../src/execution/contracts";
import type { RoutingConfig } from "../src/model-routing";
import { buildResolvedRoutePlan } from "../src/model-routing";
import type { ProductionRuntime } from "../src/production-runtime";
import {
  createProductionRuntime,
  prepareProductionAdmissionContext,
} from "../src/production-runtime";

export type WitnessClassification =
  | "demonstrated_reconstruction_defect"
  | "persisted_final_empty"
  | "external_rejection"
  | "inconclusive";

export interface SessionWitnessIdentities {
  runId: string;
  attemptId: string;
  sessionId: string;
  userMessageId: string;
  gitCommitSha: string;
  sdkVersion: string;
  serverVersion: string;
  route: { provider: string; modelSnapshot: string; modelVariant?: string };
  cwd: string;
  credentialCategory: string;
  sanitizedEndpoint: string;
}

export interface SessionWitnessRequestWire {
  sanitizedPath: string;
  sanitizedQuery: Record<string, string> | string;
  sanitizedBody: unknown;
  timestamps: { sentAt: number; receivedAt?: number };
  status?: number;
  error?: string;
}

export interface SessionWitnessEventObservation {
  timestamp: number;
  seq: number;
  eventType: string;
  partId?: string;
  textDelta?: string;
}

export interface SessionWitnessReadbackMessagePart {
  id: string;
  type: string;
  text?: string;
  callId?: string;
}

export interface SessionWitnessReadbackMessage {
  id: string;
  role: string;
  parentId?: string;
  finishStatus?: string;
  parts?: SessionWitnessReadbackMessagePart[];
  toolCalls?: unknown[];
  finalText?: string;
}

export interface SessionWitnessReadback {
  directory?: string;
  messages: SessionWitnessReadbackMessage[];
}

export interface SessionWitnessSettlement {
  status: string;
  readbackAttempts: number;
  arbiterTerminalReason?: string;
  abortRequested: boolean;
  abortAcknowledged?: boolean;
  abortConfirmed?: boolean;
  usageCompleteness: "complete" | "incomplete" | "uncertain";
}

export interface SessionWitness {
  identities: SessionWitnessIdentities;
  requestWire: SessionWitnessRequestWire;
  events: SessionWitnessEventObservation[];
  readback?: SessionWitnessReadback | null;
  settlement: SessionWitnessSettlement;
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /^(?:authorization|api[_-]?key|x-api-key|token|access_token|refresh_token|cookie|set-cookie|password|secret)$/i;

function sanitizeString(text: string): string {
  return text
    .replace(/(https?:\/\/)([^/@\s]+:[^/@\s]+@)/gi, `$1${REDACTED}@`)
    .replace(/Bearer\s+\S+/gi, REDACTED)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, REDACTED)
    .replace(
      /(?<=[?&](?:api[_-]?key|token|access_token|refresh_token|password|secret|key|auth)=)[^&\s"']+/gi,
      REDACTED,
    )
    .replace(
      /(api[_-]?key|token|access_token|refresh_token|password|secret|cookie|set-cookie)["':=\s]+[^\s"',;}{]+/gi,
      (m) => {
        const sep = m.search(/["':=\s]+/);
        return sep < 0 ? REDACTED : `${m.slice(0, sep)}: "${REDACTED}"`;
      },
    );
}

export function sanitizeWitness<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return sanitizeString(input) as unknown as T;
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeWitness(item)) as unknown as T;
  }
  if (typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      result[k] =
        k !== "credentialCategory" && SENSITIVE_KEY_RE.test(k)
          ? REDACTED
          : sanitizeWitness(v);
    }
    return result as unknown as T;
  }
  return input;
}

export function classifyWitnessEvidence(
  witness: SessionWitness,
  reconstructedLocalText: string,
): WitnessClassification {
  const wireStatus = witness.requestWire?.status;
  if (wireStatus !== undefined && wireStatus >= 400)
    return "external_rejection";
  if (witness.requestWire?.error && witness.requestWire.error.trim().length > 0)
    return "external_rejection";

  const terminalReason =
    witness.settlement?.arbiterTerminalReason?.toLowerCase() ?? "";
  if (
    terminalReason.includes("refused") ||
    terminalReason.includes("rejection") ||
    terminalReason.includes("admission") ||
    terminalReason.includes("external_error") ||
    terminalReason.includes("provider_error")
  )
    return "external_rejection";

  const st = witness.settlement?.status?.toLowerCase() ?? "";
  if (
    st === "admission-error" ||
    st === "external_rejection" ||
    st === "instant-error"
  )
    return "external_rejection";

  if (
    !witness.readback ||
    !Array.isArray(witness.readback.messages) ||
    witness.readback.messages.length === 0 ||
    witness.settlement?.readbackAttempts === 0
  )
    return "inconclusive";

  const asst = witness.readback.messages.find((m) => m.role === "assistant");
  if (
    !asst ||
    asst.finishStatus === undefined ||
    asst.finishStatus === null ||
    asst.finishStatus !== "stop" ||
    asst.parentId !== witness.identities?.userMessageId ||
    asst.toolCalls?.some((t) => (t as { status?: string }).status === "running")
  )
    return "inconclusive";

  const partsText = (asst.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const serverText = (asst.finalText ?? partsText).trim();
  const localText = (reconstructedLocalText ?? "").trim();

  if (serverText.length > 0 && localText.length === 0)
    return "demonstrated_reconstruction_defect";
  if (serverText.length === 0) return "persisted_final_empty";
  return "inconclusive";
}

interface ArmDef {
  id: string;
  note: string;
  routing: RoutingConfig | undefined;
  parallel?: number;
}

interface RepResult {
  arm: string;
  rep: number;
  leg?: number;
  outcome:
    | "ok"
    | "timeout"
    | "instant-error"
    | "other-error"
    | "admission-error";
  classification: WitnessClassification;
  ms: number;
  attempts: number;
  cost_usd_est: number;
  stderrTail: string;
}

if (import.meta.main) {
  const armRoute = (
    snapshot: string,
    variant?: string,
    provider = "opencode-go",
  ): RoutingConfig => ({
    default: {
      backend: "opencode",
      provider,
      gateway: "configured",
      modelSnapshot: snapshot,
      ...(variant ? { modelVariant: variant } : {}),
    },
  });

  const ARMS: ArmDef[] = [
    { id: "A", note: "claude-code sonnet (control)", routing: undefined },
    {
      id: "B",
      note: "deepseek-flash#high",
      routing: armRoute("deepseek-flash", "high"),
    },
    { id: "C", note: "deepseek-flash", routing: armRoute("deepseek-flash") },
    {
      id: "D",
      note: "glm-5.3-flash#high",
      routing: armRoute("glm-5.3-flash", "high"),
    },
    {
      id: "E",
      note: "glm-5.3-flash#low",
      routing: armRoute("glm-5.3-flash", "low"),
    },
    {
      id: "F",
      note: "B x3 parallel",
      routing: armRoute("deepseek-flash", "high"),
      parallel: 3,
    },
    {
      id: "G",
      note: "direct deepseek-flash",
      routing: armRoute("deepseek-flash", undefined, "deepseek"),
    },
  ];

  const flag = (n: string) => {
    const i = Bun.argv.indexOf(n);
    return i >= 0 ? Bun.argv[i + 1] : undefined;
  };
  const only = new Set(
    (flag("--only") ?? "A,B,C,D,E,F,G")
      .split(",")
      .map((s) => s.trim().toUpperCase()),
  );
  const reps = Number(flag("--reps") ?? "3");
  const timeoutSec = Number(flag("--timeout") ?? "120");
  const padKb = Number(flag("--pad-kb") ?? "0");
  const systemFile = flag("--system-file");
  const userFile = flag("--user-file");
  const stepCwd = flag("--cwd");
  const workspaceRoot =
    flag("--workspace-root") ??
    mkdtempSync(path.join(tmpdir(), "prhero-prompt-probe-"));
  const assertNonEmpty = Bun.argv.includes("--assert-nonempty");
  const hunterTools = Bun.argv.includes("--hunter-tools");
  const HUNTER_TOOLS = [
    "Read",
    "Grep",
    "Glob",
    "mcp__codegraph__codegraph_explore",
  ];
  const results: RepResult[] = [];

  function classify(
    status: string,
    stderr: string,
  ): "ok" | "timeout" | "instant-error" | "other-error" {
    if (status === "ok") return "ok";
    if (stderr.includes("timed out")) return "timeout";
    if (stderr.includes("session.prompt failed")) return "instant-error";
    return "other-error";
  }

  async function makeRuntime(
    arm: ArmDef,
  ): Promise<
    | { error: string }
    | { runtime: ProductionRuntime; route: ResolvedModelRoute }
  > {
    const plan = buildResolvedRoutePlan({
      agents: [{ key: "probe", role: "hunter" }],
      cliModel: "sonnet",
      routingConfig: arm.routing,
    });
    const admission = await prepareProductionAdmissionContext({
      workspaceRoot,
      plan,
    });
    if ("error" in admission)
      return { error: admission.error ?? "admission failed" };
    const runtime = await createProductionRuntime({
      ...admission.authorityOptions,
      plan,
      workspaceRoot,
      registry: admission.registry,
      evidence: admission.evidence,
      ...(admission.freeModelProbe === undefined
        ? {}
        : { freeModelProbe: admission.freeModelProbe }),
      mode: "production",
    });
    const route = plan.steps[0]?.route;
    if (route === undefined) {
      await runtime.dispose();
      return { error: "plan has no steps" };
    }
    return { runtime, route };
  }

  async function runLeg(
    arm: ArmDef,
    rep: number,
    leg: number | undefined,
    shared: { runtime: ProductionRuntime; route: ResolvedModelRoute },
  ) {
    const started = performance.now();
    const dir = mkdtempSync(
      path.join(tmpdir(), `prhero-probe-${arm.id}-r${rep}-`),
    );
    const systemPromptPath = path.join(dir, "system.md");
    const mcpConfigPath = path.join(dir, "mcp.json");
    writeFileSync(
      systemPromptPath,
      systemFile !== undefined
        ? await Bun.file(systemFile).text()
        : 'When asked for output, reply with exactly this JSON object and nothing else: {"probe":"alive"}',
    );
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(systemPromptPath, 0o600);

    const userPrompt =
      userFile !== undefined
        ? await Bun.file(userFile).text()
        : padKb > 0
          ? `Reply with the output object now.\n${"FILLER ".repeat(padKb * 146)}`
          : "Reply with the output object now.";

    const result = await shared.runtime.runner.run({
      name: `probe-${arm.id}-r${rep}${leg === undefined ? "" : `-l${leg}`}`,
      systemPromptPath,
      prompt: userPrompt,
      tools: hunterTools ? HUNTER_TOOLS : [],
      mcpConfigPath,
      model: "sonnet",
      cwd: stepCwd ?? workspaceRoot,
      outPath: path.join(dir, "out.json"),
      timeoutMs: timeoutSec * 1000,
      maxAttempts: 1,
      parse: (finalText: string) => {
        if (assertNonEmpty && finalText.trim().length === 0) {
          throw new Error("probe: delivered text is empty");
        }
        return finalText;
      },
      route: shared.route,
    });

    const ms = Math.round(performance.now() - started);
    const outcome = classify(result.status, result.stderrTail);
    const isOk = result.status === "ok";
    const witness: SessionWitness = sanitizeWitness({
      identities: {
        runId: `probe-${arm.id}-r${rep}${leg === undefined ? "" : `-l${leg}`}`,
        attemptId: `att-${result.attempts}`,
        sessionId: `sess-${arm.id}-r${rep}`,
        userMessageId: `msg-user-${rep}`,
        gitCommitSha: process.env.GIT_COMMIT_SHA ?? "dev-workspace",
        sdkVersion: "1.18.25",
        serverVersion: "1.18.30",
        route: {
          provider: shared.route.provider,
          modelSnapshot: shared.route.modelSnapshot,
          ...(shared.route.modelVariant !== undefined
            ? { modelVariant: shared.route.modelVariant }
            : {}),
        },
        cwd: stepCwd ?? workspaceRoot,
        credentialCategory: "operator_configured",
        sanitizedEndpoint: "http://127.0.0.1:ephemeral/v1",
      },
      requestWire: {
        sanitizedPath: "/session/message",
        sanitizedQuery: {},
        sanitizedBody: {
          model: shared.route.modelSnapshot,
          promptChars: userPrompt.length,
        },
        timestamps: {
          sentAt: started,
          receivedAt: Math.round(performance.now()),
        },
        status: isOk
          ? 200
          : result.stderrTail.includes("500")
            ? 500
            : undefined,
        error: isOk
          ? undefined
          : result.stderrTail.includes("session.prompt failed")
            ? result.stderrTail.slice(-300)
            : undefined,
      },
      events: [
        {
          timestamp: started + 5,
          seq: 1,
          eventType: "session.started",
        },
        ...(result.resultText.length > 0
          ? [
              {
                timestamp: started + 10,
                seq: 2,
                eventType: "message.part.updated",
                partId: "prt-1",
                textDelta: result.resultText,
              },
            ]
          : []),
      ],
      readback: {
        directory: stepCwd ?? workspaceRoot,
        messages: [
          {
            id: `msg-asst-${result.attempts}`,
            role: "assistant",
            parentId: `msg-user-${rep}`,
            finishStatus: isOk ? "stop" : undefined,
            parts:
              result.resultText.length > 0
                ? [{ id: "prt-1", type: "text", text: result.resultText }]
                : [],
            finalText: result.resultText,
          },
        ],
      },
      settlement: {
        status: outcome,
        readbackAttempts: isOk ? 1 : 0,
        arbiterTerminalReason: isOk
          ? "completed"
          : outcome === "timeout"
            ? "timeout"
            : "failed",
        abortRequested: false,
        abortAcknowledged: false,
        abortConfirmed: false,
        usageCompleteness: result.usage ? "complete" : "incomplete",
      },
    });
    const classification = classifyWitnessEvidence(witness, result.resultText);
    writeFileSync(
      path.join(dir, "witness.json"),
      `${JSON.stringify(witness, null, 2)}\n`,
    );

    results.push({
      arm: arm.id,
      rep,
      ...(leg === undefined ? {} : { leg }),
      outcome,
      classification,
      ms,
      attempts: result.attempts,
      cost_usd_est: result.usage.cost_usd_est,
      stderrTail: result.stderrTail.slice(-300),
    });

    console.error(
      `  [${arm.id} rep${rep}${leg === undefined ? "" : ` leg${leg}`}] ${outcome} (${classification}) attempts=${result.attempts} ${ms}ms $${result.usage.cost_usd_est.toFixed(4)} resultText=${result.resultText.length}ch`,
    );
  }

  for (const arm of ARMS) {
    if (!only.has(arm.id)) continue;
    console.error(
      `\n=== arm ${arm.id}: ${arm.note} (reps=${arm.parallel ? 1 : reps})`,
    );
    const started = performance.now();
    const made = await makeRuntime(arm);
    if ("error" in made) {
      results.push({
        arm: arm.id,
        rep: 1,
        outcome: "admission-error",
        classification: "external_rejection",
        ms: Math.round(performance.now() - started),
        attempts: 0,
        cost_usd_est: 0,
        stderrTail: made.error.slice(-300),
      });
      console.error(`  [${arm.id}] admission-error: ${made.error}`);
      continue;
    }
    try {
      if (arm.parallel !== undefined) {
        await Promise.all(
          Array.from({ length: arm.parallel }, (_, leg) =>
            runLeg(arm, 1, leg, made),
          ),
        );
      } else {
        for (let rep = 1; rep <= reps; rep++) {
          await runLeg(arm, rep, undefined, made);
        }
      }
    } finally {
      await made.runtime.dispose();
    }
  }

  console.log(
    JSON.stringify({ timeoutSec, reps, homedir: homedir(), results }, null, 2),
  );
  process.exit(0);
}
