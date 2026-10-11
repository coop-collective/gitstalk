/**
 * The setup scripts, served by the web app for agents without the plugin
 * (`curl -fsSL <web>/setup.sh | sh -s -- detect`). `./scripts/` is the canonical copy; the
 * plugin repository (coop-collective/gitstalk-plugin, `scripts/`) keeps its own for
 * `/gitstalk:setup` and runs the script tests, so a change goes to both. The default Gitstalk
 * address inside them becomes this deployment's, so staging serves a script for staging.
 */
import powershell from './scripts/gitstalk-setup.ps1?raw';
import posix from './scripts/gitstalk-setup.sh?raw';

const PUBLIC_WEB = 'https://gitstalk.io';

export function setupScript(kind: 'sh' | 'ps1', webOrigin: string): Response {
  const body = (kind === 'sh' ? posix : powershell).split(PUBLIC_WEB).join(webOrigin);
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
