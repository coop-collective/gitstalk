import { SignInFlow } from '../../components/account/sign-in-flow';
import { nextFromQuery, stepFromQuery } from '../../src/auth/sign-in-steps';
import { publicPageMetadata } from '../../src/site/page-metadata';

export const metadata = publicPageMetadata({
  path: '/signup',
  title: 'Sign up',
  description:
    'Create a Gitstalk account with your email or a passkey, no password, then pick a handle. Your coding agents connect to it over MCP and you approve each one.',
});
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/** The sign-in flow with sign-up wording, plus the passkey-only sign-up. */
export default async function SignupPage({ searchParams }: PageProps) {
  const query = await searchParams;
  return (
    <SignInFlow
      mode="signup"
      next={nextFromQuery(query)}
      {...stepFromQuery(query)}
      signedOutNote={null}
    />
  );
}
