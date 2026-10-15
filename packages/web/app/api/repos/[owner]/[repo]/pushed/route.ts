import { answerPushed } from '../../../../../../src/changes/changes-api';
import type { RepoRouteContext } from '../../../../../../src/changes/viewer-repo-access';
import { viewerRepoAccess } from '../../../../../../src/changes/viewer-repo-access';

/**
 * `GET /api/repos/:owner/:repo/pushed`: the beans people pushed to the repository, with their
 * phase and verdict, for the viewers who may read it; a 404 for anyone else.
 */
export async function GET(request: Request, context: RepoRouteContext): Promise<Response> {
  return answerPushed(request, await viewerRepoAccess(context));
}
