; Tessera's session daemon (tesserad.exe) can still be running from an earlier run or an older version, and Windows
; will not let the installer overwrite a running program ("Error opening file for writing: ...\tesserad.exe").
; Stop it before files are copied or removed.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM tesserad.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM tesserad.exe'
  Pop $0
  Sleep 500
!macroend
