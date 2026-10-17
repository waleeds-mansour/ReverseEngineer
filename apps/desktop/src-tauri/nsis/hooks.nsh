; Nook's installer hooks (docs/nook-wm.md, "WHO RUNS IT"), included by installer.nsi through
; bundle.windows.nsis.installerHooks in tauri.conf.json. Before the installer replaces or removes
; hearth.exe, the installed copy puts back the windows Nook arranged, through the same restore the
; tray and nook-guard.exe use. The template calls PREINSTALL and PREUNINSTALL before
; CheckIfAppIsRunning kills every hearth.exe by name, so a running Hearth is still there to answer.
;
; The restore runs through nsExec, so no window opens, and it never stops the installer: a missing
; hearth.exe is skipped, and a Hearth too old to know the flag exits with an error that changes
; nothing. /TIMEOUT keeps a stuck hearth.exe from holding the installer up; CheckIfAppIsRunning
; ends it right after.
;
; An update reaches the old version's uninstaller one way only: a newer installer run by hand,
; with the old version's uninstall chosen on its reinstall page. installer.nsi restores with the
; update's reason first and passes /NOOKUPDATE, so the uninstaller keeps positions and the folder
; the new version needs. The updater itself installs over the old version (/UPDATE) and never
; runs the uninstaller.

; The restore, by the hearth.exe in DIR.
!macro NOOK_RESTORE_WINDOWS_IN DIR REASON
  ${If} ${FileExists} "${DIR}\${MAINBINARYNAME}.exe"
    DetailPrint "Nook is putting windows back (${REASON})"
    Push $0
    nsExec::Exec /TIMEOUT=30000 '"${DIR}\${MAINBINARYNAME}.exe" --nook-restore-windows --reason=${REASON} --wait-ms=5000 --quiet --by=installer'
    Pop $0
    DetailPrint "Nook's restore ended with $0"
    Pop $0
  ${EndIf}
!macroend

!macro NOOK_RESTORE_WINDOWS REASON
  !insertmacro NOOK_RESTORE_WINDOWS_IN "$INSTDIR" "${REASON}"
!macroend

; Leaves 1 on the stack when this uninstaller removes the old version only for a new one to be
; installed (/NOOKUPDATE, or the template's own /UPDATE), otherwise 0.
!macro NOOK_UPDATING
  Push $0
  ClearErrors
  ${GetOptions} $CMDLINE "/NOOKUPDATE" $0
  ${If} ${Errors}
  ${AndIf} $UpdateMode <> 1
    StrCpy $0 0
  ${Else}
    StrCpy $0 1
  ${EndIf}
  Exch $0
!macroend

; An update shows every window Nook hid and keeps it where it is, and the new version resumes.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro NOOK_RESTORE_WINDOWS "update"
!macroend

; An uninstall puts every window back where it was before Nook moved it. The first half of an
; update keeps positions instead, as an update does.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NOOK_UPDATING
  Exch $0
  ${If} $0 = 1
    Pop $0
    !insertmacro NOOK_RESTORE_WINDOWS "update"
  ${Else}
    Pop $0
    !insertmacro NOOK_RESTORE_WINDOWS "uninstall"
  ${EndIf}
!macroend

; The guard's per-version copies go with the app, except in the first half of an update, where the
; new version still needs the folder. A copy still running is removed at the next restart.
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro NOOK_UPDATING
  Exch $0
  ${If} $0 = 0
    SetShellVarContext current
    RMDir /r /REBOOTOK "$LOCALAPPDATA\${BUNDLEID}\nook\bin"
  ${EndIf}
  Pop $0
!macroend
