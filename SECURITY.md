# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub's private vulnerability reporting:

1. Go to [github.com/coop-collective/gitstalk/security/advisories/new](https://github.com/coop-collective/gitstalk/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the issue, the affected component (for example the gateway, the MCP server, git over SSH, Actions or the web app), steps to reproduce, and the impact you expect.

**Do not open a public issue, pull request or discussion for a security problem**, and do not share details publicly until a fix is released.

We aim to acknowledge a report within a few days and to keep you updated as we investigate and fix it. With your permission, we will credit you in the advisory.

## Scope

In scope:

- The code in this repository, including the Workers, the container images and the deployment scripts.
- The hosted service at [gitstalk.io](https://gitstalk.io) and its subdomains, including `mcp.gitstalk.io`.

When testing the hosted service, use only accounts and repositories you own, do not access other people's data, and do not degrade the service for others (no denial-of-service or high-volume automated testing).

Out of scope: vulnerabilities in third-party dependencies or in Cloudflare's platform itself (report those upstream), and findings that need physical access to a user's device.

## Supported versions

Gitstalk is deployed continuously from `main`. Security fixes are made on `main`; there are no separately maintained release branches.
