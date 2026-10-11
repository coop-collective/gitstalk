/**
 * The bindings the identity library reads. Each Worker that uses it binds the same D1
 * database as IDENTITY_DB (`beanstalk-identity`, schema in ../migrations); the web app also
 * binds the sign-in rate limiter and the email sender (`email.ts`).
 */
export type IdentityEnv = {
  readonly IDENTITY_DB: D1Database;
};

/** The sign-in endpoints' extra bindings (web only). */
export type SignInEnv = IdentityEnv & {
  readonly SIGNIN_RATE_LIMIT: RateLimit;
};

/** One clock for the library, so tests can move it. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
