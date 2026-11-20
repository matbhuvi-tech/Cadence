; Cadence Unified Windows Installer (Desktop + Optional Local Playback Engine)
; Packages Cadence Desktop and Cadence Playback Engine behind selectable setup components.

!include "MUI2.nsh"
!include "Sections.nsh"
!include "LogicLib.nsh"

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.0"
!endif
!ifndef DESKTOP_INSTALLER
  !error "DESKTOP_INSTALLER must be defined"
!endif
!ifndef ENGINE_INSTALLER
  !error "ENGINE_INSTALLER must be defined"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\..\src-tauri\target\release\bundle\nsis\Cadence_${PRODUCT_VERSION}_x64-setup.exe"
!endif

!define MUI_ICON "..\..\src-tauri\icons\icon.ico"
!define MUI_COMPONENTSPAGE_SMALLDESC

Name "Cadence"
Caption "Cadence ${PRODUCT_VERSION} Setup"
OutFile "${OUT_FILE}"
RequestExecutionLevel user

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "Cadence has been installed. You can launch Cadence Desktop from the Start Menu or Desktop shortcut."
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Section "Cadence Desktop (Browse, Listen & Curate)" SecDesktop
  SectionIn RO
  InitPluginsDir
  File "/oname=$PLUGINSDIR\cadence-desktop-setup.exe" "${DESKTOP_INSTALLER}"
  DetailPrint "Installing Cadence Desktop..."
  ExecWait '"$PLUGINSDIR\cadence-desktop-setup.exe" /S' $0
  IntCmp $0 0 desktop_ok
    DetailPrint "Cadence Desktop installer failed with exit code $0."
    SetErrors
    Abort
  desktop_ok:
SectionEnd

Section "Cadence Local Playback Engine (This PC)" SecEngine
  InitPluginsDir
  File "/oname=$PLUGINSDIR\cadence-engine-setup.exe" "${ENGINE_INSTALLER}"
SectionEnd

Section /o "Configure Windows Firewall for LAN & Mobile Remote" SecFirewall
  ; Executed via /FIREWALL in SecRunEngine when SecEngine is also selected
SectionEnd

Section /o "Run Local Engine as Windows Service (Headless)" SecService
  ; Executed via /SERVICE or /TRAY in SecRunEngine when SecEngine is also selected
SectionEnd

Section "-RunEngineInstaller" SecRunEngine
  ${If} ${SectionIsSelected} ${SecEngine}
    DetailPrint "Installing Cadence Local Playback Engine..."
    StrCpy $0 "/S"
    ${If} ${SectionIsSelected} ${SecFirewall}
      StrCpy $0 "$0 /FIREWALL"
    ${EndIf}
    ${If} ${SectionIsSelected} ${SecService}
      StrCpy $0 "$0 /SERVICE"
    ${Else}
      StrCpy $0 "$0 /TRAY"
    ${EndIf}
    ExecWait '"$PLUGINSDIR\cadence-engine-setup.exe" $0' $1
    IntCmp $1 0 engine_ok
      DetailPrint "Cadence Playback Engine installer failed with exit code $1."
      SetErrors
      Abort
    engine_ok:
  ${EndIf}
SectionEnd

Function .onInit
  nsExec::ExecToStack 'sc.exe query CadencePlaybackEngine'
  Pop $0
  Pop $1
  ${If} $0 == 0
    !insertmacro SelectSection ${SecService}
  ${EndIf}
FunctionEnd

Function .onSelChange
  ${Unless} ${SectionIsSelected} ${SecEngine}
    !insertmacro UnselectSection ${SecFirewall}
    !insertmacro UnselectSection ${SecService}
  ${EndUnless}
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Cadence Desktop controller for browsing, listening, and catalog curation. Connects to your local or NAS Playback Engine."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecEngine} "Local Windows Playback Engine (WASAPI Exclusive / ASIO / UPnP on this PC). Uncheck if connecting only to a Linux or TrueNAS NAS Engine."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecFirewall} "Adds Windows Firewall (Private profile) allow rules for TCP 4040/18890 and UDP 1900/5353 so your Mobile Remote and UPnP renderers can reach this PC. Requests Administrator permission once."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecService} "Registers and starts Cadence as an automatic Windows Service (no tray icon), sharing your Cadence library and pairing identity in %LOCALAPPDATA%\CadenceEngine so switching modes keeps your library intact. Recommended for headless audio PCs; uncheck for user-tray mode (recommended for desktop and USB DAC/ASIO setups)."
!insertmacro MUI_FUNCTION_DESCRIPTION_END
