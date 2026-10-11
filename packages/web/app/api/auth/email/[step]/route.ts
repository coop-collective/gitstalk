import { z } from 'zod';

import { emailStep } from '../../../../../src/auth/email-routes';
import { problem } from '../../../../../src/auth/http';

type Context = { readonly params: Promise<{ readonly step: string }> };

const Step = z.enum(['start', 'verify', 'handle', 'add', 'confirm']);

/** Email sign-in and Settings → Emails, one form post per step (src/auth/email-routes.ts). */
export async function POST(request: Request, context: Context): Promise<Response> {
  const step = Step.safeParse((await context.params).step);
  if (!step.success) return problem(404, 'not_found', 'no such step');
  return emailStep(request, step.data);
}
