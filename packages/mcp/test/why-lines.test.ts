import { SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  digest,
  gitPush,
  person,
  personalToken,
  plantOnSprout,
  repository,
  slug,
} from './repo-fixtures';

/**
 * `why_lines` end to end: a person's agent session, the real gateway and its derived history
 * over a repository whose bean landed through the engine (fake Artifacts and runner).
 */
const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', new URL(request.url).host);
      return SELF.fetch(request);
    },
  });
  const client = new Client({ name: 'why-lines-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const Content = z.array(z.object({ type: z.literal('text'), text: z.string() }));

async function tool(client: Client, name: string, input: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: input });
  const text = Content.parse(result.content)[0]?.text ?? '';
  if (result.isError === true) return { error: text };
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

const TAX = 'const TAX = 0.2;\nexport function tax(x) {\n  return x * TAX;\n}\n';

describe('why_lines', () => {
  it('names the bean that last changed a line range, with its landing and the path history', async () => {
    const owner = await person('mcp-why');
    const repo = await repository(owner, { name: 'invoices' });
    const token = await personalToken(owner, ['read', 'write']);
    await plantOnSprout(repo, { 'src/tax.ts': TAX }, token);
    const landed = await gitPush(slug(repo), token, {
      bean: 'raise-tax',
      newSha: await digest(`raise-tax:${repo.id}`),
      message: 'Tax invoices at 25 percent',
      options: ['wait'],
      files: { 'src/tax.ts': TAX.replace('0.2', '0.25') },
    });
    expect(landed.remote).toContain('LANDED');
    const rounded = await gitPush(slug(repo), token, {
      bean: 'round-tax',
      newSha: await digest(`round-tax:${repo.id}`),
      message: 'Round taxes',
      options: ['wait'],
      files: { 'src/tax.ts': TAX.replace('0.2', '0.25').replace('x * TAX', 'Math.round(x * TAX)') },
    });
    expect(rounded.remote).toContain('LANDED');

    const client = await connect(token);
    // The landing reaches derived history through the repo-events queue.
    const answer = await vi.waitFor(
      async () => {
        const read = await tool(client, 'why_lines', {
          path: 'src/tax.ts',
          start: 1,
          end: 3,
          repo: slug(repo),
        });
        if (JSON.stringify(read).includes('round-tax')) return read;
        throw new Error('the landing is not derived yet');
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(answer).toMatchObject({
      path: 'src/tax.ts',
      lines: 4,
      ranges: [
        { lines: '1-2', bean: 'raise-tax', kind: 'landing' },
        { lines: '3', bean: 'round-tax', kind: 'landing' },
      ],
      history: [
        { bean: 'round-tax', kind: 'landing', change: 'modified' },
        { bean: 'raise-tax', kind: 'landing', change: 'added' },
      ],
    });
    expect(answer).toHaveProperty(['beans', 'round-tax', 'title'], 'Round taxes');
    expect(
      await tool(client, 'why_lines', { path: 'missing.ts', repo: slug(repo) }),
    ).toHaveProperty('error');
  });
});
