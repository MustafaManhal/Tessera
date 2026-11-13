param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [Parameter(Mandatory = $true)]
  [int]$Width,
  [Parameter(Mandatory = $true)]
  [int]$Height
)

$ErrorActionPreference = "Stop"

if ($Width -le 0 -or $Height -le 0) {
  throw "Window dimensions must be positive."
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class TesseraSmokeWindow {
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);
}
"@

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) {
  throw "The Tessera process has no visible main window."
}

$flags = 0x0004 -bor 0x0010 -bor 0x0040
if (-not [TesseraSmokeWindow]::SetWindowPos($handle, [IntPtr]::Zero, 20, 20, $Width, $Height, $flags)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "SetWindowPos failed with Win32 error $code."
}
