/**
 * Which tools a caller can ever use, decided once per server: a tool its token's scopes or
 * kind rule out is not registered, so an agent never sees, picks and fails with it. What
 * depends on the repository (the person's role there) is still checked at call time.
 */
import type { ToolScope } from '../tools/tool-context';

/** A session with the write scope: beans, task claims, starting and cancelling runs. */
export function sessionMayWrite(scope: ToolScope): boolean {
  return scope.session?.scopes.includes('write') === true;
}

/** A session with the opt-in secrets scope: setting and deleting secrets and variables. */
export function sessionMaySetConfig(scope: ToolScope): boolean {
  return scope.session?.scopes.includes('secrets') === true;
}

/** A session with the create scope: `repo_create` (the namespace rule is checked per call). */
export function sessionMayCreate(scope: ToolScope): boolean {
  return scope.session?.scopes.includes('create') === true;
}
