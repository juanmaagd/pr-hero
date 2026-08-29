import { WorkspaceReadBroker } from "./workspace-read-broker";

export interface WorkspaceCwdAuthorization {
  readonly approved: true;
  readonly canonicalCwd: string;
}

export interface WorkspaceCwdDenial {
  readonly approved: false;
  readonly reason: string;
}

export type WorkspaceCwdAuthorizationResult =
  | WorkspaceCwdAuthorization
  | WorkspaceCwdDenial;

export function authorizeWorkspaceCwd(
  workspaceRoot: string,
  cwd: string,
): WorkspaceCwdAuthorizationResult {
  const broker = new WorkspaceReadBroker({ workspaceRoot });
  const result = broker.authorizePath(cwd);
  if (!result.approved) {
    return { approved: false, reason: result.reason };
  }
  return { approved: true, canonicalCwd: result.canonicalPath };
}
