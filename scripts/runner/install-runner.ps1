<#
.SYNOPSIS
    Registers, repairs, or removes a GitHub Actions self-hosted runner for one
    repo, running as a Linux runner inside WSL2 (dev-pipeline-v2 spec section
    7.5, section 4.11 operator-CONFIRMED default; plan.md Chunk 14).

.DESCRIPTION
    Windows-side wrapper around the vendor `config.sh` / `svc.sh` runner
    tooling. The runner process itself lives INSIDE a WSL2 Linux distro
    (Docker via the WSL2 backend) so the existing bash-based CI suites and
    their Postgres service containers run unmodified: a Windows-native
    runner cannot execute a `services:` block (spec section 4.11).

    One runner process per repo (concurrency 1); same-repo jobs queue on
    GitHub's side. Registration is per-repo (spec section 4.7).

    Wrong-registration detection is a HARD ERROR, never detect-and-skip: if
    the work directory already holds a runner registered to a DIFFERENT
    repo than requested, this script refuses and names both repos. "A
    runner exists" is not "the right runner exists" (spec sections 7.5/13).

    This script never fetches, stores, or auto-installs WSL2 or Docker. If
    either precondition cannot be verified, it fails closed and names the
    missing precondition. If WSL2/Docker prove unusable at your site, the
    documented fallback is a Windows-native runner plus a workflow/suite
    rewrite (spec section 4.11), a re-estimated, operator-level decision
    this script does not make for you.

.PARAMETER Repo
    Target repo as `owner/name` (e.g. `michaelhazza/automation-v1`).

.PARAMETER Labels
    Runner labels. Defaults to the spec-pinned `self-hosted,linux`.

.PARAMETER WorkDir
    Linux-side path (inside the WSL distro) where the runner is installed
    and where its `_work` job folder lives. Everything this script deletes
    on -Repair/-Uninstall is scoped to exactly this directory, never
    anything outside it. Defaults to `~/actions-runner/<owner>-<repo>`.

.PARAMETER WslDistro
    Name of the WSL2 distro the runner installs into. Defaults to `Ubuntu`.

.PARAMETER RunnerName
    Name GitHub shows for this runner. Defaults to
    `<COMPUTERNAME>-<owner>-<repo>`.

.PARAMETER Token
    SecureString registration (or removal) token, short-lived and
    operator-entered at github.com. If omitted, the script prompts
    interactively at the point it is needed. Never stored, never
    committed, never echoed to the console or any log.

.PARAMETER Repair
    Clean remove + re-register against the SAME repo.

.PARAMETER Uninstall
    Deregister from GitHub, remove the auto-start task and service, and
    delete the work directory.

.EXAMPLE
    .\install-runner.ps1 -Repo michaelhazza/automation-v1 -WhatIf
    Preview what a fresh install would do without touching anything.

.EXAMPLE
    .\install-runner.ps1 -Repo michaelhazza/automation-v1
    Register (or re-verify, if already registered) the runner for real.

.EXAMPLE
    .\install-runner.ps1 -Repo michaelhazza/automation-v1 -Uninstall
    Deregister and remove everything this script created for that repo.
#>

#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$')]
    [string]$Repo,

    [string[]]$Labels = @('self-hosted', 'linux'),

    [string]$WorkDir,

    [string]$WslDistro = 'Ubuntu',

    [string]$RunnerName,

    [System.Security.SecureString]$Token,

    [switch]$Repair,

    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Repair -and $Uninstall) {
    Write-Error "-Repair and -Uninstall are mutually exclusive. Pick one."
    exit 1
}
if (@($Labels | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    Write-Error "-Labels contains an empty/whitespace entry. Every label must be a non-empty string."
    exit 1
}

$RepoSlug = ($Repo -replace '/', '-').ToLowerInvariant()
if (-not $WorkDir) { $WorkDir = "~/actions-runner/$RepoSlug" }
if (-not $RunnerName) { $RunnerName = "$env:COMPUTERNAME-$RepoSlug".ToLowerInvariant() }
$LabelsCsv = ($Labels -join ',')
$TaskName = "GHRunner-$RepoSlug"

# -- Small helpers -----------------------------------------------------------

function Write-Section {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ""
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

# Every value interpolated into a `bash -lc` command string is wrapped through
# this: single-quoted, with embedded single quotes escaped, so operator-
# controlled but non-statically-known values (repo, paths, labels) cannot
# break out of the intended shell argument (security-hardening: shell
# injection surfaces).
function ConvertTo-BashSingleQuoted {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + ($Value -replace "'", "'\''") + "'"
}

function ConvertFrom-SecureStringPlain {
    param([Parameter(Mandatory = $true)][System.Security.SecureString]$Secure)
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# Runs a command inside the target WSL distro via `bash -lc`. Passed to
# wsl.exe as ONE argv element (never re-concatenated into a single string by
# PowerShell itself), so the outer call is argv-array-safe; the bash -lc
# payload is an inherently-shell string by the nature of the vendor tooling,
# hardened at each interpolation site via ConvertTo-BashSingleQuoted instead.
function Invoke-WslBash {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$Command,
        [switch]$AsRoot
    )
    $wslArgs = @('-d', $Distro)
    if ($AsRoot) { $wslArgs += @('-u', 'root') }
    $wslArgs += @('--', 'bash', '-lc', $Command)
    $output = & wsl.exe @wslArgs 2>&1
    [PSCustomObject]@{
        ExitCode = $LASTEXITCODE
        Output   = ($output -join [Environment]::NewLine)
    }
}

# Reads the target distro's real home directory. Starts the WSL2 VM, so it is
# only ever called after the -WhatIf early-exit.
function Get-DistroHome {
    param([Parameter(Mandatory = $true)][string]$Distro)
    $result = Invoke-WslBash -Distro $Distro -Command 'printf %s "$HOME"'
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) {
        throw "Could not read `$HOME inside '$Distro' (exit $($result.ExitCode)): $($result.Output)"
    }
    return $result.Output.Trim()
}

# Bash does NOT expand `~` inside single quotes, and every path this script
# interpolates into a `bash -lc` payload is single-quoted as an injection
# defence (see ConvertTo-BashSingleQuoted). Left unresolved, a `~`-prefixed
# work dir therefore made `mkdir -p '~/actions-runner/...'` create a LITERAL
# directory named '~' relative to bash's CWD -- and for wsl.exe launched from
# a Windows directory that CWD is that directory under /mnt/c. The runner
# installed itself into the caller's repo working tree instead of the distro
# home (observed: 666 MB inside a pilot repo, breaking `git add -A` on the
# runner's own symlinks). Resolving up-front keeps the quoting defence intact
# while making every downstream site -- mkdir, cd, the .runner probe, and the
# `rm -rf` in uninstall/repair -- operate on an absolute, CWD-independent path.
function Resolve-DistroWorkDir {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$HomeDir
    )
    if (-not $HomeDir.StartsWith('/')) {
        throw "Resolved home directory '$HomeDir' is not absolute -- refusing to build a work-dir path from it."
    }
    # Deliberately not named $home -- that is a PowerShell automatic variable.
    $resolvedHome = $HomeDir.TrimEnd('/')
    $resolved = $null
    if ($Path -eq '~') {
        $resolved = $resolvedHome
    } elseif ($Path.StartsWith('~/')) {
        $resolved = "$resolvedHome/" + $Path.Substring(2).TrimStart('/')
    } elseif ($Path.StartsWith('/')) {
        $resolved = $Path.TrimEnd('/')
    } else {
        # Anything else (a bare relative path, or a `~user` form this script does
        # not resolve) would land against bash's CWD -- the /mnt/c trap above.
        # Fail closed rather than guess.
        throw "-WorkDir '$Path' is neither absolute nor '~/'-relative. A relative path resolves against bash's working directory inside the distro, which for wsl.exe launched from a Windows directory is that directory under /mnt/c -- the runner would be installed into your repo working tree. Pass an absolute path (e.g. /home/<user>/actions-runner/<slug>) or a '~/'-prefixed one."
    }

    # Floor on what the work dir is allowed to BE, not just how it is spelled.
    # -Uninstall and -Repair run `rm -rf` on this value, and the install step
    # untars over it, so a too-broad path is destructive in both directions.
    # `-WorkDir ~` previously resolved to the distro home and was accepted:
    # installing would have unpacked the runner tarball across $HOME, and a
    # later uninstall would have deleted the entire home directory.
    if ($resolved -eq '' -or $resolved -eq '/') {
        throw "-WorkDir resolves to the filesystem root. Refusing: this directory is created, untarred over, and later deleted wholesale."
    }
    if ($resolved -eq $resolvedHome) {
        throw "-WorkDir resolves to the distro home directory ('$resolved'). Refusing: the installer untars the runner over this directory and -Uninstall deletes it wholesale, which would destroy the home directory. Pass a dedicated subdirectory, e.g. '$resolvedHome/actions-runner/<repo-slug>'."
    }
    # /mnt/* is the Windows filesystem seen from inside WSL. Installing a Linux
    # runner there is the generalised form of the C22 defect (666 MB unpacked
    # into a Windows repo working tree), and `rm -rf` there reaches the
    # operator's real drive.
    if ($resolved -eq '/mnt' -or $resolved.StartsWith('/mnt/')) {
        throw "-WorkDir '$resolved' is on the Windows filesystem (/mnt/*) as seen from inside WSL. Refusing: the runner must live in the distro's own filesystem, and this script's `rm -rf` would otherwise reach the Windows drive. Pass a path under the distro home, e.g. '$resolvedHome/actions-runner/<repo-slug>'."
    }
    return $resolved
}

# Last line of defence before `rm -rf`. Resolve-DistroWorkDir bounds what the
# path may be; this asserts the target actually IS a runner install before it
# is deleted, so a mistyped-but-legal path deletes nothing. Both markers are
# checked: `.runner` alone can be a leftover, `config.sh` alone can be an
# unconfigured extract.
function Assert-RunnerWorkDirBeforeDelete {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $quoted = ConvertTo-BashSingleQuoted $WorkDir
    $probe = Invoke-WslBash -Distro $Distro -Command "test -f $quoted/.runner && test -f $quoted/config.sh && echo RUNNER_DIR_OK"
    if ($probe.Output -notmatch 'RUNNER_DIR_OK') {
        throw "Refusing to delete '$WorkDir' inside '$Distro': it does not look like a runner install (expected both '.runner' and 'config.sh' to exist there). Nothing was deleted. Verify -WorkDir, or remove the directory by hand if you are certain."
    }
}

# -- Host-level preconditions (safe: never starts the WSL2 VM) --------------

function Test-WslDistroPresent {
    param([Parameter(Mandatory = $true)][string]$Distro)
    $wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslCmd) {
        return [PSCustomObject]@{ Passed = $false; Detail = "wsl.exe not found on PATH. Install WSL2 manually: https://learn.microsoft.com/windows/wsl/install -- this script never auto-installs WSL2 (it changes the machine and may require a reboot)." }
    }
    $raw = & wsl.exe -l -v 2>&1
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        return [PSCustomObject]@{ Passed = $false; Detail = "wsl.exe -l -v exited $exit -- $($raw -join ' ')" }
    }
    # wsl.exe writes UTF-16 to stdout when its output is redirected/captured;
    # PowerShell's default capture yields one NUL char after every ASCII
    # byte. Strip it before matching (documented wsl.exe capture quirk).
    $text = ($raw -join "`n") -replace "`0", ''
    $pattern = '(?im)^\s*\*?\s*' + [regex]::Escape($Distro) + '\s+(\S+)\s+(\d+)\s*$'
    $match = [regex]::Match($text, $pattern)
    if (-not $match.Success) {
        return [PSCustomObject]@{ Passed = $false; Detail = "No distro named '$Distro' in 'wsl -l -v'. Register one first (operator decision, not automated here): wsl --install -d $Distro`nRaw listing:`n$text" }
    }
    $state = $match.Groups[1].Value
    $version = $match.Groups[2].Value
    if ($version -ne '2') {
        return [PSCustomObject]@{ Passed = $false; Detail = "Distro '$Distro' is WSL version $version, not 2 (spec section 4.11 pins WSL2). Convert: wsl --set-version $Distro 2" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "state=$state version=$version" }
}

function Test-GhReady {
    $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $ghCmd) {
        return [PSCustomObject]@{ Passed = $false; Detail = 'gh CLI not found on PATH. Install: https://cli.github.com/' }
    }
    $versionLine = (& gh --version | Select-Object -First 1)
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        return [PSCustomObject]@{ Passed = $false; Detail = "gh is installed ($versionLine) but not authenticated (gh auth status exited $LASTEXITCODE). Fix: gh auth login" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "$versionLine, authenticated" }
}

# Spec section 7.5 pins the trust boundary as "private repos only". That was
# prose until now: nothing verified it, while the installer registers a
# PERSISTENT runner whose jobs run as a user that must be in the docker group
# (Test-DockerReachable makes that a hard precondition). Docker group is
# root-equivalent, and /mnt/* exposes the operator's whole Windows drive, so a
# runner on a PUBLIC repo turns any fork PR into arbitrary code execution with
# access to every .env and sibling repo on the machine. Checked here, against
# the already-authenticated gh, because a precondition is the only place it can
# be enforced rather than asserted.
function Test-RepoTrustBoundary {
    param([Parameter(Mandatory = $true)][string]$Repo)
    $visibility = & gh api "repos/$Repo" --jq '.private' 2>&1
    if ($LASTEXITCODE -ne 0) {
        return [PSCustomObject]@{ Passed = $false; Detail = "could not read repo visibility for '$Repo' via gh api (exit $LASTEXITCODE): $visibility. Fail-closed -- refusing to register a persistent runner against a repo whose visibility is unknown." }
    }
    if ("$visibility".Trim() -ne 'true') {
        return [PSCustomObject]@{ Passed = $false; Detail = "'$Repo' is PUBLIC. Refusing: a persistent self-hosted runner on a public repo lets any fork PR execute attacker-authored workflow code on this machine, as a user in the docker group (root-equivalent) with /mnt/* access to the whole Windows drive. Spec section 7.5 pins this boundary to private repos only." }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "'$Repo' is private" }
}

function Show-HostPreconditions {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$Repo
    )
    Write-Section "Host preconditions"
    $wslCheck = Test-WslDistroPresent -Distro $Distro
    $ghCheck = Test-GhReady
    $rows = @(
        [PSCustomObject]@{ Check = "WSL2 distro '$Distro' present (version 2)"; Passed = $wslCheck.Passed; Detail = $wslCheck.Detail }
        [PSCustomObject]@{ Check = 'gh CLI installed + authenticated'; Passed = $ghCheck.Passed; Detail = $ghCheck.Detail }
    )
    # Only meaningful once gh is authenticated; otherwise it would report a
    # confusing auth error rather than the real precondition failure.
    if ($ghCheck.Passed) {
        $trustCheck = Test-RepoTrustBoundary -Repo $Repo
        $rows += [PSCustomObject]@{ Check = "'$Repo' is private (trust boundary, spec 7.5)"; Passed = $trustCheck.Passed; Detail = $trustCheck.Detail }
    }
    foreach ($row in $rows) {
        $mark = if ($row.Passed) { '[OK]  ' } else { '[FAIL]' }
        $color = if ($row.Passed) { 'Green' } else { 'Red' }
        Write-Host "$mark $($row.Check)" -ForegroundColor $color
        Write-Host "       $($row.Detail)"
    }
    $allPassed = -not ($rows | Where-Object { -not $_.Passed })
    if (-not $allPassed) {
        Write-Host ""
        Write-Host "One or more host preconditions failed. Fail-closed: no further action taken." -ForegroundColor Red
        Write-Host "If WSL2/Docker cannot be made to work on this machine, spec section 4.11's documented" -ForegroundColor Yellow
        Write-Host "fallback is a Windows-native runner + workflow/suite rewrite -- a re-estimated," -ForegroundColor Yellow
        Write-Host "operator-level decision, not something this script does automatically." -ForegroundColor Yellow
    }
    return $allPassed
}

# -- Deep preconditions (require the WSL2 VM to be running) -----------------

function Test-DockerReachable {
    param([Parameter(Mandatory = $true)][string]$Distro)
    $result = Invoke-WslBash -Distro $Distro -Command 'docker info > /dev/null 2>&1; echo EXIT:$?'
    if ($result.ExitCode -ne 0 -or $result.Output -notmatch 'EXIT:0') {
        return [PSCustomObject]@{ Passed = $false; Detail = "Docker unreachable inside '$Distro'. Check the WSL2 Docker backend (Docker Desktop > Settings > Resources > WSL Integration, or dockerd status inside the distro). This script never installs or starts Docker for you.`n$($result.Output)" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = 'docker info succeeded' }
}

function Test-SystemdActive {
    param([Parameter(Mandatory = $true)][string]$Distro)
    # svc.sh (vendor tooling) only needs systemd to be PID 1 to install a
    # boot-managed unit -- it does not require every unit to be healthy.
    # `systemctl is-system-running` returns non-zero for "degraded" too,
    # which is common and harmless on WSL2, so test presence directly
    # instead of demanding a clean "running" state.
    $result = Invoke-WslBash -Distro $Distro -Command '[ -d /run/systemd/system ] && echo EXIT:0 || echo EXIT:1; systemctl is-system-running 2>&1'
    if ($result.Output -notmatch 'EXIT:0') {
        return [PSCustomObject]@{ Passed = $false; Detail = "systemd is not the active init inside '$Distro' (svc.sh needs it to install a boot-managed service). Add '[boot]`nsystemd=true' to /etc/wsl.conf inside the distro, then run 'wsl --shutdown' from Windows and retry -- this script does not edit wsl.conf or shut down WSL for you, since that disrupts any other running WSL work.`n$($result.Output)" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "systemd active ($($result.Output.Trim()))" }
}

function Show-DeepPreconditions {
    param([Parameter(Mandatory = $true)][string]$Distro)
    Write-Section "Deep preconditions (starting '$Distro' if not already running)"
    $dockerCheck = Test-DockerReachable -Distro $Distro
    $systemdCheck = Test-SystemdActive -Distro $Distro
    $rows = @(
        [PSCustomObject]@{ Check = 'Docker reachable'; Passed = $dockerCheck.Passed; Detail = $dockerCheck.Detail }
        [PSCustomObject]@{ Check = 'systemd active (for boot-managed service)'; Passed = $systemdCheck.Passed; Detail = $systemdCheck.Detail }
    )
    foreach ($row in $rows) {
        $mark = if ($row.Passed) { '[OK]  ' } else { '[FAIL]' }
        $color = if ($row.Passed) { 'Green' } else { 'Red' }
        Write-Host "$mark $($row.Check)" -ForegroundColor $color
        Write-Host "       $($row.Detail)"
    }
    return -not ($rows | Where-Object { -not $_.Passed })
}

# -- Existing-registration inspection (wrong-repo detection) ----------------

function Get-ExistingRunnerConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $quotedPath = ConvertTo-BashSingleQuoted "$WorkDir/.runner"
    # ABSENT and UNREADABLE must be distinguishable. `cat ... 2>/dev/null`
    # collapsed "no registration here" (legitimate), "permission denied"
    # (plausible after a prior sudo-run install) and "wsl transient failure"
    # into one $null, and the main flow reads $null as "nothing registered"
    # and proceeds to install with `config.sh --replace` -- clobbering
    # whatever registration is actually there. That is exactly the
    # detect-and-skip behaviour this script's .DESCRIPTION forbids, and it is
    # the headline safety property of the whole file.
    $probe = "if [ ! -e $quotedPath ]; then echo '__RUNNER_CFG_ABSENT__'; elif cat $quotedPath; then :; else echo '__RUNNER_CFG_UNREADABLE__'; fi"
    $result = Invoke-WslBash -Distro $Distro -Command $probe
    if ($result.ExitCode -ne 0) {
        throw "Could not determine whether a runner is already registered at '$WorkDir/.runner' inside '$Distro' (wsl exited $($result.ExitCode)): $($result.Output). Fail-closed: refusing to continue, because treating this as 'nothing registered' would let an install replace an existing registration."
    }
    if ($result.Output -match '__RUNNER_CFG_UNREADABLE__') {
        throw "A '.runner' file exists at '$WorkDir/.runner' inside '$Distro' but could not be read (permission denied?). Refusing to continue: assuming 'nothing registered' here would clobber an existing registration via 'config.sh --replace'. Inspect it manually (e.g. 'wsl -d $Distro -u root -- cat $WorkDir/.runner') and resolve before re-running."
    }
    if ($result.Output -match '__RUNNER_CFG_ABSENT__' -or [string]::IsNullOrWhiteSpace($result.Output)) {
        return $null
    }
    try {
        return $result.Output | ConvertFrom-Json
    } catch {
        throw "Existing '.runner' file at '$WorkDir/.runner' inside '$Distro' is present but not valid JSON. Refusing to guess its target repo -- resolve manually (inspect/remove the file) before re-running."
    }
}

function Get-RepoFromGitHubUrl {
    param([Parameter(Mandatory = $true)][string]$GitHubUrl)
    return ($GitHubUrl -replace '^https?://github\.com/', '' -replace '/$', '')
}

function Assert-NoWrongRepoRegistration {
    param(
        [Parameter(Mandatory = $true)]$ExistingConfig,
        [Parameter(Mandatory = $true)][string]$ExpectedRepo
    )
    if ($null -eq $ExistingConfig) { return $false }
    $existingRepo = Get-RepoFromGitHubUrl -GitHubUrl $ExistingConfig.gitHubUrl
    if ($existingRepo -ne $ExpectedRepo) {
        Write-Host ""
        Write-Host "ERROR: wrong-repo registration detected." -ForegroundColor Red
        Write-Host "  Work directory holds a runner registered to : $existingRepo"
        Write-Host "  You requested                                 : $ExpectedRepo"
        Write-Host "Refusing to silently reconfigure or skip -- 'a runner exists' is not 'the" -ForegroundColor Red
        Write-Host "right runner exists' (spec sections 7.5/13). Point -WorkDir at a different directory" -ForegroundColor Red
        Write-Host "for a separate registration, or -Uninstall the existing one first if it is" -ForegroundColor Red
        Write-Host "genuinely stale." -ForegroundColor Red
        throw "Wrong-repo registration: '$existingRepo' present, '$ExpectedRepo' requested."
    }
    return $true
}

# -- Registration token (operator-entered, never stored/echoed) -------------

function Read-RegistrationToken {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][ValidateSet('registration', 'removal')][string]$Purpose,
        [System.Security.SecureString]$Provided
    )
    if ($Provided) { return $Provided }

    Write-Host ""
    if ($Purpose -eq 'registration') {
        Write-Host "A short-lived REGISTRATION token is needed for '$Repo'. Get one via EITHER:"
        Write-Host "  (a) GitHub UI: https://github.com/$Repo/settings/actions/runners/new"
        Write-Host "  (b) In a separate authenticated shell: gh api -X POST repos/$Repo/actions/runners/registration-token --jq .token"
    } else {
        Write-Host "A short-lived REMOVAL token is needed for '$Repo' (different from a registration token). Get one via EITHER:"
        Write-Host "  (a) GitHub UI: repo Settings > Actions > Runners > select the runner > Remove"
        Write-Host "  (b) In a separate authenticated shell: gh api -X POST repos/$Repo/actions/runners/remove-token --jq .token"
    }
    Write-Host "This script never stores, logs, or displays the token."
    return Read-Host -Prompt "Paste the $Purpose token" -AsSecureString
}

# -- Post-install / status verification --------------------------------------

function Show-RunnerStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [string]$ExpectedName
    )
    Write-Section "Runner status for $Repo (gh api repos/$Repo/actions/runners)"
    $json = & gh api "repos/$Repo/actions/runners" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not query runner status: $json" -ForegroundColor Red
        return $false
    }
    $parsed = $json | ConvertFrom-Json
    if (-not $parsed.runners -or @($parsed.runners).Count -eq 0) {
        Write-Host "No runners registered for $Repo." -ForegroundColor Yellow
        return $false
    }
    $found = $false
    foreach ($runner in $parsed.runners) {
        $labelNames = ($runner.labels | ForEach-Object { $_.name }) -join ','
        $marker = ''
        if ($ExpectedName -and $runner.name -eq $ExpectedName) {
            $marker = ' <-- this install'
            $found = $true
        }
        Write-Host "  id=$($runner.id) name=$($runner.name) status=$($runner.status) labels=$labelNames$marker"
    }
    if ($ExpectedName -and -not $found) {
        Write-Host "Expected runner name '$ExpectedName' was not in the list above." -ForegroundColor Yellow
    }
    return $true
}

# -- Auto-start at Windows boot ----------------------------------------------
# Mechanism: a Task Scheduler task triggered AtStartup, running as SYSTEM,
# that invokes `wsl.exe -d <Distro> -u root -- systemctl start <unit>`.
# svc.sh install (below) already `systemctl enable`s the unit, so systemd
# itself will normally bring the service up as soon as the distro's init
# starts -- but WSL2 does not launch the distro's VM on Windows boot by
# itself; something has to invoke wsl.exe first. This task is that trigger,
# and re-asserting `systemctl start` on an already-started unit is a no-op,
# so it is safe to run unconditionally on every boot.
# Chosen over a long-running Windows-side service piping into WSL (extra
# process, extra failure surface) and over NSSM/third-party service
# wrappers (extra dependency): Task Scheduler + wsl.exe is built in, and
# svc.sh's own service management is exactly the vendor's documented Linux
# service story, so this keeps the installer close to that contract rather
# than reinventing service supervision on the Windows side.
# CAVEAT (flag for the C22 operator spike): AtStartup tasks running as
# SYSTEM invoking wsl.exe are version-dependent on some WSL builds -- if
# the runner does not come up after a real reboot, switch the trigger to
# `-AtLogOn` for the operator's own account (higher reliability, but only
# fires once that account logs in, not at raw machine boot).
function Register-RunnerAutoStart {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$ServiceUnit
    )
    if (-not $PSCmdlet.ShouldProcess("Task Scheduler task '$TaskName'", "Register (AtStartup, SYSTEM) to auto-start '$ServiceUnit' in '$Distro'")) {
        return
    }
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root -- systemctl start $ServiceUnit"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Auto-starts the GitHub Actions runner for $Repo inside WSL2 distro '$Distro' at Windows boot (dev-pipeline-v2 C14)." | Out-Null
    Write-Host "Registered Task Scheduler task '$TaskName' (AtStartup, SYSTEM)." -ForegroundColor Green
}

function Unregister-RunnerAutoStart {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory = $true)][string]$TaskName)
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) { return }
    if (-not $PSCmdlet.ShouldProcess("Task Scheduler task '$TaskName'", 'Remove')) { return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Task Scheduler task '$TaskName'." -ForegroundColor Green
}

# -- Mode: fresh install -----------------------------------------------------

function Install-Runner {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$RunnerName,
        [Parameter(Mandatory = $true)][string]$LabelsCsv,
        [System.Security.SecureString]$Token
    )
    $secureToken = Read-RegistrationToken -Repo $Repo -Purpose 'registration' -Provided $Token
    $plainToken = ConvertFrom-SecureStringPlain -Secure $secureToken

    Write-Section "Install plan for $Repo"
    Write-Host "  1. Resolve latest actions/runner release version (gh api, Windows side)"
    Write-Host "  2. Inside '$Distro': create '$WorkDir', download + extract the runner tarball"
    Write-Host "  3. Inside '$Distro': ./config.sh --url https://github.com/$Repo --name $RunnerName --labels $LabelsCsv --work _work --unattended"
    Write-Host "  4. Inside '$Distro': sudo ./svc.sh install && sudo ./svc.sh start"
    Write-Host "  5. Register a Task Scheduler auto-start task ('$TaskName')"
    Write-Host "  6. Verify via gh api repos/$Repo/actions/runners"

    if (-not $PSCmdlet.ShouldProcess("$Repo (work dir '$WorkDir' in '$Distro')", 'Install and register GitHub Actions runner')) {
        return
    }

    try {
        $versionTag = (& gh api repos/actions/runner/releases/latest --jq .tag_name 2>&1)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($versionTag)) {
            throw "Could not resolve latest actions/runner release via gh api: $versionTag"
        }
        $version = $versionTag.TrimStart('v').Trim()
        $tarball = "actions-runner-linux-x64-$version.tar.gz"
        $downloadUrl = "https://github.com/actions/runner/releases/download/$versionTag/$tarball"

        $quotedWorkDir = ConvertTo-BashSingleQuoted $WorkDir
        $quotedUrl = ConvertTo-BashSingleQuoted "https://github.com/$Repo"
        $quotedName = ConvertTo-BashSingleQuoted $RunnerName
        $quotedLabels = ConvertTo-BashSingleQuoted $LabelsCsv
        $quotedDownload = ConvertTo-BashSingleQuoted $downloadUrl
        $quotedTarball = ConvertTo-BashSingleQuoted $tarball

        $setupCmd = "set -e && mkdir -p $quotedWorkDir && cd $quotedWorkDir && curl -fsSL -o $quotedTarball $quotedDownload && tar xzf $quotedTarball && rm -f $quotedTarball"
        $setupResult = Invoke-WslBash -Distro $Distro -Command $setupCmd
        if ($setupResult.ExitCode -ne 0) { throw "Runner download/extract failed:`n$($setupResult.Output)" }

        $quotedToken = ConvertTo-BashSingleQuoted $plainToken
        $configCmd = "cd $quotedWorkDir && ./config.sh --url $quotedUrl --token $quotedToken --name $quotedName --labels $quotedLabels --work _work --unattended --replace"
        $configResult = Invoke-WslBash -Distro $Distro -Command $configCmd
        if ($configResult.ExitCode -ne 0) { throw "config.sh registration failed:`n$($configResult.Output)" }

        $serviceCmd = "cd $quotedWorkDir && sudo ./svc.sh install && sudo ./svc.sh start"
        $serviceResult = Invoke-WslBash -Distro $Distro -Command $serviceCmd
        if ($serviceResult.ExitCode -ne 0) { throw "svc.sh install/start failed:`n$($serviceResult.Output)" }

        $unitLookup = Invoke-WslBash -Distro $Distro -Command "systemctl list-unit-files --no-legend 2>/dev/null | grep '^actions\.runner\.' | awk '{print `$1}' | head -n1"
        $serviceUnit = $unitLookup.Output.Trim()
        if ([string]::IsNullOrWhiteSpace($serviceUnit)) {
            Write-Host "Could not determine the exact systemd unit name; auto-start task will not be registered automatically. Inspect with: wsl -d $Distro -u root -- systemctl list-unit-files | grep actions.runner" -ForegroundColor Yellow
        } else {
            Write-Host "Service unit: $serviceUnit"
            Register-RunnerAutoStart -TaskName $TaskName -Distro $Distro -ServiceUnit $serviceUnit
        }
    } finally {
        $plainToken = $null
        [System.GC]::Collect()
    }

    Show-RunnerStatus -Repo $Repo -ExpectedName $RunnerName | Out-Null
}

# -- Mode: repair (remove + reinstall) ---------------------------------------

function Repair-Runner {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$RunnerName,
        [Parameter(Mandatory = $true)][string]$LabelsCsv,
        [System.Security.SecureString]$Token
    )
    Write-Section "Repair plan for $Repo"
    Write-Host "  1. Stop + uninstall the existing service inside '$Distro'"
    Write-Host "  2. Deregister the existing runner from GitHub (removal token)"
    Write-Host "  3. Delete '$WorkDir' (and nothing outside it)"
    Write-Host "  4. Run a fresh install (see Install plan)"

    if (-not $PSCmdlet.ShouldProcess("$Repo (work dir '$WorkDir' in '$Distro')", 'Repair (remove + re-register) GitHub Actions runner')) {
        return
    }

    $removalToken = Read-RegistrationToken -Repo $Repo -Purpose 'removal' -Provided $Token
    $plainRemovalToken = ConvertFrom-SecureStringPlain -Secure $removalToken
    try {
        $quotedWorkDir = ConvertTo-BashSingleQuoted $WorkDir
        $quotedRemovalToken = ConvertTo-BashSingleQuoted $plainRemovalToken
        $removeCmd = "cd $quotedWorkDir && (sudo ./svc.sh stop || true) && (sudo ./svc.sh uninstall || true) && ./config.sh remove --token $quotedRemovalToken"
        $removeResult = Invoke-WslBash -Distro $Distro -Command $removeCmd
        if ($removeResult.ExitCode -ne 0) { throw "Removal failed:`n$($removeResult.Output)" }
    } finally {
        $plainRemovalToken = $null
        [System.GC]::Collect()
    }

    Assert-RunnerWorkDirBeforeDelete -Distro $Distro -WorkDir $WorkDir
    $quotedWorkDirForDelete = ConvertTo-BashSingleQuoted $WorkDir
    $deleteResult = Invoke-WslBash -Distro $Distro -Command "rm -rf -- $quotedWorkDirForDelete"
    if ($deleteResult.ExitCode -ne 0) { throw "Deleting work dir failed:`n$($deleteResult.Output)" }
    Write-Host "Removed existing registration and deleted '$WorkDir'." -ForegroundColor Green

    Install-Runner -Repo $Repo -Distro $Distro -WorkDir $WorkDir -RunnerName $RunnerName -LabelsCsv $LabelsCsv -Token $null
}

# -- Mode: uninstall ----------------------------------------------------------

function Uninstall-Runner {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [System.Security.SecureString]$Token
    )
    Write-Section "Uninstall plan for $Repo"
    Write-Host "  1. Stop + uninstall the service inside '$Distro'"
    Write-Host "  2. Deregister the runner from GitHub (removal token)"
    Write-Host "  3. Delete '$WorkDir' (and nothing outside it)"
    Write-Host "  4. Remove the Task Scheduler auto-start task ('$TaskName')"
    Write-Host "  5. Confirm absence via gh api repos/$Repo/actions/runners"

    if (-not $PSCmdlet.ShouldProcess("$Repo (work dir '$WorkDir' in '$Distro')", 'Uninstall GitHub Actions runner')) {
        return
    }

    $removalToken = Read-RegistrationToken -Repo $Repo -Purpose 'removal' -Provided $Token
    $plainRemovalToken = ConvertFrom-SecureStringPlain -Secure $removalToken
    try {
        $quotedWorkDir = ConvertTo-BashSingleQuoted $WorkDir
        $quotedRemovalToken = ConvertTo-BashSingleQuoted $plainRemovalToken
        $removeCmd = "cd $quotedWorkDir && (sudo ./svc.sh stop || true) && (sudo ./svc.sh uninstall || true) && ./config.sh remove --token $quotedRemovalToken"
        $removeResult = Invoke-WslBash -Distro $Distro -Command $removeCmd
        if ($removeResult.ExitCode -ne 0) { throw "Removal failed:`n$($removeResult.Output)" }
    } finally {
        $plainRemovalToken = $null
        [System.GC]::Collect()
    }

    Assert-RunnerWorkDirBeforeDelete -Distro $Distro -WorkDir $WorkDir
    $quotedWorkDirForDelete = ConvertTo-BashSingleQuoted $WorkDir
    $deleteResult = Invoke-WslBash -Distro $Distro -Command "rm -rf -- $quotedWorkDirForDelete"
    if ($deleteResult.ExitCode -ne 0) { throw "Deleting work dir failed:`n$($deleteResult.Output)" }

    Unregister-RunnerAutoStart -TaskName $TaskName
    Write-Host "Uninstalled runner for $Repo and deleted '$WorkDir'." -ForegroundColor Green
    Show-RunnerStatus -Repo $Repo | Out-Null
}

# -- Main ---------------------------------------------------------------------

Write-Section "install-runner.ps1 -- $Repo"
Write-Host "  Distro:      $WslDistro"
Write-Host "  Work dir:    $WorkDir (inside the distro; any '~' is resolved against its `$HOME at run time)"
Write-Host "  Runner name: $RunnerName"
Write-Host "  Labels:      $LabelsCsv"
Write-Host "  Mode:        $(if ($Uninstall) { 'uninstall' } elseif ($Repair) { 'repair' } else { 'install (or verify if already registered)' })"

$hostReady = Show-HostPreconditions -Distro $WslDistro -Repo $Repo
if (-not $hostReady) {
    exit 1
}

if ($WhatIfPreference) {
    Write-Section "WhatIf: plan only, nothing executed"
    Write-Host "Deep checks (Docker reachability, systemd status inside '$WslDistro', reading any"
    Write-Host "existing '.runner' registration) are skipped under -WhatIf so this preview never"
    Write-Host "starts the WSL2 VM. They run for real on a non-WhatIf invocation."
    Write-Host "For the same reason the work dir below is shown UNRESOLVED: a leading '~' is"
    Write-Host "expanded against the distro's `$HOME only on a real run, so the paths printed"
    Write-Host "here are the requested form, not the final absolute one."
    Write-Host ""
    if ($Uninstall) {
        Write-Host "Would run the UNINSTALL plan: stop+uninstall the service, deregister from"
        Write-Host "GitHub (removal token), delete '$WorkDir', remove Task Scheduler task '$TaskName',"
        Write-Host "then confirm absence via gh api."
    } elseif ($Repair) {
        Write-Host "Would run the REPAIR plan: remove the existing registration at '$WorkDir', then"
        Write-Host "the full INSTALL plan (see below) against the same repo."
    } else {
        Write-Host "Would check '$WorkDir/.runner' inside '$WslDistro':"
        Write-Host "  - if it matches '$Repo' already: no-op, just re-verify + re-echo via gh api"
        Write-Host "  - if it matches a DIFFERENT repo: HARD ERROR, no changes"
        Write-Host "  - if absent: run the INSTALL plan -- download the runner, register via"
        Write-Host "    config.sh, install+start the systemd service via svc.sh, register a"
        Write-Host "    Task Scheduler auto-start task, then verify via gh api."
    }
    exit 0
}

$deepReady = Show-DeepPreconditions -Distro $WslDistro
if (-not $deepReady) {
    exit 1
}

# Must happen before ANY use of $WorkDir in a bash payload -- see
# Resolve-DistroWorkDir for why a bare '~' would otherwise create a literal
# '~' directory under the Windows CWD. Deliberately after the -WhatIf
# early-exit above: reading $HOME starts the WSL2 VM.
$WorkDir = Resolve-DistroWorkDir -Path $WorkDir -HomeDir (Get-DistroHome -Distro $WslDistro)
Write-Host "  Work dir resolved to: $WorkDir" -ForegroundColor DarkGray

$existingConfig = Get-ExistingRunnerConfig -Distro $WslDistro -WorkDir $WorkDir

if ($Uninstall) {
    if ($null -eq $existingConfig) {
        Write-Host "Nothing registered at '$WorkDir' in '$WslDistro' -- nothing to uninstall." -ForegroundColor Yellow
        exit 0
    }
    Assert-NoWrongRepoRegistration -ExistingConfig $existingConfig -ExpectedRepo $Repo | Out-Null
    Uninstall-Runner -Repo $Repo -Distro $WslDistro -WorkDir $WorkDir -Token $Token
    exit 0
}

if ($Repair) {
    if ($null -eq $existingConfig) {
        Write-Error "Nothing registered at '$WorkDir' in '$WslDistro' -- there is nothing to repair. Drop -Repair to run a fresh install."
        exit 1
    }
    Assert-NoWrongRepoRegistration -ExistingConfig $existingConfig -ExpectedRepo $Repo | Out-Null
    Repair-Runner -Repo $Repo -Distro $WslDistro -WorkDir $WorkDir -RunnerName $RunnerName -LabelsCsv $LabelsCsv -Token $Token
    exit 0
}

# Default mode: install, or idempotent no-op-with-confirmation if already
# registered to this same repo.
if ($null -ne $existingConfig) {
    Assert-NoWrongRepoRegistration -ExistingConfig $existingConfig -ExpectedRepo $Repo | Out-Null
    Write-Host ""
    Write-Host "Already registered to $Repo at '$WorkDir' -- no changes made (idempotent)." -ForegroundColor Green
    Show-RunnerStatus -Repo $Repo -ExpectedName $existingConfig.agentName | Out-Null
    exit 0
}

Install-Runner -Repo $Repo -Distro $WslDistro -WorkDir $WorkDir -RunnerName $RunnerName -LabelsCsv $LabelsCsv -Token $Token
