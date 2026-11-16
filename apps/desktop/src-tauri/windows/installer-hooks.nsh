; Before files are copied or removed, stop every Tessera program that runs from the install folder: the app, the session
; daemon (tesserad.exe) and the command-line tool (tessera.exe, which agents keep running as their MCP server).
;
; Windows will not let the installer overwrite a running program ("Error opening file for writing: ...\tesserad.exe"),
; and the installer's own check, which asks Windows Restart Manager to close the app, fails while the app's daemon and
; helper processes still hold it ("Failed to kill Tessera. Please close it first then try again"). Stopping them here,
; before that check runs, lets the install go through.
!macro TESSERA_STOP_PROCESSES
  ; Everything started from the install folder, whatever its file name.
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = '$INSTDIR'.TrimEnd('\') + '\'; Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$dir, [System.StringComparison]::OrdinalIgnoreCase) -and $$_.ProcessName -notlike 'uninstall*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  ; By name as well, in case PowerShell is unavailable or a process cannot report its path.
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM tesserad.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM tessera.exe'
  Pop $0
  ; Give Windows a moment to release the files.
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TESSERA_STOP_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TESSERA_STOP_PROCESSES
!macroend
