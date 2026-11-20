; Cadence Playback Engine (Windows) NSIS Installer Script
; Builds cadence-engine-setup.exe independently of the thin Desktop Frontend.

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"
!include "LogicLib.nsh"

!insertmacro GetParameters
!insertmacro GetOptions

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.0"
!endif

!define MUI_ICON "..\..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\..\src-tauri\icons\icon.ico"
!define UNINSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CadencePlaybackEngine"
!define MUI_COMPONENTSPAGE_SMALLDESC

Name "Cadence Playback Engine"
OutFile "..\..\src-tauri\target\release\bundle\nsis\cadence-engine-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\CadenceEngine"
RequestExecutionLevel user

Var WasServiceInstalled

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Cadence Playback Engine (Core)" SecEngine
  SectionIn RO

  ; Gracefully stop any running tray engine instance before upgrading files
  IfFileExists "$INSTDIR\cadence-engine.exe" 0 skip_pre_stop
    nsExec::ExecToLog '"$INSTDIR\cadence-engine.exe" --stop'
    Pop $0
  skip_pre_stop:

  ; Stop any active Windows Service so cadence-engine.exe can be overwritten cleanly
  ${If} $WasServiceInstalled == "1"
    DetailPrint "Stopping existing Cadence Playback Engine Windows Service..."
    IfFileExists "$INSTDIR\Configure-CadenceHost.ps1" 0 legacy_svc_stop
      nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Configure-CadenceHost.ps1" -EngineExe "$INSTDIR\cadence-engine.exe" -StopService'
      Pop $0
      Goto after_svc_stop
    legacy_svc_stop:
      nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath sc.exe -ArgumentList ''stop CadencePlaybackEngine'' -Verb RunAs -Wait"'
      Pop $0
    after_svc_stop:
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "..\..\src-tauri\target\release\cadence-engine.exe"
  File /oname=cadence-engine.ico "..\..\src-tauri\icons\icon.ico"
  File "Configure-CadenceFirewall.ps1"
  File "Configure-CadenceHost.ps1"

  ; Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\Cadence Playback Engine"
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Cadence Playback Engine.lnk" "$INSTDIR\cadence-engine.exe" "" "$INSTDIR\cadence-engine.ico" 0
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Migrate Legacy Cadence DB.lnk" "$INSTDIR\cadence-engine.exe" "--migrate-legacy-db" "$INSTDIR\cadence-engine.ico" 0
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Configure Windows Firewall (LAN Access).lnk" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Configure-CadenceFirewall.ps1"' "$INSTDIR\cadence-engine.ico" 0
  CreateShortcut "$SMPROGRAMS\Cadence Playback Engine\Uninstall Cadence Playback Engine.lnk" "$INSTDIR\Uninstall.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Register in Windows Settings -> Installed Apps (Add/Remove Programs)
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayName" "Cadence Playback Engine"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "Publisher" "Cadence"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayIcon" "$INSTDIR\cadence-engine.ico"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "URLInfoAbout" "https://github.com/matbhuvi-tech/Cadence"
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "EstimatedSize" $0
SectionEnd

Section /o "Configure Windows Firewall for LAN Access" SecFirewall
  ; Handled in SecFinalize in a single elevated helper invocation
SectionEnd

Section /o "Install as Windows Service (Headless Audio Server)" SecService
  ; Handled in SecFinalize in a single elevated helper invocation
SectionEnd

Section "-Finalize" SecFinalize
  ; Auto-import legacy %APPDATA%\cadence.db into %LOCALAPPDATA%\CadenceEngine before Tray or Service starts
  IfFileExists "$LOCALAPPDATA\CadenceEngine\cadence.db" skip_legacy_migration 0
    nsExec::ExecToLog '"$INSTDIR\cadence-engine.exe" --migrate-legacy-db'
    Pop $0
  skip_legacy_migration:

  StrCpy $0 ""
  StrCpy $1 "0"

  ${If} ${SectionIsSelected} ${SecService}
    StrCpy $0 "$0 -InstallService"
  ${ElseIf} $WasServiceInstalled == "1"
    StrCpy $0 "$0 -UninstallService"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecFirewall}
    StrCpy $0 "$0 -ConfigureFirewall"
  ${EndIf}

  ${If} $0 != ""
    DetailPrint "Configuring Windows host options (administrator permission may be requested once)..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Configure-CadenceHost.ps1" -EngineExe "$INSTDIR\cadence-engine.exe" -DataDir "$LOCALAPPDATA\CadenceEngine"$0'
    Pop $2
    ${If} $2 != 0
      DetailPrint "Host configuration exited with code $2 (re-run Configure-CadenceHost.ps1 or Start Menu shortcuts as Administrator)."
      ${If} $WasServiceInstalled == "1"
        nsExec::ExecToStack 'sc.exe query CadencePlaybackEngine'
        Pop $3
        Pop $4
        ${If} $3 == 0
          StrCpy $1 "1"
        ${EndIf}
      ${EndIf}
    ${Else}
      ${If} ${SectionIsSelected} ${SecService}
        StrCpy $1 "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $1 == "1"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CadencePlaybackEngine"
    DetailPrint "Cadence Playback Engine is installed and running as a Windows Service."
  ${Else}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CadencePlaybackEngine" '"$INSTDIR\cadence-engine.exe" --autostart'
    Exec '"$INSTDIR\cadence-engine.exe"'
  ${EndIf}
SectionEnd

Function .onInit
  StrCpy $WasServiceInstalled "0"

  nsExec::ExecToStack 'sc.exe query CadencePlaybackEngine'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $WasServiceInstalled "1"
    !insertmacro SelectSection ${SecService}
  ${EndIf}

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/FIREWALL" $R1
  ${Unless} ${Errors}
    !insertmacro SelectSection ${SecFirewall}
  ${EndUnless}

  ClearErrors
  ${GetOptions} $R0 "/SERVICE" $R1
  ${Unless} ${Errors}
    !insertmacro SelectSection ${SecService}
  ${EndUnless}

  ClearErrors
  ${GetOptions} $R0 "/TRAY" $R1
  ${Unless} ${Errors}
    !insertmacro UnselectSection ${SecService}
  ${EndUnless}
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecEngine} "Installs the bit-perfect Cadence Playback Engine (WASAPI Exclusive, ASIO, UPnP), Start Menu shortcuts, and user tray autostart."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecFirewall} "Adds Windows Defender Firewall (Private network) allow rules for TCP 4040/18890 and UDP 1900/5353 so LAN remotes and UPnP renderers can connect. Requests Administrator permission once."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecService} "Registers and starts Cadence as an automatic Windows Service sharing your Cadence library and pairing identity in %LOCALAPPDATA%\CadenceEngine (no duplicate engine or lost library when toggling modes; CLI service install still defaults to %ProgramData%\CadenceEngine). User-tray mode is recommended for session-scoped USB DAC/ASIO setups."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  IfFileExists "$INSTDIR\cadence-engine.exe" 0 skip_uninstall_stop
    nsExec::ExecToLog '"$INSTDIR\cadence-engine.exe" --stop'
    Pop $0
  skip_uninstall_stop:
  IfFileExists "$INSTDIR\Configure-CadenceHost.ps1" 0 skip_host_cleanup
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Configure-CadenceHost.ps1" -EngineExe "$INSTDIR\cadence-engine.exe" -UninstallCleanup'
    Pop $0
  skip_host_cleanup:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CadencePlaybackEngine"
  DeleteRegKey HKCU "${UNINSTALL_REG_KEY}"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Cadence Playback Engine.lnk"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Migrate Legacy Cadence DB.lnk"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Configure Windows Firewall (LAN Access).lnk"
  Delete "$SMPROGRAMS\Cadence Playback Engine\Uninstall Cadence Playback Engine.lnk"
  RMDir "$SMPROGRAMS\Cadence Playback Engine"
  Delete "$INSTDIR\cadence-engine.exe"
  Delete "$INSTDIR\cadence-engine.ico"
  Delete "$INSTDIR\Configure-CadenceFirewall.ps1"
  Delete "$INSTDIR\Configure-CadenceHost.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
