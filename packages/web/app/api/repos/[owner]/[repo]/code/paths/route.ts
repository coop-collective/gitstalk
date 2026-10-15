import { answerPaths } from '../../../../../../../src/code/file-tree-api';
import type { TreeRouteContext } from '../../../../../../../src/code/viewer-tree-access';
import { viewerTreeAccess } from '../../../../../../../src/code/viewer-tree-access';

/**
 * `GET /api/repos/:owner/:repo/code/paths?sha=`: every file's path at a commit, for Go to file;
 * a 404 for anyone who may not read the repository.
 */
export async function GET(request: Request, context: TreeRouteContext): Promise<Response> {
  return answerPaths(request, await viewerTreeAccess(context));
}
