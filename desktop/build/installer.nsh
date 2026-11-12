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

!macro customUnInstall
  ; Uninstaller progress: say which tree is being removed. NSIS otherwise
  ; looks frozen while deleting a big runtime directory.
  DetailPrint "Removing TeamClaw Desktop from $INSTDIR (bundled runtime included - please wait)..."
!macroend
