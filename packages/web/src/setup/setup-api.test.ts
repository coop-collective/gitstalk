import { describe, expect, it } from 'vitest';

import {
  KeyRequestBody,
  keyRequestAnswer,
  pollAnswer,
  setupConfig,
  wantsCreate,
} from './setup-api';

describe('the setup API', () => {
  it('tells the script where git lives, and that SSH is not live while SSH_HOST is empty', () => {
    const vars = {
      GIT_ORIGIN: 'https://git.example.test/',
      MCP_URL: 'https://mcp.example.test/mcp',
      SSH_HOST: '',
    };
    expect(setupConfig(vars, 'https://web.example.test')).toEqual({
      web: 'https://web.example.test',
      git_origin: 'https://git.example.test',
      ssh_host: null,
      mcp_url: 'https://mcp.example.test/mcp',
    });
    expect(
      setupConfig({ ...vars, SSH_HOST: 'ssh.example.test' }, 'https://web.example.test').ssh_host,
    ).toBe('ssh.example.test');
  });

  it('answers a key request like a device authorization, with the code in the link', () => {
    const answer = keyRequestAnswer(
      { userCode: 'BCDF-GHJK', pollToken: 'p'.repeat(43), fingerprint: 'SHA256:x', expiresIn: 600 },
      'https://web.example.test',
    );
    expect(answer).toMatchObject({
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://web.example.test/settings/keys/add',
      verification_uri_complete: 'https://web.example.test/settings/keys/add?code=BCDF-GHJK',
      expires_in: 600,
      interval: 3,
    });
  });

  it('hands over the HTTPS token only in the approved answer that carries it', () => {
    expect(pollAnswer({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(pollAnswer({ status: 'approved', handle: 'coop', httpsToken: null })).toEqual({
      status: 'approved',
      handle: 'coop',
    });
    expect(
      pollAnswer({
        status: 'approved',
        handle: 'coop',
        httpsToken: { token: 'bsu_x', expiresAt: 5 },
      }),
    ).toEqual({
      status: 'approved',
      handle: 'coop',
      https_token: 'bsu_x',
      https_token_expires_at: 5,
    });
  });

  it('accepts a key line and a machine name, and nothing shaped otherwise', () => {
    expect(
      KeyRequestBody.safeParse({
        public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA',
        machine: 'mbp',
      }).success,
    ).toBe(true);
    expect(KeyRequestBody.safeParse({ public_key: 'x', machine: 'mbp' }).success).toBe(false);
    expect(KeyRequestBody.safeParse(null).success).toBe(false);
  });

  it('reads the create scope the setup script asks for', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA';
    const asked = KeyRequestBody.parse({
      public_key: key,
      machine: 'mbp',
      scopes: ['read', 'write', 'create'],
    });
    expect(wantsCreate(asked)).toBe(true);
    expect(wantsCreate(KeyRequestBody.parse({ public_key: key, machine: 'mbp' }))).toBe(false);
  });
});
