import { env } from 'cloudflare:workers';

import { RunId, TaskId } from '@gitstalk/shared-race/ids';

import { runAccess } from '../../../../../../../src/admin/admin-gate';
import { answerBeanDiff } from '../../../../../../../src/changes/bean-diff-answer';
import { problem } from '../../../../../../../src/edge/http-cache';
import { publicObjects } from '../../../../../../../src/edge/public-objects';
import { forgeForRun } from '../../../../../../../src/forge/sources';

type Context = { readonly params: Promise<{ readonly run: string; readonly bean: string }> };

/**
 * A bean's own diff (its landing, or its newest head against the line), for decision cards
 * and a bean's page: a repository's engine to its readers, a benchmark race to platform admins
 * only, a 404 for anyone else. A public repository's diff is edge-cached by its commit pair.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const params = await context.params;
  const run = RunId.safeParse(params.run);
  const bean = TaskId.safeParse(params.bean);
  if (!run.success || !bean.success) return problem(400, 'not a run or a bean id');
  return answerBeanDiff(
    { request, run: run.data, bean: bean.data, access: await runAccess(request, run.data) },
    { source: forgeForRun(env.GATEWAY, run.data), objects: publicObjects },
  );
}
