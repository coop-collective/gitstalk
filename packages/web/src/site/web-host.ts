/**
 * The host people see in front of a handle (`gitstalk.dev / coop`): this deployment's own,
 * from WEB_URL, so staging, production and a fork each show their address.
 */
export function webHost(webUrl: string | undefined): string {
  try {
    return new URL(webUrl ?? '').host;
  } catch {
    return 'gitstalk';
  }
}
