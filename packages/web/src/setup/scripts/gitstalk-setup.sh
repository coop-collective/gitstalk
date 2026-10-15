#!/bin/sh
# Gitstalk setup: connect this machine's git to a Gitstalk account, once.
# Run by /gitstalk:setup in Claude Code (and by other agents, or a person, directly).
#
#   gitstalk-setup.sh detect                      what keys and tools this machine has
#   gitstalk-setup.sh generate [--file PATH]      make an ed25519 key for Gitstalk
#   gitstalk-setup.sh register (--key PUB | --agent-key FINGERPRINT [--agent SOCKET]) [--no-browser]
#                                                  add the key to your account (browser approval)
#   gitstalk-setup.sh remote OWNER/REPO [DIR]     clone it, or point an existing clone at Gitstalk
#   gitstalk-setup.sh create [OWNER/]NAME [--public] [--start ID] [--description TEXT]
#                                                  create a repository (private unless --public),
#                                                  then connect it as remote does
#   gitstalk-setup.sh verify [OWNER/REPO]         prove git reaches your account (and the repo)
#   gitstalk-setup.sh host [URL | --reset]        show, save or forget this machine's Gitstalk host
#                                                  (self-hosted, local or staging)
#
# Needs only sh, curl, git and OpenSSH (ssh-keygen >= 8.0). Private keys never leave this
# machine: only the public key is sent. Secrets are never printed. Settings:
#   GITSTALK_WEB                 the Gitstalk web app for this run; else the host saved with
#                                 `host URL` (<config>/gitstalk/host); else https://gitstalk.io
#   GITSTALK_CREDENTIAL_HELPER   git credential helper for the Gitstalk host (default: the one
#                                 git already uses, else the OS store, else "store")
#   GITSTALK_NO_BROWSER=1        never open a browser; show a code to enter on another device
# Each is also read under its name from before the rename (BEANSTALK_WEB, ...) when unset.
set -u

GITSTALK_WEB=${GITSTALK_WEB:-${BEANSTALK_WEB:-}}
GITSTALK_CREDENTIAL_HELPER=${GITSTALK_CREDENTIAL_HELPER:-${BEANSTALK_CREDENTIAL_HELPER:-}}
GITSTALK_NO_BROWSER=${GITSTALK_NO_BROWSER:-${BEANSTALK_NO_BROWSER:-}}

DEFAULT_WEB=https://gitstalk.io
DEFAULT_MCP_URL=https://mcp.gitstalk.io/mcp
CONFIG_ROOT=${XDG_CONFIG_HOME:-$HOME/.config}
CONFIG_DIR=$CONFIG_ROOT/gitstalk
# A machine set up before the rename keeps its remembered key where it was.
[ ! -d "$CONFIG_DIR" ] && [ -d "$CONFIG_ROOT/beanstalk" ] && CONFIG_DIR=$CONFIG_ROOT/beanstalk
HOST_FILE=$CONFIG_DIR/host

# The web app: GITSTALK_WEB, else the host saved with `host URL`, else the hosted service.
saved_host() { [ -f "$HOST_FILE" ] && sed -n '1{s/[[:space:]]*$//;p;}' "$HOST_FILE"; }
if [ -n "$GITSTALK_WEB" ]; then
  WEB=$GITSTALK_WEB WEB_SOURCE=GITSTALK_WEB
elif WEB=$(saved_host) && [ -n "$WEB" ]; then
  WEB_SOURCE="saved in $HOST_FILE"
else
  WEB=$DEFAULT_WEB WEB_SOURCE=default
fi
WEB=${WEB%/}

say() { printf '%s\n' "$*"; }
warn() { printf 'gitstalk: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

# --- this deployment ------------------------------------------------------------------------

load_config() {
  [ -n "${GIT_ORIGIN:-}" ] && return 0
  config=$(curl -fsS --max-time 20 "$WEB/api/setup") || die "cannot reach $WEB (check GITSTALK_WEB, the saved host and the network)"
  GIT_ORIGIN=$(json_field "$config" git_origin)
  SSH_HOST=$(json_field "$config" ssh_host)
  MCP_URL=$(json_field "$config" mcp_url)
  [ -n "$GIT_ORIGIN" ] || die "$WEB/api/setup did not name a git origin"
  GIT_PROTO=${GIT_ORIGIN%%://*}
  GIT_HOST=${GIT_ORIGIN#*://}
  GIT_HOST=${GIT_HOST%%/*}
}

# A string field of a flat JSON object (our own API's answers: no escapes, no nesting).
json_field() {
  printf '%s' "$1" | tr -d '\n' | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"
}

json_number() {
  printf '%s' "$1" | tr -d '\n' | sed -n "s/.*\"$2\":\\([0-9][0-9]*\\).*/\\1/p"
}

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r')"
}

machine_name() {
  name=$(hostname -s 2>/dev/null || uname -n 2>/dev/null || echo terminal)
  printf '%s' "${name%%.*}"
}

platform() {
  case $(uname -s 2>/dev/null) in
    Darwin) echo macos ;;
    Linux) if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi ;;
    MINGW* | MSYS* | CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}

# --- keys -----------------------------------------------------------------------------------

fingerprint_of_line() {
  tmp=$(mktemp) || return 1
  printf '%s\n' "$1" >"$tmp"
  ssh-keygen -lf "$tmp" 2>/dev/null | awk '{print $2}'
  rm -f "$tmp"
}

onepassword_socket() {
  for sock in "$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" "$HOME/.1password/agent.sock"; do
    [ -S "$sock" ] && { printf '%s' "$sock"; return 0; }
  done
  return 1
}

# One "option" line per key an agent offers: option <TAB> source <TAB> fingerprint <TAB> type <TAB> comment <TAB> socket
agent_options() {
  source_name=$1
  sock=$2
  SSH_AUTH_SOCK=$sock ssh-add -L 2>/dev/null | while IFS= read -r line; do
    case $line in ssh-* | ecdsa-*) ;; *) continue ;; esac
    fp=$(fingerprint_of_line "$line")
    type=${line%% *}
    rest=${line#* }
    comment=${rest#* }
    [ "$comment" = "$rest" ] && comment=
    printf 'option\t%s\t%s\t%s\t%s\t%s\n' "$source_name" "$fp" "$type" "$comment" "$sock"
  done
}

# One line when this host's MCP server is not the one the plugin uses by default and the
# person has not saved it with `host` (which prints how to point Claude Code at it).
mcp_hint() {
  [ -n "${MCP_URL:-}" ] && [ "$MCP_URL" != "$DEFAULT_MCP_URL" ] || return 0
  [ -f "$CONFIG_DIR/mcp_url" ] && [ "$(cat "$CONFIG_DIR/mcp_url")" = "$MCP_URL" ] && return 0
  say "mcp: this host's MCP server is $MCP_URL; in Claude Code run /gitstalk:host $WEB (then restart Claude Code and run /mcp to sign in)"
}

cmd_detect() {
  say "platform: $(platform)"
  say "web: $WEB ($WEB_SOURCE)"
  version=$(ssh -V 2>&1 | head -n 1)
  if command -v ssh-keygen >/dev/null 2>&1; then
    say "ssh_keygen: yes ($version)"
  else
    say "ssh_keygen: no (install OpenSSH 8.0 or newer)"
  fi
  say "browser: $(browser_opener || echo none)"
  say "headless: $(is_headless && echo yes || echo no)"
  load_config
  say "git_origin: $GIT_ORIGIN"
  say "ssh_host: ${SSH_HOST:-none yet (setup uses HTTPS with a token until SSH is live)}"
  helper=$(git config --get-urlmatch credential.helper "$GIT_PROTO://$GIT_HOST/" 2>/dev/null || true)
  say "credential_helper: ${helper:-none}"
  mcp_hint
  if sock=$(onepassword_socket); then agent_options 1password "$sock"; fi
  if [ -n "${SSH_AUTH_SOCK:-}" ] && [ "${SSH_AUTH_SOCK}" != "${sock:-}" ]; then
    agent_options ssh-agent "$SSH_AUTH_SOCK"
  fi
  for pub in "$HOME"/.ssh/*.pub; do
    [ -f "$pub" ] || continue
    line=$(head -n 1 "$pub")
    case $line in ssh-* | ecdsa-*) ;; *) continue ;; esac
    fp=$(fingerprint_of_line "$line")
    type=${line%% *}
    rest=${line#* }
    comment=${rest#* }
    [ "$comment" = "$rest" ] && comment=
    printf 'option\tfile\t%s\t%s\t%s\t%s\n' "$fp" "$type" "$comment" "$pub"
  done
  printf 'option\tgenerate\t-\tssh-ed25519\ta new key for Gitstalk\t%s\n' "$HOME/.ssh/gitstalk_ed25519"
}

cmd_generate() {
  file=$HOME/.ssh/gitstalk_ed25519
  while [ $# -gt 0 ]; do
    case $1 in
      --file) file=$2; shift 2 ;;
      *) die "generate: unknown option $1" ;;
    esac
  done
  [ -e "$file" ] && die "$file already exists; register it with: register --key $file.pub"
  mkdir -p "$(dirname "$file")" && chmod 700 "$(dirname "$file")"
  load_config
  # No passphrase here (a script cannot type one). To protect it, run afterwards in a terminal:
  #   ssh-keygen -p -f <file>     (and add it to your agent: ssh-add <file>)
  ssh-keygen -q -t ed25519 -N '' -C "gitstalk $(machine_name) $GIT_HOST" -f "$file" || die "ssh-keygen failed"
  say "generated: $file.pub"
  say "fingerprint: $(fingerprint_of_line "$(cat "$file.pub")")"
  say "passphrase: none (to add one: ssh-keygen -p -f $file)"
}

# --- registration ---------------------------------------------------------------------------

browser_opener() {
  [ "${GITSTALK_NO_BROWSER:-}" = 1 ] && return 1
  if [ -n "${BROWSER:-}" ]; then echo "$BROWSER"; return 0; fi
  for opener in open xdg-open wslview; do
    command -v "$opener" >/dev/null 2>&1 && { echo "$opener"; return 0; }
  done
  [ "$(platform)" = windows ] && { echo start; return 0; }
  return 1
}

is_headless() {
  [ -n "${SSH_CONNECTION:-}" ] && return 0
  [ "$(platform)" = linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && return 0
  return 1
}

open_url() {
  opener=$(browser_opener) || return 1
  is_headless && return 1
  case $opener in
    start) cmd.exe /c start "" "$1" >/dev/null 2>&1 ;;
    *) "$opener" "$1" >/dev/null 2>&1 ;;
  esac
}

key_line_for() {
  case $1 in
    file:*)
      file=${1#file:}
      [ -f "$file" ] || die "no public key at $file"
      head -n 1 "$file" ;;
    agent:*)
      want=${1#agent:}
      SSH_AUTH_SOCK=$2 ssh-add -L 2>/dev/null | while IFS= read -r line; do
        [ "$(fingerprint_of_line "$line")" = "$want" ] && { printf '%s\n' "$line"; break; }
      done ;;
  esac
}

cmd_register() {
  key= agent=${SSH_AUTH_SOCK:-} browser=yes
  while [ $# -gt 0 ]; do
    case $1 in
      --key) key=file:$2; shift 2 ;;
      --agent-key) key=agent:$2; shift 2 ;;
      --agent) agent=$2; shift 2 ;;
      --no-browser) browser=no; shift ;;
      *) die "register: unknown option $1" ;;
    esac
  done
  [ -n "$key" ] || die "register: pass --key <file.pub> or --agent-key <fingerprint>"
  line=$(key_line_for "$key" "$agent")
  [ -n "$line" ] || die "that key was not found (is the agent unlocked?)"
  case $line in *PRIVATE*) die "that is a private key; pass the .pub file" ;; esac
  load_config
  remember_key "$key" "$agent" "$line"
  wants_token=false
  [ -z "$SSH_HOST" ] && wants_token=true
  # The token git keeps may also create repositories (the create scope; consent shows it ticked).
  body="{\"public_key\":$(json_string "$line"),\"machine\":$(json_string "$(machine_name)"),\"https_token\":$wants_token,\"scopes\":[\"read\",\"write\",\"create\"]}"
  answer=$(curl -sS --max-time 20 -H 'content-type: application/json' --data "$body" "$WEB/api/ssh-keys/request") || die "cannot reach $WEB"
  code=$(json_field "$answer" user_code)
  [ -n "$code" ] || die "Gitstalk refused the key: $(json_field "$answer" message)"
  poll=$(json_field "$answer" poll_token)
  link=$(json_field "$answer" verification_uri_complete)
  page=$(json_field "$answer" verification_uri)
  expires=$(json_number "$answer" expires_in)
  interval=$(json_number "$answer" interval)
  say "fingerprint: $(json_field "$answer" fingerprint)"
  say "code: $code"
  if [ "$browser" = yes ] && open_url "$link"; then
    say "approve: opened $link in your browser (check the code and fingerprint match, then Add key)"
  else
    say "approve: on any signed-in device, open $page and enter $code"
  fi
  wait_for_approval "$poll" "${expires:-600}" "${interval:-3}"
}

# Where the chosen key is remembered, for setting up SSH once its endpoint is live.
remember_key() {
  mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
  printf '%s\n' "$3" >"$CONFIG_DIR/key.pub"
  case $1 in agent:*) printf '%s\n' "$2" >"$CONFIG_DIR/agent" ;; *) rm -f "$CONFIG_DIR/agent" ;; esac
}

wait_for_approval() {
  waited=0
  while [ "$waited" -lt "$2" ]; do
    sleep "$3"
    waited=$((waited + $3))
    answer=$(curl -sS --max-time 20 -H 'content-type: application/json' \
      --data "{\"poll_token\":\"$1\"}" "$WEB/api/ssh-keys/poll") || continue
    case $(json_field "$answer" status) in
      pending) ;;
      approved)
        handle=$(json_field "$answer" handle)
        say "approved: key added to @$handle"
        token=$(json_field "$answer" https_token)
        [ -n "$token" ] && store_token "$handle" "$token"
        return 0 ;;
      denied) die "the key was declined in the browser; nothing was added" ;;
      *) die "the request expired; run register again" ;;
    esac
  done
  die "no approval within $2 seconds; run register again"
}

# Hands the HTTPS token to git's credential store for the Gitstalk host only.
store_token() {
  origin="$GIT_PROTO://$GIT_HOST/"
  if [ -n "${GITSTALK_CREDENTIAL_HELPER:-}" ]; then
    use_helper "$origin" "$GITSTALK_CREDENTIAL_HELPER"
  elif [ -z "$(git config --get-urlmatch credential.helper "$origin" 2>/dev/null)" ]; then
    use_helper "$origin" "$(os_credential_helper)"
  fi
  printf 'protocol=%s\nhost=%s\n\n' "$GIT_PROTO" "$GIT_HOST" | git credential reject
  printf 'protocol=%s\nhost=%s\nusername=%s\npassword=%s\n\n' "$GIT_PROTO" "$GIT_HOST" "$1" "$2" | git credential approve \
    || die "git could not store the token"
  say "https_token: stored by git's credential helper ($(git config --get-urlmatch credential.helper "$origin"))"
}

# Scopes a helper to the Gitstalk host: the empty value first clears inherited helpers there.
use_helper() {
  git config --global --unset-all "credential.$1.helper" 2>/dev/null
  git config --global --add "credential.$1.helper" ''
  git config --global --add "credential.$1.helper" "$2"
}

os_credential_helper() {
  case $(platform) in
    macos) git credential-osxkeychain 2>&1 | grep -qi usage && { echo osxkeychain; return; } ;;
    windows) git credential-manager --version >/dev/null 2>&1 && { echo manager; return; } ;;
  esac
  git credential-libsecret 2>&1 | grep -qi usage && { echo libsecret; return; }
  echo store
}

# --- remotes and verification ---------------------------------------------------------------

repo_url() {
  if [ -n "$SSH_HOST" ]; then
    printf 'ssh://git@%s/%s.git' "$SSH_HOST" "$1"
  else
    printf '%s/%s.git' "$GIT_ORIGIN" "$1"
  fi
}

# Points ssh at the chosen key for the Gitstalk SSH host only.
write_ssh_config() {
  [ -n "$SSH_HOST" ] && [ -f "$CONFIG_DIR/key.pub" ] || return 0
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/config" && chmod 600 "$HOME/.ssh/config"
  # The marker a setup from before the rename wrote counts too.
  grep -Eq "^# (gitstalk|beanstalk): $SSH_HOST\$" "$HOME/.ssh/config" && return 0
  {
    printf '\n# gitstalk: %s\nHost %s\n  User git\n  IdentityFile "%s"\n  IdentitiesOnly yes\n' \
      "$SSH_HOST" "$SSH_HOST" "$CONFIG_DIR/key.pub"
    [ -f "$CONFIG_DIR/agent" ] && printf '  IdentityAgent "%s"\n' "$(cat "$CONFIG_DIR/agent")"
  } >>"$HOME/.ssh/config"
  say "ssh_config: added Host $SSH_HOST to ~/.ssh/config"
}

cmd_remote() {
  [ $# -ge 1 ] || die "remote: pass OWNER/REPO"
  case $1 in */*) ;; *) die "remote: pass OWNER/REPO" ;; esac
  load_config
  write_ssh_config
  url=$(repo_url "$1")
  dir=${2:-}
  if [ -z "$dir" ] && git rev-parse --git-dir >/dev/null 2>&1; then
    git remote set-url origin "$url" 2>/dev/null || git remote add origin "$url"
    say "remote: origin is $url"
  else
    GIT_TERMINAL_PROMPT=0 git clone -q "$url" ${dir:+"$dir"} || die "clone failed: run verify to see why"
    say "cloned: $url into ${dir:-${1#*/}}"
  fi
  [ -z "$SSH_HOST" ] && say "transport: HTTPS with your token (git over SSH is not live yet; setup switches remotes once it is)"
  return 0
}

# The HTTPS token git keeps for the Gitstalk host, into $token (never printed, never in argv).
stored_token() {
  creds=$(printf 'protocol=%s\nhost=%s\n\n' "$GIT_PROTO" "$GIT_HOST" | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null)
  token=$(printf '%s\n' "$creds" | sed -n 's/^password=//p')
  [ -n "$token" ] || die "git has no credential for $GIT_HOST yet: run register"
}

# The account the stored token acts for, into $handle.
whoami_handle() {
  whoami=$(printf 'user = "x:%s"\n' "$token" | curl -sS --max-time 20 -K - "$GIT_ORIGIN/v1/whoami")
  handle=$(json_field "$whoami" handle)
  [ -n "$handle" ] || die "the gateway refused the stored credential: run register again"
}

cmd_verify() {
  load_config
  stored_token
  whoami_handle
  say "whoami: @$handle"
  mcp_hint
  if [ $# -ge 1 ]; then
    GIT_TERMINAL_PROMPT=0 git ls-remote "$(repo_url "$1")" >/dev/null || die "git ls-remote $1 failed"
    say "ls_remote: $1 ok"
  fi
}

cmd_create() {
  [ $# -ge 1 ] || die "create: pass [OWNER/]NAME"
  full=$1
  shift
  visibility=private start= description=
  while [ $# -gt 0 ]; do
    case $1 in
      --public) visibility=public; shift ;;
      --private) visibility=private; shift ;;
      --start) [ $# -ge 2 ] || die "create: --start needs a starter id"; start=$2; shift 2 ;;
      --description) [ $# -ge 2 ] || die "create: --description needs text"; description=$2; shift 2 ;;
      *) die "create: unknown option $1" ;;
    esac
  done
  load_config
  stored_token
  case $full in
    */*/*) die "create: pass [OWNER/]NAME" ;;
    */*) ;;
    *) whoami_handle; full=$handle/$full ;;
  esac
  owner=${full%%/*}
  name=${full#*/}
  [ -n "$owner" ] && [ -n "$name" ] || die "create: pass [OWNER/]NAME"
  body="{\"name\":$(json_string "$name"),\"owner\":$(json_string "$owner"),\"visibility\":\"$visibility\""
  [ -n "$start" ] && body="$body,\"start\":$(json_string "$start")"
  [ -n "$description" ] && body="$body,\"description\":$(json_string "$description")"
  body="$body}"
  # The token reaches curl on stdin as a config line, never on its command line.
  answer=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS --max-time 30 -K - \
    -H 'content-type: application/json' --data "$body" -w '\n%{http_code}' "$WEB/api/repos") \
    || die "cannot reach $WEB (check GITSTALK_WEB and the network)"
  status=$(printf '%s\n' "$answer" | tail -n 1)
  answer=$(printf '%s\n' "$answer" | sed '$d')
  message=$(json_field "$answer" message)
  case $status in
    201)
      created=$(json_field "$answer" full_name)
      [ -n "$created" ] && full=$created
      say "created: $full ($(json_field "$answer" visibility))"
      say "web: $(json_field "$answer" web_url)"
      next=$(json_field "$answer" next)
      [ -n "$next" ] && say "next: $next" ;;
    409) say "exists: $full already exists; connecting it" ;;
    401) die "the gateway refused the stored credential: run register again" ;;
    403) die "not allowed to create $full${message:+: $message} (a token from before repository creation lacks the create scope: run register again, or create it at $WEB/new)" ;;
    422) die "invalid repository name $name${message:+: $message}" ;;
    *) die "create failed (HTTP $status)${message:+: $message}" ;;
  esac
  cmd_remote "$full"
}

# Saves the host every later run uses (when GITSTALK_WEB is unset), after checking it answers.
cmd_host() {
  case ${1:-} in
    '')
      load_config
      say "web: $WEB ($WEB_SOURCE)"
      say "mcp_url: ${MCP_URL:-none}"
      return 0 ;;
    --reset)
      rm -f "$HOST_FILE" "$CONFIG_DIR/mcp_url"
      say "host: forgotten; $DEFAULT_WEB from now on"
      say "claude_code: printf '%s' '{\"mcp_url\":\"$DEFAULT_MCP_URL\"}' | claude plugin configure gitstalk@gitstalk --values-stdin"
      return 0 ;;
    http://* | https://*) ;;
    *) die "host: pass a URL like https://gitstalk.dev or http://localhost:5173, or --reset" ;;
  esac
  WEB=${1%/}
  load_config
  mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
  if [ "$WEB" = "$DEFAULT_WEB" ]; then
    rm -f "$HOST_FILE" "$CONFIG_DIR/mcp_url"
    say "host: $WEB (the default; nothing saved)"
  else
    printf '%s\n' "$WEB" >"$HOST_FILE"
    if [ -n "$MCP_URL" ]; then printf '%s\n' "$MCP_URL" >"$CONFIG_DIR/mcp_url"; else rm -f "$CONFIG_DIR/mcp_url"; fi
    say "host: saved $WEB in $HOST_FILE"
  fi
  say "git_origin: $GIT_ORIGIN"
  say "mcp_url: ${MCP_URL:-none}"
  [ -n "$MCP_URL" ] && say "claude_code: printf '%s' '{\"mcp_url\":\"$MCP_URL\"}' | claude plugin configure gitstalk@gitstalk --values-stdin"
  [ -n "$GITSTALK_WEB" ] && [ "${GITSTALK_WEB%/}" != "$WEB" ] && say "note: GITSTALK_WEB=$GITSTALK_WEB is set and still wins in this shell"
  return 0
}

case ${1:-} in
  detect) shift; cmd_detect "$@" ;;
  generate) shift; cmd_generate "$@" ;;
  register) shift; cmd_register "$@" ;;
  remote) shift; cmd_remote "$@" ;;
  create) shift; cmd_create "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  host) shift; cmd_host "$@" ;;
  *)
    cat >&2 <<'USAGE'
usage: gitstalk-setup.sh detect
       gitstalk-setup.sh generate [--file PATH]
       gitstalk-setup.sh register (--key FILE.pub | --agent-key SHA256:… [--agent SOCKET]) [--no-browser]
       gitstalk-setup.sh remote OWNER/REPO [DIR]
       gitstalk-setup.sh create [OWNER/]NAME [--public] [--start ID] [--description TEXT]
       gitstalk-setup.sh verify [OWNER/REPO]
       gitstalk-setup.sh host [URL | --reset]
USAGE
    exit 2 ;;
esac
