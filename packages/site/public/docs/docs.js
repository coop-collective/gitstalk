// Gitstalk docs behaviour. Three jobs:
//  1. NAV: the left nav is generated from the one list below (writers never edit nav per page).
//     Each page keeps a static copy of the nav as a no-JS fallback; this replaces it.
//  2. The nav is a <details> served closed. docs.css shows its content on wide screens through
//     ::details-content; a browser without that pseudo-element opens it here instead (wide only).
//  3. Copy buttons for <div class="cmd" data-copyable> blocks (site.js does the copying, and
//     builds the agent tabs; this only adds the button to blocks that are not agent tabs).

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
