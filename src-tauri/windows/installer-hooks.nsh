; Installer hooks for HDS (Hive Document Studio).
;
; The app used to be called "HDF Studio". The Windows installer keys its install folder, Start menu
; shortcut and Add/Remove Programs entry on the product name, so the first HDS install (including the
; in-app auto-update, which runs this installer with /UPDATE /P) would otherwise land next to the old
; copy and leave the old shortcuts pointing at the old version. These hooks move an existing
; HDF Studio install over to HDS:
;   - close the old app if it is still running
;   - replace the old Start menu and desktop shortcuts with HDS ones, and repoint a taskbar pin
;   - remove the old program files and the old Add/Remove Programs entry
; Settings are untouched: they live under the bundle identifier (com.hiveeng.hdfstudio), which HDS keeps.
; The old uninstaller is deliberately not run, because it would delete the .pdf file association
; that HDS has just registered under the same class name.

!define OLD_PRODUCTNAME "HDF Studio"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\HDF Studio"
!define OLD_MANUPRODUCTKEY "Software\hiveeng\HDF Studio"
!define OLD_TASKBAR_PIN "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\HDF Studio.lnk"

Var OldHdfDir
Var OldHdfExe

!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldHdfDir ""
  StrCpy $OldHdfExe ""
  ReadRegStr $R8 SHCTX "${OLD_MANUPRODUCTKEY}" ""
  ${If} $R8 == ""
    ; Fall back to the Add/Remove Programs entry, which stores the folder in quotes.
    ReadRegStr $R8 SHCTX "${OLD_UNINSTKEY}" "InstallLocation"
    nsis_tauri_utils::StrReplace "$R8" '"' ""
    Pop $R8
  ${EndIf}
  ${If} $R8 != ""
  ${AndIf} $R8 != $INSTDIR
    ReadRegStr $R9 SHCTX "${OLD_UNINSTKEY}" "MainBinaryName"
    ${If} $R9 == ""
      StrCpy $R9 "${OLD_PRODUCTNAME}.exe"
    ${EndIf}
    ${If} ${FileExists} "$R8\$R9"
      StrCpy $OldHdfDir $R8
      StrCpy $OldHdfExe $R9
      !insertmacro CheckIfAppIsRunning "$OldHdfDir\$OldHdfExe" "${OLD_PRODUCTNAME}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $OldHdfDir != ""
    DetailPrint "Moving HDF Studio over to ${PRODUCTNAME}"

    ; Start menu: the installer skips shortcuts in update mode, so make the HDS one here.
    ${If} ${FileExists} "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
    ${EndIf}
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Desktop: only if they had one before.
    ${If} ${FileExists} "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}

    ; Taskbar pin: Windows doesn't let installers pin, so keep the existing pin working by pointing it at HDS.
    ${If} ${FileExists} "${OLD_TASKBAR_PIN}"
      !insertmacro SetShortcutTarget "${OLD_TASKBAR_PIN}" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}

    ; Old program files: only the files the old installer put there, then the folder if it is empty.
    Delete "$OldHdfDir\$OldHdfExe"
    Delete "$OldHdfDir\uninstall.exe"
    RMDir "$OldHdfDir"

    DeleteRegKey SHCTX "${OLD_UNINSTKEY}"
    DeleteRegKey SHCTX "${OLD_MANUPRODUCTKEY}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${OLD_PRODUCTNAME}"
  ${EndIf}
!macroend
