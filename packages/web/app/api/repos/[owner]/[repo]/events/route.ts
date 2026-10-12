import { answerEvents } from '../../../../../../src/changes/changes-api';
import type { RepoRouteContext } from '../../../../../../src/changes/viewer-repo-access';
import { viewerRepoAccess } from '../../../../../../src/changes/viewer-repo-access';

/**
 * `GET /api/repos/:owner/:repo/events[?after=<seq>]`: the repository's engine events (those
 * after `seq` when given), for the viewers who may read it; a 404 for anyone else.
 */
export async function GET(request: Request, context: RepoRouteContext): Promise<Response> {
  return answerEvents(request, await viewerRepoAccess(context));
}
