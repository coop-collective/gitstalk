<#
Gitstalk setup for Windows (PowerShell 5.1 or 7): connect this machine's git to a Gitstalk
account, once. The same commands and output as gitstalk-setup.sh (which Git for Windows' bash
also runs):

  gitstalk-setup.ps1 detect
  gitstalk-setup.ps1 generate [-File PATH]
  gitstalk-setup.ps1 register (-Key FILE.pub | -AgentKey SHA256:... [-Agent SOCKET]) [-NoBrowser]
  gitstalk-setup.ps1 remote OWNER/REPO [DIR]
  gitstalk-setup.ps1 create [OWNER/]NAME [-Public] [-Start ID] [-Description TEXT]
  gitstalk-setup.ps1 verify [OWNER/REPO]
  gitstalk-setup.ps1 host [URL | -Reset]

Needs git and OpenSSH (Windows 10/11's built-in OpenSSH or Git for Windows' ssh-keygen).
Private keys never leave this machine; secrets are never printed. Settings: GITSTALK_WEB (else
the host saved with `host URL`, else https://gitstalk.io), GITSTALK_CREDENTIAL_HELPER,
GITSTALK_NO_BROWSER=1 (as for the sh script).
#>
param(
  [Parameter(Position = 0)][string]$Command = '',
  [Parameter(Position = 1)][string]$Repo = '',
  [Parameter(Position = 2)][string]$Dir = '',
  [string]$File = '',
  [string]$Key = '',
  [string]$AgentKey = '',
  [string]$Agent = '',
  [switch]$NoBrowser,
  [switch]$Public,
  [switch]$Reset,
  [string]$Start = '',
  [string]$Description = ''
)
$ErrorActionPreference = 'Stop'
# Each setting is also read under its name from before the rename (BEANSTALK_*) when unset.
foreach ($name in 'WEB', 'CREDENTIAL_HELPER', 'NO_BROWSER') {
  $legacy = [Environment]::GetEnvironmentVariable("BEANSTALK_$name")
  if (-not [Environment]::GetEnvironmentVariable("GITSTALK_$name") -and $legacy) { Set-Item "env:GITSTALK_$name" $legacy }
}
$DefaultWeb = 'https://gitstalk.io'
$DefaultMcpUrl = 'https://mcp.gitstalk.io/mcp'
$ConfigRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } elseif ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME '.config' }
$ConfigDir = Join-Path $ConfigRoot 'gitstalk'
# A machine set up before the rename keeps its remembered key where it was.
if (-not (Test-Path $ConfigDir) -and (Test-Path (Join-Path $ConfigRoot 'beanstalk'))) { $ConfigDir = Join-Path $ConfigRoot 'beanstalk' }
$HostFile = Join-Path $ConfigDir 'host'
$McpFile = Join-Path $ConfigDir 'mcp_url'
# The web app: GITSTALK_WEB, else the host saved with `host URL`, else the hosted service.
$SavedHost = if (Test-Path $HostFile) { ([string](Get-Content $HostFile -TotalCount 1)).Trim() } else { '' }
if ($env:GITSTALK_WEB) { $Web = $env:GITSTALK_WEB; $WebSource = 'GITSTALK_WEB' }
elseif ($SavedHost) { $Web = $SavedHost; $WebSource = "saved in $HostFile" }
else { $Web = $DefaultWeb; $WebSource = 'default' }
$Web = $Web.TrimEnd('/')
$IsWin = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
$OnePasswordPipe = '\\.\pipe\openssh-ssh-agent'
# An empty argument for native commands: PowerShell 7.3+ passes '' as is; older ones drop it.
$EmptyArg = if ($PSVersionTable.PSVersion -ge [version]'7.3') { '' } else { '""' }

function Say([string]$Text) { Write-Output $Text }
function Fail([string]$Text) { [Console]::Error.WriteLine("gitstalk: $Text"); exit 1 }

function Get-SetupConfig {
  try { $config = Invoke-RestMethod -Uri "$Web/api/setup" -TimeoutSec 20 } catch { Fail "cannot reach $Web (check GITSTALK_WEB, the saved host and the network)" }
  if (-not $config.git_origin) { Fail "$Web/api/setup did not name a git origin" }
  $origin = $config.git_origin.TrimEnd('/')
  $uri = [Uri]$origin
  [pscustomobject]@{
    Origin = $origin
    Proto = $uri.Scheme
    Host = $uri.Authority
    SshHost = if ($config.ssh_host) { [string]$config.ssh_host } else { '' }
    McpUrl = if ($config.mcp_url) { [string]$config.mcp_url } else { '' }
  }
}

function Get-Platform {
  if ($IsWin) { return 'windows' }
  if ($IsMacOS) { return 'macos' }
  return 'linux'
}

function Get-MachineName { ([Environment]::MachineName -split '\.')[0] }

function Get-Fingerprint([string]$Line) {
  $tmp = [IO.Path]::GetTempFileName()
  try {
    Set-Content -Path $tmp -Value $Line -NoNewline:$false
    ((& ssh-keygen -lf $tmp 2>$null) -split ' ')[1]
  } finally { Remove-Item $tmp -Force }
}

function Get-OnePasswordSocket {
  if ($IsWin) { if (Test-Path $OnePasswordPipe) { return $OnePasswordPipe } else { return $null } }
  foreach ($sock in @((Join-Path $HOME 'Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock'), (Join-Path $HOME '.1password/agent.sock'))) {
    if (Test-Path $sock) { return $sock }
  }
  return $null
}

function Get-AgentLines([string]$Socket) {
  $saved = $env:SSH_AUTH_SOCK
  try {
    if (-not $IsWin) { $env:SSH_AUTH_SOCK = $Socket }
    @(& ssh-add -L 2>$null) | Where-Object { $_ -match '^(ssh-|ecdsa-)' }
  } catch { @() } finally { $env:SSH_AUTH_SOCK = $saved }
}

function Write-Option([string]$Source, [string]$Line, [string]$Where) {
  $parts = $Line -split ' ', 3
  $comment = if ($parts.Count -gt 2) { $parts[2] } else { '' }
  Say ("option`t{0}`t{1}`t{2}`t{3}`t{4}" -f $Source, (Get-Fingerprint $Line), $parts[0], $comment, $Where)
}

# One line when this host's MCP server is not the one the plugin uses by default and the
# person has not saved it with `host` (which prints how to point Claude Code at it).
function Write-McpHint($Config) {
  if (-not $Config.McpUrl -or $Config.McpUrl -eq $DefaultMcpUrl) { return }
  if ((Test-Path $McpFile) -and ([string](Get-Content $McpFile -TotalCount 1)).Trim() -eq $Config.McpUrl) { return }
  Say "mcp: this host's MCP server is $($Config.McpUrl); in Claude Code run /gitstalk:host $Web (then restart Claude Code and run /mcp to sign in)"
}

function Write-ClaudeCodeLine([string]$McpUrl) {
  Say ("claude_code: printf '%s' '{{""mcp_url"":""{0}""}}' | claude plugin configure gitstalk@gitstalk --values-stdin" -f $McpUrl)
}

function Invoke-Detect {
  Say "platform: $(Get-Platform)"
  Say "web: $Web ($WebSource)"
  $keygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue
  if ($keygen) { Say "ssh_keygen: yes ($((& ssh -V 2>&1 | Select-Object -First 1)))" } else { Say 'ssh_keygen: no (install OpenSSH: Settings > Optional features, or Git for Windows)' }
  $opener = Get-BrowserOpener
  Say "browser: $(if ($opener) { $opener } else { 'none' })"
  Say "headless: $(if (Test-Headless) { 'yes' } else { 'no' })"
  $config = Get-SetupConfig
  Say "git_origin: $($config.Origin)"
  Say "ssh_host: $(if ($config.SshHost) { $config.SshHost } else { 'none yet (setup uses HTTPS with a token until SSH is live)' })"
  $helper = & git config --get-urlmatch credential.helper "$($config.Proto)://$($config.Host)/" 2>$null
  Say "credential_helper: $(if ($helper) { $helper } else { 'none' })"
  Write-McpHint $config
  $op = Get-OnePasswordSocket
  if ($op) { foreach ($line in Get-AgentLines $op) { Write-Option '1password' $line $op } }
  if ($env:SSH_AUTH_SOCK -and $env:SSH_AUTH_SOCK -ne $op) {
    foreach ($line in Get-AgentLines $env:SSH_AUTH_SOCK) { Write-Option 'ssh-agent' $line $env:SSH_AUTH_SOCK }
  }
  foreach ($pub in Get-ChildItem -Path (Join-Path $HOME '.ssh') -Filter '*.pub' -ErrorAction SilentlyContinue) {
    $line = Get-Content $pub.FullName -TotalCount 1
    if ($line -match '^(ssh-|ecdsa-)') { Write-Option 'file' $line $pub.FullName }
  }
  Say ("option`tgenerate`t-`tssh-ed25519`ta new key for Gitstalk`t{0}" -f (Join-Path $HOME '.ssh/gitstalk_ed25519'))
}

function Invoke-Generate {
  $path = if ($File) { $File } else { Join-Path $HOME '.ssh/gitstalk_ed25519' }
  if (Test-Path $path) { Fail "$path already exists; register it with: register -Key $path.pub" }
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $config = Get-SetupConfig
  # No passphrase (a script cannot type one); add one later with: ssh-keygen -p -f <file>
  & ssh-keygen -q -t ed25519 -N $EmptyArg -C "gitstalk $(Get-MachineName) $($config.Host)" -f $path
  if ($LASTEXITCODE -ne 0) { Fail 'ssh-keygen failed' }
  Say "generated: $path.pub"
  Say "fingerprint: $(Get-Fingerprint (Get-Content "$path.pub" -TotalCount 1))"
  Say "passphrase: none (to add one: ssh-keygen -p -f $path)"
}

function Get-BrowserOpener {
  if ($env:GITSTALK_NO_BROWSER -eq '1') { return $null }
  if ($env:BROWSER) { return $env:BROWSER }
  if ($IsWin) { return 'start' }
  foreach ($opener in 'open', 'xdg-open', 'wslview') { if (Get-Command $opener -ErrorAction SilentlyContinue) { return $opener } }
  return $null
}

function Test-Headless {
  if ($env:SSH_CONNECTION) { return $true }
  if ((Get-Platform) -eq 'linux' -and -not ($env:DISPLAY -or $env:WAYLAND_DISPLAY)) { return $true }
  return $false
}

function Open-Url([string]$Url) {
  $opener = Get-BrowserOpener
  if (-not $opener -or (Test-Headless)) { return $false }
  if ($opener -eq 'start') { Start-Process $Url } else { & $opener $Url *> $null }
  return $true
}

function Get-KeyLine {
  if ($Key) {
    if (-not (Test-Path $Key)) { Fail "no public key at $Key" }
    return (Get-Content $Key -TotalCount 1)
  }
  $socket = if ($Agent) { $Agent } else { $env:SSH_AUTH_SOCK }
  foreach ($line in Get-AgentLines $socket) { if ((Get-Fingerprint $line) -eq $AgentKey) { return $line } }
  return $null
}

function Invoke-Register {
  if (-not $Key -and -not $AgentKey) { Fail 'register: pass -Key <file.pub> or -AgentKey <fingerprint>' }
  $line = Get-KeyLine
  if (-not $line) { Fail 'that key was not found (is the agent unlocked?)' }
  if ($line -match 'PRIVATE') { Fail 'that is a private key; pass the .pub file' }
  $config = Get-SetupConfig
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  Set-Content -Path (Join-Path $ConfigDir 'key.pub') -Value $line
  if ($AgentKey) { Set-Content -Path (Join-Path $ConfigDir 'agent') -Value $(if ($Agent) { $Agent } else { $env:SSH_AUTH_SOCK }) }
  # The token git keeps may also create repositories (the create scope; consent shows it ticked).
  $body = @{ public_key = $line; machine = (Get-MachineName); https_token = (-not $config.SshHost); scopes = @('read', 'write', 'create') } | ConvertTo-Json -Compress
  try { $answer = Invoke-RestMethod -Method Post -Uri "$Web/api/ssh-keys/request" -ContentType 'application/json' -Body $body -TimeoutSec 20 }
  catch { Fail "Gitstalk refused the key: $($_.ErrorDetails.Message)" }
  Say "fingerprint: $($answer.fingerprint)"
  Say "code: $($answer.user_code)"
  if (-not $NoBrowser -and (Open-Url $answer.verification_uri_complete)) {
    Say "approve: opened $($answer.verification_uri_complete) in your browser (check the code and fingerprint match, then Add key)"
  } else {
    Say "approve: on any signed-in device, open $($answer.verification_uri) and enter $($answer.user_code)"
  }
  Wait-Approval $answer $config
}

function Wait-Approval($Answer, $Config) {
  $deadline = (Get-Date).AddSeconds([int]$Answer.expires_in)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds ([int]$Answer.interval)
    try { $poll = Invoke-RestMethod -Method Post -Uri "$Web/api/ssh-keys/poll" -ContentType 'application/json' -Body (@{ poll_token = $Answer.poll_token } | ConvertTo-Json -Compress) -TimeoutSec 20 } catch { continue }
    switch ($poll.status) {
      'pending' { }
      'approved' {
        Say "approved: key added to @$($poll.handle)"
        if ($poll.https_token) { Save-Token $Config $poll.handle $poll.https_token }
        return
      }
      'denied' { Fail 'the key was declined in the browser; nothing was added' }
      default { Fail 'the request expired; run register again' }
    }
  }
  Fail 'no approval in time; run register again'
}

function Save-Token($Config, [string]$Handle, [string]$Token) {
  $origin = "$($Config.Proto)://$($Config.Host)/"
  $helper = $env:GITSTALK_CREDENTIAL_HELPER
  if (-not $helper -and -not (& git config --get-urlmatch credential.helper $origin 2>$null)) { $helper = Get-OsCredentialHelper }
  if ($helper) {
    # Scoped to the Gitstalk host: the empty value first clears inherited helpers there.
    & git config --global --unset-all "credential.$origin.helper" 2>$null
    & git config --global --add "credential.$origin.helper" $EmptyArg
    & git config --global --add "credential.$origin.helper" $helper
  }
  "protocol=$($Config.Proto)`nhost=$($Config.Host)`n`n" | & git credential reject
  "protocol=$($Config.Proto)`nhost=$($Config.Host)`nusername=$Handle`npassword=$Token`n`n" | & git credential approve
  if ($LASTEXITCODE -ne 0) { Fail 'git could not store the token' }
  Say "https_token: stored by git's credential helper ($(& git config --get-urlmatch credential.helper $origin))"
}

function Get-OsCredentialHelper {
  if ($IsWin) { & git credential-manager --version *> $null; if ($LASTEXITCODE -eq 0) { return 'manager' } }
  if ($IsMacOS) { return 'osxkeychain' }
  return 'store'
}

function Get-RepoUrl($Config, [string]$Name) {
  if ($Config.SshHost) { return "ssh://git@$($Config.SshHost)/$Name.git" }
  return "$($Config.Origin)/git/$Name.git"
}

function Invoke-Remote {
  if ($Repo -notmatch '^[^/]+/[^/]+$') { Fail 'remote: pass OWNER/REPO' }
  $config = Get-SetupConfig
  $url = Get-RepoUrl $config $Repo
  $env:GIT_TERMINAL_PROMPT = '0'
  & git rev-parse --git-dir *> $null
  if (-not $Dir -and $LASTEXITCODE -eq 0) {
    & git remote set-url origin $url 2>$null
    if ($LASTEXITCODE -ne 0) { & git remote add origin $url }
    Say "remote: origin is $url"
  } else {
    if ($Dir) { & git clone -q $url $Dir } else { & git clone -q $url }
    if ($LASTEXITCODE -ne 0) { Fail 'clone failed: run verify to see why' }
    Say "cloned: $url into $(if ($Dir) { $Dir } else { ($Repo -split '/')[1] })"
  }
  if (-not $config.SshHost) { Say 'transport: HTTPS with your token (git over SSH is not live yet; setup switches remotes once it is)' }
}

# The HTTPS token git keeps for the Gitstalk host (never printed, never on a command line).
function Get-StoredToken($Config) {
  $env:GIT_TERMINAL_PROMPT = '0'
  $creds = "protocol=$($Config.Proto)`nhost=$($Config.Host)`n`n" | & git credential fill 2>$null
  $token = ($creds | Where-Object { $_ -like 'password=*' } | Select-Object -First 1) -replace '^password=', ''
  if (-not $token) { Fail "git has no credential for $($Config.Host) yet: run register" }
  return $token
}

function Get-Handle($Config, [string]$Token) {
  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("x:$Token"))
  try { $whoami = Invoke-RestMethod -Uri "$($Config.Origin)/v1/whoami" -Headers @{ Authorization = "Basic $basic" } -TimeoutSec 20 }
  catch { Fail 'the gateway refused the stored credential: run register again' }
  return [string]$whoami.handle
}

function Invoke-Verify {
  $config = Get-SetupConfig
  $token = Get-StoredToken $config
  Say "whoami: @$(Get-Handle $config $token)"
  Write-McpHint $config
  if ($Repo) {
    & git ls-remote (Get-RepoUrl $config $Repo) *> $null
    if ($LASTEXITCODE -ne 0) { Fail "git ls-remote $Repo failed" }
    Say "ls_remote: $Repo ok"
  }
}

function Invoke-Create {
  if ($Repo -notmatch '^[^/]+(/[^/]+)?$') { Fail 'create: pass [OWNER/]NAME' }
  $config = Get-SetupConfig
  $token = Get-StoredToken $config
  if ($Repo -notmatch '/') { $script:Repo = "$(Get-Handle $config $token)/$Repo" }
  $owner, $name = $script:Repo -split '/', 2
  $request = [ordered]@{ name = $name; owner = $owner; visibility = $(if ($Public) { 'public' } else { 'private' }) }
  if ($Start) { $request.start = $Start }
  if ($Description) { $request.description = $Description }
  $body = $request | ConvertTo-Json -Compress
  $status = 0
  $content = ''
  try {
    $response = Invoke-WebRequest -Method Post -Uri "$Web/api/repos" -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 30
    $status = [int]$response.StatusCode
    $content = $response.Content
  } catch {
    if (-not $_.Exception.Response) { Fail "cannot reach $Web (check GITSTALK_WEB and the network)" }
    $status = [int]$_.Exception.Response.StatusCode
    $content = $_.ErrorDetails.Message
  }
  $answer = $null
  try { $answer = $content | ConvertFrom-Json } catch { }
  $message = if ($answer -and $answer.message) { ": $($answer.message)" } else { '' }
  switch ($status) {
    201 {
      if ($answer.full_name) { $script:Repo = [string]$answer.full_name }
      Say "created: $($script:Repo) ($($answer.visibility))"
      Say "web: $($answer.web_url)"
      if ($answer.next -is [string] -and $answer.next) { Say "next: $($answer.next)" }
    }
    409 { Say "exists: $($script:Repo) already exists; connecting it" }
    401 { Fail 'the gateway refused the stored credential: run register again' }
    403 { Fail "not allowed to create $($script:Repo)$message (a token from before repository creation lacks the create scope: run register again, or create it at $Web/new)" }
    422 { Fail "invalid repository name $name$message" }
    default { Fail "create failed (HTTP $status)$message" }
  }
  Invoke-Remote
}

# Saves the host every later run uses (when GITSTALK_WEB is unset), after checking it answers.
function Invoke-Host {
  if ($Reset) {
    Remove-Item $HostFile, $McpFile -Force -ErrorAction SilentlyContinue
    Say "host: forgotten; $DefaultWeb from now on"
    Write-ClaudeCodeLine $DefaultMcpUrl
    return
  }
  if (-not $Repo) {
    $config = Get-SetupConfig
    Say "web: $Web ($WebSource)"
    Say "mcp_url: $(if ($config.McpUrl) { $config.McpUrl } else { 'none' })"
    return
  }
  if ($Repo -notmatch '^https?://') { Fail 'host: pass a URL like https://gitstalk.dev or http://localhost:5173, or -Reset' }
  $script:Web = $Repo.TrimEnd('/')
  $config = Get-SetupConfig
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  if ($script:Web -eq $DefaultWeb) {
    Remove-Item $HostFile, $McpFile -Force -ErrorAction SilentlyContinue
    Say "host: $($script:Web) (the default; nothing saved)"
  } else {
    Set-Content -Path $HostFile -Value $script:Web
    if ($config.McpUrl) { Set-Content -Path $McpFile -Value $config.McpUrl } else { Remove-Item $McpFile -Force -ErrorAction SilentlyContinue }
    Say "host: saved $($script:Web) in $HostFile"
  }
  Say "git_origin: $($config.Origin)"
  Say "mcp_url: $(if ($config.McpUrl) { $config.McpUrl } else { 'none' })"
  if ($config.McpUrl) { Write-ClaudeCodeLine $config.McpUrl }
  if ($env:GITSTALK_WEB -and $env:GITSTALK_WEB.TrimEnd('/') -ne $script:Web) { Say "note: GITSTALK_WEB=$($env:GITSTALK_WEB) is set and still wins in this shell" }
}

switch ($Command) {
  'detect' { Invoke-Detect }
  'generate' { Invoke-Generate }
  'register' { Invoke-Register }
  'remote' { Invoke-Remote }
  'create' { Invoke-Create }
  'verify' { Invoke-Verify }
  'host' { Invoke-Host }
  default { [Console]::Error.WriteLine('usage: gitstalk-setup.ps1 detect | generate | register | remote OWNER/REPO [DIR] | create [OWNER/]NAME [-Public] | verify [OWNER/REPO] | host [URL | -Reset]'); exit 2 }
}
