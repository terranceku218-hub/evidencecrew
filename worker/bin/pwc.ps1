#requires -Version 5.1
<#
  pwc.ps1 - stable launcher for playwright-cli driven by the ChatGPT Worker adapter.

  WHY THIS EXISTS
    `playwright-cli` is not on PATH. Its package lives in an npx cache directory
    whose name is a content hash of the npm cache itself, so the path can change
    (or vanish) when npx/npm touches that cache. Hard-coding one hash would make
    the whole adapter fragile, so this launcher RESOLVES the package and calls it
    through `node` directly.

  WHY NOT `npm install -g`
    Installing globally would not remove the need to download a browser build;
    the cached copy already works offline. This keeps the toolchain local and
    reviewable, and it does not mutate the global npm prefix.

  USAGE
    pwc.ps1 <playwright-cli args...>

  The caller passes subcommands through verbatim, e.g.
    pwc.ps1 -s=chatgpt-worker open https://chatgpt.com --browser=chrome --headed
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CliArgs
)

$ErrorActionPreference = 'Stop'

# A session name is pinned so every adapter call talks to the same browser
# daemon. Two different sessions would mean two browsers and two profiles.
if (-not $env:PLAYWRIGHT_CLI_SESSION) {
  $env:PLAYWRIGHT_CLI_SESSION = 'chatgpt-worker'
}

# Skip the CLI's once-a-day npm-registry update probe: this adapter must not
# depend on network reachability to run a local browser command.
$env:NO_UPDATE_NOTIFIER = '1'
if (-not $env:CI) { $env:CI = '1' }

function Resolve-PlaywrightCli {
  $candidates = New-Object System.Collections.Generic.List[string]

  # 1. An explicit override always wins (useful for pinning or testing).
  if ($env:PWC_CLI_PATH) {
    $candidates.Add($env:PWC_CLI_PATH)
  }

  # 2. Every npx cache entry that actually contains @playwright/cli.
  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path -LiteralPath $npxRoot) {
    $found = Get-ChildItem -LiteralPath $npxRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        Join-Path $_.FullName 'node_modules\@playwright\cli\playwright-cli.js'
      } |
      Where-Object { Test-Path -LiteralPath $_ }
    foreach ($f in $found) { $candidates.Add($f) }
  }

  # 3. No hard-coded fallback. A fixed cache path is correct on exactly one machine, so instead the
  #    candidates above are what resolve the CLI, and the error below says how to seed the cache.

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$cliPath = Resolve-PlaywrightCli
if (-not $cliPath) {
  [Console]::Error.WriteLine(
    "pwc: could not locate @playwright/cli. Re-seed it with:`n" +
    "  npx --yes @playwright/cli@latest --version`n" +
    "or point PWC_CLI_PATH at playwright-cli.js.")
  exit 127
}

& node $cliPath @CliArgs
exit $LASTEXITCODE
