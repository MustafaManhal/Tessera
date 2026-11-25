; Before files are copied or removed, stop every Tessera program that runs from the install folder: the app, the session
; daemon (tesserad.exe) and the command-line tool (tessera.exe, which agents keep running as their MCP server), then
; wait until Windows has let go of their files.
;
; Why the wait matters: an in-app update starts this installer and the app exits right after (tauri-plugin-updater
; calls ShellExecute, then std::process::exit). The template's running-app check (Restart Manager, right after
; NSIS_HOOK_PREINSTALL) then races that exit: RmShutdown fails on a process that is still shutting down, and the update
; aborts with "Failed to kill Tessera. Please close it first then try again" (tauri-apps/tauri#16277). taskkill cannot
; help either, because Windows refuses to terminate a process that is already exiting. So after asking everything to
; stop, the hook polls until each program file can be opened for writing, which only succeeds once no process has it
; loaded, and only then lets the template's check run.

!macro TESSERA_KILL_PROCESSES
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
!macroend

; Sets $0 to 1 when `path` exists and some process still has it open or loaded, else 0.
!macro TESSERA_FILE_BUSY path
  StrCpy $0 0
  ${If} ${FileExists} "${path}"
    ClearErrors
    FileOpen $1 "${path}" a
    ${If} ${Errors}
      StrCpy $0 1
    ${Else}
      FileClose $1
    ${EndIf}
  ${EndIf}
!macroend

; Sets $0 to 1 while any Tessera program file in the install folder is still in use.
!macro TESSERA_ANY_BUSY
  !insertmacro TESSERA_FILE_BUSY "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} $0 = 0
    !insertmacro TESSERA_FILE_BUSY "$INSTDIR\tesserad.exe"
  ${EndIf}
  ${If} $0 = 0
    !insertmacro TESSERA_FILE_BUSY "$INSTDIR\tessera.exe"
  ${EndIf}
!macroend

!macro TESSERA_STOP_PROCESSES
  Push $0
  Push $1
  Push $2
  !insertmacro TESSERA_KILL_PROCESSES
  ; Up to 30 s (120 x 250 ms). Every 2 s the stop is repeated: a process that was mid-exit or just starting when the
  ; first one ran is caught by the next. If something still runs after that, the template's own check reports it.
  StrCpy $2 0
  !insertmacro TESSERA_ANY_BUSY
  ${DoWhile} $0 = 1
    ${IfThen} $2 >= 120 ${|} ${ExitDo} ${|}
    ${If} $2 = 0
      DetailPrint "Waiting for Tessera to close..."
    ${EndIf}
    IntOp $2 $2 + 1
    IntOp $1 $2 % 8
    ${If} $1 = 0
      !insertmacro TESSERA_KILL_PROCESSES
    ${EndIf}
    Sleep 250
    !insertmacro TESSERA_ANY_BUSY
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TESSERA_STOP_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TESSERA_STOP_PROCESSES
!macroend
