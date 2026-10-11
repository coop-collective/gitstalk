/**
 * What `/api/sessions` answers, checked with a plain type guard so Home's client bundle
 * carries no schema library. The server validates the full shape (`AgentSession`); this side
 * only needs the fields it shows.
 */
export type ConnectedSession = {
  readonly grantId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly settling?: boolean | undefined;
};

export type SessionsAnswer = { readonly sessions: readonly ConnectedSession[] };

export function isSessionsAnswer(value: unknown): value is SessionsAnswer {
  if (!isRecord(value)) return false;
  const sessions: unknown = value['sessions'];
  return Array.isArray(sessions) && sessions.every(isConnectedSession);
}

function isConnectedSession(value: unknown): value is ConnectedSession {
  if (!isRecord(value)) return false;
  const { grantId, clientName, scopes, createdAt, settling } = value;
  return (
    typeof grantId === 'string' &&
    typeof clientName === 'string' &&
    Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === 'string') &&
    typeof createdAt === 'number' &&
    (settling === undefined || typeof settling === 'boolean')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
