; Cadence Playback Engine (Windows) NSIS Installer Script
; Builds cadence-engine-setup.exe independently of the thin Desktop Frontend.

!include "MUI2.nsh"

!define MUI_ICON "..\..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\..\src-tauri\icons\icon.ico"

Name "Cadence Playback Engine"
OutFile "..\..\src-tauri\target\release\bundle\nsis\cadence-engine-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\CadenceEngine"
RequestExecutionLevel user

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Cadence Playback Engine" SecEngine
  ; Gracefully stop any running engine instance before upgrading files
  IfFileExists "$INSTDIR\cadence-engine.exe" 0 skip_pre_stop
    nsExec::ExecToLog '"$INSTDIR\cadence-engine.exe" --stop'
  skip_pre_stop:

  SetOutPath "$INSTDIR"
  File "..\..\src-tauri\target\release\cadence-engine.exe"
  File /oname=cadence-engine.ico "..\..\src-tauri\icons\icon.ico"

  ; Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\Cadence Playback Engine"
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Cadence Playback Engine.lnk" "$INSTDIR\cadence-engine.exe" "" "$INSTDIR\cadence-engine.ico" 0
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Migrate Legacy Cadence DB.lnk" "$INSTDIR\cadence-engine.exe" "--migrate-legacy-db" "$INSTDIR\cadence-engine.ico" 0
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Uninstall Cadence Playback Engine.lnk" "$INSTDIR\Uninstall.exe"

  ; Auto-start silently on Windows login / restart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CadencePlaybackEngine" '"$INSTDIR\cadence-engine.exe"'

  ; Auto-import legacy %APPDATA%\cadence.db on fresh Engine install
  IfFileExists "$LOCALAPPDATA\CadenceEngine\cadence.db" skip_legacy_migration 0
    nsExec::ExecToLog '"$INSTDIR\cadence-engine.exe" --migrate-legacy-db'
  skip_legacy_migration:

  ; Launch the engine immediately after installation
  Exec '"$INSTDIR\cadence-engine.exe"'

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\cadence-engine.exe" 0 skip_uninstall_stop
    nsExec::ExecToLog '"$INSTDIR\cadence-engine.exe" --stop'
  skip_uninstall_stop:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CadencePlaybackEngine"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Cadence Playback Engine.lnk"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Migrate Legacy Cadence DB.lnk"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Uninstall Cadence Playback Engine.lnk"
  RMDir "$SMPROGRAMS\Cadence Playback Engine"
  Delete "$INSTDIR\cadence-engine.exe"
  Delete "$INSTDIR\cadence-engine.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
