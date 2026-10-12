import { SignInFlow } from '../../components/account/sign-in-flow';
import { nextFromQuery, stepFromQuery } from '../../src/auth/sign-in-steps';

export const metadata = { title: 'Sign in' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type Query = Readonly<Record<string, string | string[] | undefined>>;
type PageProps = { readonly searchParams: Promise<Query> };

/** Sign in (or up): a passkey, or an email code (components/account/sign-in-flow.tsx). */
export default async function LoginPage({ searchParams }: PageProps) {
  const query = await searchParams;
  return (
    <SignInFlow
      mode="signin"
      next={nextFromQuery(query)}
      {...stepFromQuery(query)}
      signedOutNote={signedOutNote(query)}
    />
  );
}

/** What brought someone here signed out: signing out, or deleting their account. */
function signedOutNote(query: Query): string | null {
  if (query['account'] === 'deleted') return 'Your account was deleted.';
  return query['signed_out'] === undefined ? null : 'You are signed out.';
}
