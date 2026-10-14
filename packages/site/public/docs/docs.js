// Gitstalk docs behaviour. Four jobs:
//  1. NAV: the left nav is generated from the one list below (writers never edit nav per page).
//     Each page keeps a static copy of the nav as a no-JS fallback; this replaces it.
//  2. The nav is a <details> served closed. docs.css shows its content on wide screens through
//     ::details-content; a browser without that pseudo-element opens it here instead (wide only).
//  3. Copy buttons for <div class="cmd" data-copyable> blocks (site.js does the copying, and
//     builds the agent tabs; this only adds the button to blocks that are not agent tabs).
//  4. ON THIS PAGE: a table of contents built from the article's h2 and h3 headings, with a hover
//     # link on each heading. Right-hand column from 1200px, an "On this page" disclosure above the
//     article below that. Pages with fewer than 3 headings (and the kit) get none; without
//     JavaScript there is no TOC and the page reads the same.

// `status` is optional: 'live' | 'beta' | 'planned' draws a small dot after the title.
const DOCS_NAV = [
  { section: 'Start', file: 'index.html', title: 'Overview' },
  { section: 'Start', file: 'quickstart.html', title: 'Quickstart' },
  { section: 'Start', file: 'concepts.html', title: 'Concepts' },
  { section: 'Start', file: 'account.html', title: 'Accounts, tokens and keys' },
  { section: 'Agents', file: 'agents.html', title: 'Connecting agents' },
  { section: 'Agents', file: 'mcp.html', title: 'MCP tools and scopes' },
  { section: 'Agents', file: 'ask.html', title: 'Ask the repository' },
  { section: 'Agents', file: 'blame.html', title: 'Why this line: blame by bean', status: 'beta' },
  {
    section: 'Agents',
    file: 'cloud-agents.html',
    title: 'Cloud agents and sandboxes',
    status: 'planned',
  },
  {
    section: 'Agents',
    file: 'streaming-diffs.html',
    title: 'Live updates and streaming diffs',
    status: 'beta',
  },
  { section: 'Repositories', file: 'repositories.html', title: 'Repositories' },
  { section: 'Repositories', file: 'git.html', title: 'Git compatibility' },
  { section: 'Repositories', file: 'checks.html', title: 'Checks' },
  { section: 'Repositories', file: 'approval-rules.html', title: 'Approval rules' },
  { section: 'Repositories', file: 'decisions.html', title: 'Decision cards and reconcile' },
  { section: 'Repositories', file: 'collaborators.html', title: 'Collaborators and visibility' },
  { section: 'Repositories', file: 'organizations.html', title: 'Organizations' },
  { section: 'Repositories', file: 'settings.html', title: 'Settings map' },
  { section: 'Actions and automations', file: 'actions.html', title: 'GitHub Actions' },
  { section: 'Actions and automations', file: 'runners.html', title: 'Runners: where jobs run' },
  { section: 'Actions and automations', file: 'dependency-cache.html', title: 'Dependency cache' },
  { section: 'Actions and automations', file: 'secrets.html', title: 'Secrets and variables' },
  {
    section: 'Actions and automations',
    file: 'environment-variables.html',
    title: 'Environment variables',
  },
  { section: 'Actions and automations', file: 'automations.html', title: 'Automations' },
  {
    section: 'Actions and automations',
    file: 'automation-builder.html',
    title: 'Automation builder and templates',
  },
  { section: 'Actions and automations', file: 'limits.html', title: 'Limits and plans' },
  { section: 'Run it yourself', file: 'self-hosting.html', title: 'Self-hosting and custom hosts' },
  { section: 'Run it yourself', file: 'troubleshooting.html', title: 'Troubleshooting' },
  { section: 'How it works', file: 'architecture.html', title: 'Architecture' },
  { section: 'How it works', file: 'research.html', title: 'What did not work' },
];
const STATUS_DOT = { live: 'live', beta: 'rolling', planned: 'soon' };
const STATUS_LABEL = { live: 'live', beta: 'beta', planned: 'planned' };

/** Clean root-absolute URL for a file name, as the static host serves it. */
function docsUrl(file) {
  return file === 'index.html' ? '/docs/' : `/docs/${file.replace(/\.html$/, '')}`;
}

function esc(text) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

function buildDocsNav(nav) {
  const path = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  const here = path.replace(/\/$/, '') === '/docs' ? '/docs/' : path;
  const inner = nav.querySelector('nav.inner');
  if (!inner) return;
  let html = '';
  let section = null;
  let current = null;
  for (const item of DOCS_NAV) {
    if (item.section !== section) {
      if (section !== null) html += '</ul>';
      section = item.section;
      html += `<h2>${esc(section)}</h2><ul>`;
    }
    const url = docsUrl(item.file);
    const isHere = url === here;
    if (isHere) current = item.title;
    const dot = item.status
      ? `<span class="st ${STATUS_DOT[item.status] ?? 'live'}" title="${STATUS_LABEL[item.status]}"></span>`
      : '';
    html += `<li><a href="${url}"${isHere ? ' aria-current="page"' : ''}>${esc(item.title)}${dot}</a></li>`;
  }
  html += '</ul>';
  html +=
    '<p class="legend"><span><i class="st live"></i>live</span><span><i class="st rolling"></i>beta</span><span><i class="st soon"></i>planned</span></p>';
  inner.innerHTML = html;
  const summary = nav.querySelector('summary');
  if (summary && current) summary.textContent = `Docs: ${current}`;
}

const docsNav = document.querySelector('details.dnav');
const wide = matchMedia('(min-width: 901px)');

if (docsNav) {
  buildDocsNav(docsNav);
  if (!CSS.supports('selector(::details-content)')) {
    const fitNav = () => {
      docsNav.open = wide.matches;
    };
    fitNav();
    wide.addEventListener('change', fitNav);
  }
}

// Copy buttons on plain code blocks. site.js handles clicks on [data-copy] and the hint line.
document.querySelectorAll('.cmd[data-copyable]').forEach((block, index) => {
  const pre = block.querySelector('pre');
  if (!pre || block.querySelector('[data-copy]')) return;
  pre.id = pre.id || `copy-code-${index}`;
  pre.tabIndex = 0;
  let header = block.querySelector('header');
  if (!header) {
    header = document.createElement('header');
    header.innerHTML = '<span></span>';
    block.prepend(header);
  }
  header.insertAdjacentHTML(
    'beforeend',
    `<button type="button" class="btn small copy" data-copy="#${pre.id}" aria-label="Copy this code">Copy</button>`,
  );
  pre.insertAdjacentHTML('afterend', '<p class="copyhint" role="status"></p>');
});

// ---------- On this page ----------
const TOC_MIN_HEADINGS = 3;
const TOC_WIDE = matchMedia('(min-width: 1200px)');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
/** Headings that belong to a component (steps, cards, mocks, callouts), not to the page outline. */
const TOC_SKIP = '.steps, .fgrid, .fcard, .mock, figure, aside, .install, .callout, .note';

/** URL-safe id from heading text: lower case, words joined by hyphens. */
function slugify(text) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** The heading's text without its badges, pills or anchor link. */
function headingText(heading) {
  const copy = heading.cloneNode(true);
  copy.querySelectorAll('.badge, .pill, .anchor').forEach((el) => el.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * The id a heading is linked by: its own; else that of the section it opens (research findings
 * carry the id on the section); else a slug of its text, de-duplicated against the page.
 */
function headingTarget(heading) {
  if (heading.id) return heading;
  const parent = heading.parentElement;
  if (parent && parent.tagName === 'SECTION' && parent.id && parent.firstElementChild === heading) {
    return parent;
  }
  const base = slugify(headingText(heading));
  let id = base;
  for (let n = 2; document.getElementById(id); n += 1) id = `${base}-${n}`;
  heading.id = id;
  return heading;
}

function tocEntries(article) {
  return [...article.querySelectorAll('h2, h3')]
    .filter((heading) => !heading.closest(TOC_SKIP))
    .map((heading) => ({
      heading,
      target: headingTarget(heading),
      level: heading.tagName === 'H3' ? 3 : 2,
      text: headingText(heading),
    }));
}

function addAnchor(entry) {
  const link = document.createElement('a');
  link.className = 'anchor';
  link.href = `#${entry.target.id}`;
  link.setAttribute('aria-label', `Link to this section: ${entry.text}`);
  link.textContent = '#';
  entry.heading.append(link);
}

/** The TOC markup: h3 items nest under the h2 before them. */
function tocHtml(entries) {
  let html = '<ul>';
  let inSub = false;
  entries.forEach((entry, index) => {
    if (entry.level === 3 && !inSub && index > 0) {
      html = html.replace(/<\/li>$/, '');
      html += '<ul>';
      inSub = true;
    } else if (entry.level === 2 && inSub) {
      html += '</ul></li>';
      inSub = false;
    }
    html += `<li><a href="#${entry.target.id}">${esc(entry.text)}</a></li>`;
  });
  if (inSub) html += '</ul></li>';
  return `${html}</ul>`;
}

/** Scrolls to a section, respecting reduced motion, and records it in the URL without a jump. */
function goToSection(target) {
  target.scrollIntoView({ behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth', block: 'start' });
  history.pushState(null, '', `#${target.id}`);
  const focusable = target.matches('h2, h3') ? target : (target.querySelector('h2, h3') ?? target);
  focusable.tabIndex = -1;
  focusable.focus({ preventScroll: true });
}

/** A heading above this line (px from the top) is being read: a TOC jump puts it at about 152px (scroll-padding plus scroll-margin). */
const TOC_LINE = 160;

/** Marks the section in view: the last heading that has crossed TOC_LINE. */
function trackCurrent(entries, links) {
  let current = null;
  const pick = () => {
    let active = entries[0];
    for (const entry of entries) {
      if (entry.target.getBoundingClientRect().top <= TOC_LINE + 1) active = entry;
    }
    const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    if (atEnd) active = entries[entries.length - 1];
    if (active === current) return;
    current = active;
    links.forEach((link) => {
      if (link.hash === `#${active.target.id}`) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };
  const observer = new IntersectionObserver(pick, { rootMargin: `-${TOC_LINE}px 0px 0px 0px` });
  entries.forEach((entry) => observer.observe(entry.target));
  document.addEventListener('scrollend', pick, { passive: true });
  pick();
}

function buildToc() {
  const layout = document.querySelector('.docs');
  const article = layout?.querySelector('article.doc');
  if (!article || /\/_[^/]*$/.test(location.pathname.replace(/\.html$/, ''))) return;
  const entries = tocEntries(article);
  if (entries.length < TOC_MIN_HEADINGS) return;
  entries.forEach(addAnchor);

  const toc = document.createElement('details');
  toc.className = 'toc';
  toc.innerHTML = `<summary>On this page</summary><nav aria-label="On this page"><p class="toc-title" aria-hidden="true">On this page</p>${tocHtml(entries)}</nav>`;
  article.before(toc);
  layout.classList.add('has-toc');

  if (!CSS.supports('selector(::details-content)')) {
    const fitToc = () => {
      toc.open = TOC_WIDE.matches;
    };
    fitToc();
    TOC_WIDE.addEventListener('change', fitToc);
  }

  const links = [...toc.querySelectorAll('a')];
  const byId = new Map(entries.map((entry) => [entry.target.id, entry.target]));
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href^="#"]');
    if (!link || !(toc.contains(link) || link.classList.contains('anchor'))) return;
    const target = byId.get(decodeURIComponent(link.hash.slice(1)));
    if (!target || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    goToSection(target);
    if (!TOC_WIDE.matches && toc.contains(link)) toc.open = false;
  });
  trackCurrent(entries, links);
  // A link to a generated id: the browser looked for it before this script made it.
  const linked = byId.get(decodeURIComponent(location.hash.slice(1)));
  if (linked && linked !== entries[0].target) linked.scrollIntoView();
}

buildToc();
