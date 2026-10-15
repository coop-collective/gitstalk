import { answerFile } from '../../../../../../../src/code/file-tree-api';
import type { TreeRouteContext } from '../../../../../../../src/code/viewer-tree-access';
import { viewerTreeAccess } from '../../../../../../../src/code/viewer-tree-access';

/**
 * `GET /api/repos/:owner/:repo/code/file?sha=&path=`: one file at a commit, for a file the Code
 * tab opens in the browser; a 404 for anyone who may not read the repository.
 */
export async function GET(request: Request, context: TreeRouteContext): Promise<Response> {
  return answerFile(request, await viewerTreeAccess(context));
}
