; installer.nsh - NSIS custom installer logic for TeamClaw Desktop.
; Loaded via build.win.nsis.include (assisted installer, oneClick=false).
;
; User-reported pain (2026-11-12): upgrade installs spent a long silent wait
; "waiting for the old version to uninstall" with no progress feedback.
; Root cause: the old-version uninstall rides ExecWait (app-builder-lib
; installUtil.nsh) with NO timeout knob - it blocks while NSIS deletes the
; ~450MB bundled runtime tree, and in oneClick mode nothing is shown. The
; fix is the assisted wizard (oneClick=false, set in package.json) plus the
; progress lines below; there is no timeout to raise.

!macro customInit
  ; Announce the pending old-version uninstall in the wizard's detail area
  ; so the wait is legible instead of looking hung.
  ReadRegStr $R0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${If} $R0 != ""
    DetailPrint "Upgrading: removing previous TeamClaw Desktop $R0 first (the bundled runtime is ~450MB - this can take a few minutes)..."
  ${EndIf}
!macroend

!macro customInstall
  ; #vc-redist (user ask 2026-11-15): bundle the MSVC runtime INSIDE the
  ; installer and lay it down silently when missing. Without it the openclaw
  ; fs-safe native package fails ERR_DLOPEN_FAILED on clean Windows boxes and
  ; every private-dir op falls back to the packaged .NET helper - the slow
  ; path behind slow controller startups and the sqlite-cleanup races.
  ; Registry check: VC++ 2015-2022 x64 (Installed=1) - the redist's own
  ; installer is idempotent, but skipping it saves a ~25MB pass when present.
  ClearErrors
  ReadRegDWORD $R0 HKLM "Software\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} ${Errors}
  ${OrIf} $R0 != 1
    IfFileExists "$INSTDIR\resources\bin\vc_redist.x64.exe" 0 +3
      DetailPrint "Installing Microsoft Visual C++ Runtime (required once, silent)..."
      ExecWait '"$INSTDIR\resources\bin\vc_redist.x64.exe" /install /quiet /norestart' $R1
      ${If} $R1 == 0
      ${OrIf} $R1 == 3010
        DetailPrint "Visual C++ Runtime installed (reboot may be pending)."
      ${Else}
        ; Never fail the app install over the runtime: the app still runs via
        ; the .NET fallback, and the user can install it manually later.
        DetailPrint "WARNING: Visual C++ Runtime installer exited with $R1 - continuing (app still works; install manually if the runtime is missing)."
      ${EndIf}
  ${Else}
    DetailPrint "Visual C++ Runtime already present - skipping."
  ${EndIf}
!macroend

!macro customUnInstall
  ; Uninstaller progress: say which tree is being removed. NSIS otherwise
  ; looks frozen while deleting a big runtime directory.
  DetailPrint "Removing TeamClaw Desktop from $INSTDIR (bundled runtime included - please wait)..."
!macroend
