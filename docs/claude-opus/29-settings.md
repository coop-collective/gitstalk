# 27 · Settings, profiles and uploads

Built 2026-10-09 on a worktree branch from `prototype` at `b3f6bdf` (lane S of three: settings; lane O builds organisations, lane C collaborators). People get a profile with a picture, a handle they can change, and a delete button; repositories get a website, topics and a social image; both settings areas share one GitHub-like layout in the Nightshift skin.

## 1. What a person sees

| Where | What |
|---|---|
| `/settings` Public profile | Picture (upload, remove; the generated one otherwise), name, bio (160), website |
| `/settings/account` | Handle change (rules below, earlier handles listed), delete account (what happens, typed confirmation, blocked for the sole owner of an organisation) |
| `/settings/emails` | The verified address, if any; adding one waits for email sending (`19` §6) |
| `/settings/passkeys` | List, rename inline, add another, remove (the last one's Remove is disabled) |
| `/settings/sessions` | Connected agents (Disconnect), signed-in browsers ("this browser", Sign out per browser), sign out here / everywhere |
| `/settings/keys`, `/settings/tokens` | As before (`19` §9), inside the shell |
| `/settings/notifications` | Placeholder: what will be sent, all switches disabled, "nothing is sent today" |
| `/<owner>/<repo>/settings/*` | One page per section since 2026-10-10 (§8): General, Social image, Visibility, Branches, Checks, Actions, Collaborators, Secrets and variables, Deploy tokens, Danger zone |
| `/orgs/<org>/settings/*` | One page per section since 2026-10-10 (§8): General (with the icon), Members and invitations, Repository defaults, Secrets and variables, Audit log, Danger zone |
| `/<handle>` | The person's page: picture, name, bio, website, then their repositories (public ones for everyone; archived ones only for themselves) |
| Header | The app header (§9): mark and primary links; the New menu; the person's avatar opening their menu (profile, repositories, organizations, settings, connect an agent, docs, day or night, sign out) |

Shell: `components/settings/settings-shell.tsx` (`SettingsShell`, `SettingsSection`, `SaveStatus`, `SoonPill`), left nav at 220 px; under 760 px the nav is one strip of chips that scrolls sideways inside itself, the current one scrolled into view (`settings-client.tsx`). Text forms are server actions (`src/server/account-actions.ts`, origin + session + CSRF checked by `signedInForm`) with a "Saving… / saved / error" line (`role=status` / `alert`); uploads are multipart POSTs to route handlers. Since 2026-10-14 a "Change picture" button opens a crop dialog (`components/settings/picture-upload.tsx`, `picture-crop-dialog.tsx`; math in `src/settings/picture-crop.ts`): drag, arrow keys, wheel, pinch and a slider move and zoom the image inside a circle (avatars), square (icons) or 2:1 frame (social images), and Save posts the crop (460×460 or 1280×640, WebP, PNG fallback) to the same routes, so the server still validates and normalises it. Without JavaScript the plain file input and Upload button post the original file as before.

## 2. Uploads (`@gitstalk/shared-media`)

**Contract** (lane O uses it for organisation icons):

```ts
mediaStore(env).uploadImage(kind: 'user' | 'org' | 'repo', ownerId, file: Blob)
  → { ok: true, image: { key, url, width, height, normalized } } | { ok: false, error: { code, message } }
imageUrl(key, size?)            // '/media/<key>' or '/media/<key>/<width>'
mediaStore(env).pruneImages(kind, ownerId, keepKey | null)   // after the new key is saved
mediaStore(env).deleteOwnerMedia(kind, ownerId)              // account or organisation deletion
serveImage(env, request, path)  // GET /media/<path>
isImageKeyOf(key, kind, ownerId), fallbackAvatar(seed, label)
```

- **Where:** the web Worker, not the gateway. Uploads come from a signed-in browser to the web host with its session cookie, and the pictures are served by the same host (`/media/…`), so a gateway hop would add latency and a second place that checks the session. The gateway stays the git and engine plane; it only stores a repository's social image key (validated as `repos/<that id>/social/<hash>`).
- **Bucket** `beanstalk-media` (binding `MEDIA`). Keys `users/<id>/avatar/<hash>`, `orgs/<id>/icon/<hash>`, `repos/<id>/social/<hash>`; the hash is 128 bits of SHA-256 of the uploaded bytes, so a new picture is a new URL and the same file is the same key.
- **Validation from bytes**, never the file name or the browser's type: PNG, JPEG, WebP (VP8, VP8L, VP8X), GIF; SVG refused by name ("can carry scripts"); 2 MB (checked from `Content-Length` before the form is parsed, then from the file); 16 to 4096 px a side; owner ids `[A-Za-z0-9_-]{1,64}`.
- **Normalised with the Cloudflare Images binding** (`IMAGES`): avatars and icons at 460, 128 and 64 px square, social images at 1280×640 and 640×320, WebP, first frame only (`anim: false`), metadata gone. The object at the key is the largest size, `<key>/<width>` the others. **Verified on workers.dev** (account `devaccounts`): a probe Worker with only the binding transformed a 300×200 PNG to a 64×64 WebP; on staging the three avatar sizes were 2.8 KB, 528 B and 264 B. `cf.image` on `fetch` needs a zone with transformations and was not used.
- **Without the binding** (or when Images refuses, e.g. out of transformations): the original is stored once, with PNG `tEXt/zTXt/iTXt/eXIf/tIME` chunks and JPEG EXIF/XMP/comments removed, the EXIF orientation written back alone so photos stay upright; it is served for every size. Animated GIFs stay animated on that path, and WebP metadata is kept.
- **Serving:** `app/media/[...path]/route.ts`: `cache-control: public, max-age=31536000, immutable`, ETag with 304, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, only the four image types; anything that is not an image key or a stored width is a 404 cached a minute. `media` is a reserved handle.
- **Replace and delete:** upload → save the key (profile row or repository record) → prune everything else in that slot; a failed save leaves an orphan that the next prune removes. Removing a picture saves null and prunes the slot. Deleting an account deletes `users/<id>/` and each deleted repository's `repos/<id>/`.
- **Fallback avatars:** `fallbackAvatar(seed, label)` gives initials (people) and a mirrored 5×5 identicon (organisations), the hue from the account id so a handle change keeps the colour; drawn inline as SVG by `components/account/avatar.tsx` (no user text except escaped initials).
- **Private repositories' social images** are served to anyone with the URL; the URL holds a 128-bit content hash, which cannot be guessed without the image.

## 3. Handles

`changeHandle` (`shared-identity/profiles.ts`): the new handle passes `Handle` (format and reserved list), is not anyone's current handle and not someone else's retired one, and the last change was over 24 hours ago. In one D1 batch the old handle goes to `retired_handles` (owned by the person), the person's own retired row for the new handle (taking one back) is removed, the user row changes, and `handle.change` is audited.

- **Retired handles stay the person's**: sign-up refuses them (`isHandleTaken` checks both tables), they redirect `/<old>` and `/<old>/<repo>/…` (page loader, to the repository home) and git's `info/refs` (301 with path and query kept; git follows a redirect on its first request and uses the new base for the rest). They are freed only when the account is deleted. Whether to expire them after N days is open (§7).
- **Repository addresses follow the same pattern** (`28` §6.3, 2026-10-09): a repository rename or transfer leaves a redirect row (old owner handle + old name → repository id). Web pages redirect to the repository home the same way (307); git over HTTPS and SSH and the MCP tools are served in place at the old address (git does not follow a redirect on a push). `renameOwner` moves the person's redirect rows to the new handle and the gateway's `Registry.resolve` follows a retired handle, so an old handle and an old repository name compose. Organisations cannot change handle yet.
- **The registry moves with it:** `AccountsRpc.renameOwner(userId, handle)` on the gateway updates `repositories.owner_handle`, members, sessions and pending invitations in one batch. The web changes accounts first, then the registry; if the registry fails it reverts the handle (and the cooldown) and says nothing changed (`changeHandleFlow`).
- **Agents:** OAuth grants carry the handle of the day; the MCP Worker now reads the person's current handle from `IDENTITY_DB` on every request and answers 401 `invalid_token` when the account is gone.

## 4. Deleting an account

`deletionPlan(facts)` blocks the sole owner of an organisation (named in the message). Otherwise, after the handle is typed: `AccountsRpc.closeAccount` deletes the person's repositories (active and archived: registry, engine, Artifacts) and their memberships and invitations elsewhere; every agent grant is revoked; pictures are deleted; then `deleteUser` removes the user row, whose cascade takes passkeys, sessions, tokens, SSH keys and retired handles (audit rows stay). A registry failure stops before anything else and says so. The organisation facts come from `ownedOrganizations` in `web/src/account/account-services.ts` (lane O's `orgsOf` and `orgMembers`). Deleting an organisation deletes its icon too.

## 5. Data

- Identity D1 migration `0005_profiles.sql`: `users.display_name`, `bio`, `website`, `avatar_key`, `handle_changed_at`; table `retired_handles (handle PK nocase, user_id → users ON DELETE CASCADE, retired_at)`.
- Forge D1 migration `0008_repository_profile.sql`: `repositories.website`, `topics_json`, `social_image_key`. The record carries them as optional fields, so an older gateway reads as empty.
- Web bindings: R2 `MEDIA` (`beanstalk-media`), `IMAGES`. Only additions; apply both migrations before deploying gateway and web.

## 6. Verified

Tests: `shared-media` (31: format sniffing for every type and refusal, metadata stripping with orientation kept, 2 MB edge, 16/4096 px, owner ids, key layout, Images sizes with a fake resizer and the fallback when it refuses, prune on replace, delete one and per owner, `imageUrl` snapping, `serveImage` caching/304/404, fallback avatars), `shared-identity/test/profiles.test.ts` (13: profile validation, avatar replace answers the old key, handle rules, retired handles at sign-up and on change, the cooldown, taking a handle back, revert, passkey rename, browser sessions, deletion guard, confirmation, cascade), `gateway/test/accounts.test.ts` (5: rename moves repositories and memberships, close deletes active and archived and leaves others', profile fields and refusals), web `src/account/account-flows.test.ts` (10: handle change and revert order, picture replace/remove order, deletion order and guards), `src/git/git-host.test.ts` (old-handle git location), `src/repositories/repositories.test.ts` (website and topics from the form).

**Staging, end to end, 42 of 42** (`exp/settings/e2e-results.json`, screenshots `exp/settings/01…17-*.png`, night, day and phone). Stack `beanstalk-{gateway,web,mcp}-staging-set` on the devaccounts workers.dev subdomain, D1 `beanstalk-identity-staging-set` / `beanstalk-forge-staging-set`, KV `beanstalk-oauth-staging-set`, R2 `beanstalk-media-staging-set` (and `beanstalk-actions-logs-staging-set`), queue `beanstalk-repo-events-staging-set`, Artifacts `beanstalk-{race,repos}-staging-set`, the Images binding on, Actions in stub mode; headless Chrome with a CDP virtual authenticator, after merging lane O (organisations):

passkey sign-up; the generated initials; upload → three WebP sizes from R2 (2.8 KB, 528 B, 264 B), `immutable`, 304 on the ETag; an SVG renamed `.png` refused with the reason; a 2.2 MB body refused before parsing; a 1.9 MB upload stored and the previous picture pruned; profile saved (a CRLF bio stored as LF), a `javascript:` website refused; a public repository with website, topics and a social image; the person's page as owner and as a signed-out stranger; the only passkey's Remove disabled, rename, a second passkey from a second authenticator, one removed; the browser list; handle change: header updated, `/<old>` 307 → new, `/<old>/greeter/settings` lands on the new address, git `info/refs` 301, **`git clone` of the old URL works**, the old handle refused at sign-up, a second change the same day blocked; no sideways scroll at 390 px on profile, account and repository settings; an organisation icon uploaded to `orgs/<id>/icon/…` and served, account deletion blocked as its sole owner (named), the organisation deleted with its icon; account deletion refused for a wrong confirmation, then done: the person's page 404, avatar and social image 404 from R2, the old session signed out.

Fixed on the way, found only on staging: vinext treats every multipart POST as a possible progressive server action and refused bodies over 1 MB with 413 before the route ran (`next.config.ts` `experimental.serverActions.bodySizeLimit: '3mb'`); textareas send CRLF, which the bio's control-character check refused; a server action's `redirect` does not re-render the layout, so after a handle change, removing a picture or deleting the account the forms now load the page whole (the header showed the old handle).

**Live** since 2026-10-09: identity `0005`, forge `0008`, R2 `beanstalk-media`, web `25652551` with the Images binding. On the hosted service the avatar came back as WebP at 460/128/64 px (2.8 KB, 816 B, 374 B), the org icon and a repository social image (1280 and 640) as WebP; a handle change redirected `/<old>/<repo>` (307) and `git clone` of the old URL (301); both test accounts were removed with Delete account (`exp/live-orgs-settings/`). One gap found there, since fixed: deleting a repository from Settings left its social image in R2; the delete action now prunes `repos/<id>/` (a delete through the gateway API alone still does not). Checked again 2026-10-09 (doc 27 §10.8): both callers of the gateway's delete (repository Settings, and account deletion for each repository it removes) prune `repos/<id>/`; the gateway has no media binding, so only a future caller that skips the web would leave it. A gateway delete now also removes the repository's dependency cache, Actions logs, Actions rows (workflows and automations, runs, secrets, variables, job tokens) and its schedules. The staging stack has been torn down.

## 7. Open

- Retired handles never expire (GitHub frees them at once). Expiring after, say, 90 days would need the redirects to stop then too.
- Emails and notifications wait for the sender domain; the pages say so.
- Repository renames and transfers redirect since 2026-10-09 (`28` §6.3). Organisation handle changes are not built (`28` §6.3 lists what they need).
- A repository's social image is not yet used in `og:image` tags.

## 8. One page per section (2026-10-10)

Owner, 2026-10-10: "Redesign settings pages to have dedicated pages and forms to save versus one long list to scroll down, when clicking on the nav on the left. also need to design the nav bar so i can signout, etc."

Account settings were already one route per section; repository and organization settings were one long page with an anchor nav. Now every section is its own route with its own form(s), Save button and saved/error line, and the left nav marks the current page (`aria-current="page"`).

| Route | Who | Content (form → action) |
|---|---|---|
| `/settings` | signed in | Public profile: picture (multipart → `/settings/profile/avatar`), name, bio, website (`updateProfile`) |
| `/settings/account` | | Handle (`changeHandle`); Delete account (typed handle) |
| `/settings/emails`, `/settings/notifications` | | Read-only until mail is sent |
| `/settings/passkeys` | | Rename (`renamePasskey`), add, remove (route) |
| `/settings/sessions` | | Agents (disconnect), browsers (sign out one), sign out here / everywhere (`/auth/signout`) |
| `/settings/keys`, `/settings/tokens` | | Paste a key (route), create and revoke tokens |
| `/<o>/<r>/settings` | any role | 307 to the first section this viewer may open |
| `…/settings/general` | owner, not archived | Name, description, website, topics (`updateRepository`); a rename lands on the new address's General with `?saved=renamed`, a transfer with `?saved=transferred` |
| `…/settings/social-image` | owner, not archived | Upload or remove (multipart → `…/settings/social-image/upload`, back here with `?picture=`) |
| `…/settings/visibility` | owner, not archived | Public / private / internal (`updateRepository`) |
| `…/settings/branches`, `…/settings/checks` | any role | Read-only |
| `…/settings/rules` | any role reads; owner and maintainers save | The approval rules' `.gitstalk/policy.yml`, saved as a bean authored by the person (`32-approval-rules.md` §7) |
| `…/settings/actions` | owner, maintainer | Jobs: dependency cache on/off, largest snapshot, npm audit on/off, one Save (`saveActionsSwitchesAction`; stored as the repository variables `GITSTALK_DEPS_CACHE`, `GITSTALK_DEPS_SNAPSHOT_MAX`, `GITSTALK_NPM_AUDIT`, a default removes the variable; read-only while archived); Features placeholder |
| `…/settings/collaborators` | owner | Invite, roles, remove, cancel |
| `…/settings/secrets` | any role, where Actions run | Secrets and variables (maintainers and the owner change them) |
| `…/settings/deploy-tokens` | owner, maintainer, not archived | Create, revoke |
| `…/settings/danger` | owner | Archive (confirmation dialog) / Unarchive, Transfer (dialog), Delete (type `<owner>/<name>`); archive lands here with `?saved=archived` |
| `/orgs/<org>/settings` | any member | 307 to General (owners, admins) or Secrets and variables (members, viewers) |
| `…/settings/general` | owner, admin | Name, description (`updateOrgAction`); icon (multipart → `…/settings/icon`, back here with `?picture=`) |
| `…/settings/members` | owner, admin | Invite, roles, remove, cancel |
| `…/settings/repository-defaults` | owner, admin | Base permission, who creates, default visibility (`updateOrgAction`) |
| `…/settings/secrets` | any member | Org secrets and variables (owners and admins change them) |
| `…/settings/audit-log` | owner, admin | The org's audit log |
| `…/settings/danger` | any member; delete for owners | Leave (dialog), Delete (type the handle; only with no repositories) |

- **Rules in one place:** `src/settings/sections.ts` lists each section with who may open it (`repoSections(facts)`, `orgSections(role)`), the landing section and the nav groups; `src/server/repository-settings.ts` and `src/server/org-settings.ts` load each page, return the same 404 as before to people without a role, and send a section the viewer may not open to their first one. The gateway and the identity library still check every change.
- **Old addresses:** `/settings#social` and the other one-page anchors land on their pages: the landing redirect keeps the fragment (browsers carry it across a redirect), and `LegacyAnchor` on each page replaces the location when the anchor belongs to another section (`REPO_ANCHORS`, `ORG_ANCHORS`: `#social`, `#visibility`, `#features`, `#collaborators`, `#actions`/`#secrets`, `#deploy-tokens`, `#archive`/`#transfer`/`#danger`; `#icon`, `#members`, `#leave`). Everything the code redirects to (`src/settings/redirects.ts`: rename, transfer, archive, uploads) names the section page directly. The People tab links to `…/settings/collaborators`. The anchors land only for someone who may open the settings: for a missing repository, one the viewer cannot read, or a viewer without a role, every settings address (old anchor or section page) answers the not-found page with status 404.
- **Destructive actions** (archive, transfer, delete a repository; leave, delete an org) sit only on the Danger zone pages. Archive, transfer and leave ask in a modal `<dialog>` (`components/settings/confirm-submit.tsx`, Escape cancels); the deletes ask for the name to be typed. Removing one collaborator, member, key or token stays beside that row, as on GitHub. Deleting the account stays on Account (typed handle), as the owner listed.
- **Tests:** `src/settings/settings.test.ts` (sections per role and state, landing, old anchors, redirect paths, Actions switches), `src/repositories/repositories.test.ts` (rename and archive redirects).

## 9. The app header and signing out (2026-10-10)

`components/shell/site-header.tsx` on every page; the entries are data in `src/shell/header-entries.ts`.

- **Left:** the mark (Home) and the primary links: Home, Repositories (`/<handle>`), Organizations (`/orgs`, new: the person's organizations with role and Settings), Benchmark runs. Signed out: Benchmark runs and Watch the race. Under 720 px the links move to a second row that scrolls sideways.
- **Right, signed in:** **+ New** (New repository, New organization, Connect an agent) and the avatar, whose menu has "Signed in as @handle", Your profile, Your repositories, Your organizations, Settings, Connect an agent, Docs (`DOCS_URL`, the site's `/docs/`, set per environment by `scripts/environments.mjs`), Theme (Day / Night) and **Sign out**. Signed out: the day/night pair, Sign in, Sign up. "Close demo gate" stays while the demo password cookie is set.
- **Menus** (`components/shell/header-menu.tsx`) follow the WAI-ARIA menu button: `aria-haspopup`, `aria-expanded`, `role=menu` with `menuitem` / `menuitemradio`; Enter, Space or ArrowDown open on the first item, ArrowUp on the last; arrows, Home and End move; Escape closes and returns focus to the button; Tab and a click outside close.
- **Sign out** is the existing `POST /auth/signout` (`src/auth/sign-out.ts`): same origin, a live session and its CSRF token; it revokes the session row (`everywhere=1`: all of them), records `session.signout` in the audit log, clears `__Host-bs_session` and answers 303 to `/login?signed_out=1`, which says "You are signed out." Any protected page then redirects to `/login?next=…`. Tests: `src/auth/sign-out.test.ts`, `src/shell/header.test.ts`.
- **Themes:** the owner asked (2026-10-10) to keep only the two designs. The day skins *paper* and *blueprint*, their selector and the `bs_day` cookie are gone; Nightshift has night and day (daylight phosphor) only, chosen by the sun/moon pair (signed out) or the menu's Theme item. A stale `bs_day` cookie is ignored and expired by the theme control. The marketing site never had the selector.

### 9.1 Verified (2026-10-10)

`pnpm check` exits 0. Staging web version `1408f1d0` (deployed with `pnpm env:deploy staging --only web`; the gateway is unchanged), walked through that version's preview URL because another session redeployed the shared staging Worker twice during the walk. Headless Chromium with a CDP virtual authenticator, one throwaway account: **96 of 96** checks. Passkey sign-up; the header (primary links, the New menu, the user menu by mouse and keyboard: ArrowDown, End, Escape back to the button, click outside, Day and Night, no skin select); every account page, saving the profile, a picture, a handle change, a passkey name, an SSH key and a token; a repository: landing on General, seven old anchors on their pages, General saved (and still filled after the save and after a reload), a rename landing on the new address, a social image, visibility, Actions switches saved, persisted and a bad size refused, the switches visible as repository variables, a refused invitation, a variable, a deploy token, archive through the dialog (Escape cancels; the archived nav drops editing; General then sends to Branches) and unarchive; an organization: landing, `#icon`, General, an icon, a refused invitation, defaults, an org variable, the audit log, Leave refused for the last owner; a transfer into the org landing on its General; screenshots at 1440 and 390 px, night and day, with no sideways scroll at 390; deleting the repository, the org; Sign out from the menu to `/login?signed_out=1`, a protected page then sending to sign-in; signing back in with the passkey and deleting the account. Screenshots: `exp/settings-pages/`.

Found on the way and fixed: React resets a form after its action to the fields' `defaultValue`, which a server action does not refresh, so a saved settings form showed the old values and the next Save sent them back (a repository description vanished when the repository was renamed next) and a refused form lost what was typed; `components/settings/use-saved-form.ts` keeps the last submitted fields for the profile, repository General, Visibility, Actions and org General and defaults forms.
