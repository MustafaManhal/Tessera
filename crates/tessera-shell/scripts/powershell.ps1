# Dot-sourced after PowerShell's normal profiles. Preserve the existing prompt and reader.
if ($env:SHELL_INTEGRATION -eq 'off' -or $global:TesseraShellState) { return }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { return }
$global:TesseraShellState = @{
    Prompt = $function:prompt
    Reader = $function:PSConsoleHostReadLine
    Active = $false
}
$env:TESSERA_SHELL_DIR = $null
function global:prompt {
    $succeeded = $?
    $nativeExit = $global:LASTEXITCODE
    $esc = [char]27
    if ($global:TesseraShellState.Active) {
        $code = 0
        if (-not $succeeded) {
            $code = 1
            if ($null -ne $nativeExit -and $nativeExit -ne 0) { $code = $nativeExit }
        }
        [Console]::Write("${esc}]133;D;${code}`a")
        $global:TesseraShellState.Active = $false
    }
    $location = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($location.Provider.Name -eq 'FileSystem') {
        $path = $location.ProviderPath.Replace('\', '/')
        if (-not $path.StartsWith('/')) { $path = '/' + $path }
        $encoded = ($path.Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
        $hostName = [Environment]::MachineName -replace '[^a-zA-Z0-9.-]', '_'
        [Console]::Write("${esc}]7;file://${hostName}${encoded}`a")
    }
    [Console]::Write("${esc}]133;A`a")
    $rendered = if ($global:TesseraShellState.Prompt) { & $global:TesseraShellState.Prompt } else { "PS $location> " }
    # Returning B as part of the prompt ensures it follows the user's visible prompt text.
    "$rendered${esc}]133;B`a"
    $global:LASTEXITCODE = $nativeExit
}
if ($global:TesseraShellState.Reader) {
    function global:PSConsoleHostReadLine {
        $line = & $global:TesseraShellState.Reader
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            [Console]::Write("$([char]27)]133;C`a")
            $global:TesseraShellState.Active = $true
        }
        $line
    }
}
