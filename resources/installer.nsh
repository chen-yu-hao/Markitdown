!macro customInstall
  Delete "$INSTDIR\portable.json"
  WriteRegStr HKCU "Software\Classes\Applications\Markedown.exe" "FriendlyAppName" "Markedown"
  WriteRegStr HKCU "Software\Classes\Applications\Markedown.exe\shell\open\command" "" '$\"$INSTDIR\Markedown.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\.md\OpenWithList\Markedown.exe" "" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithList\Markedown.exe" "" ""
  WriteRegStr HKCU "Software\Classes\Applications\Markedown.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\Markedown.exe\SupportedTypes" ".markdown" ""
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\Markedown.exe"
  DeleteRegKey HKCU "Software\Classes\.md\OpenWithList\Markedown.exe"
  DeleteRegKey HKCU "Software\Classes\.markdown\OpenWithList\Markedown.exe"
!macroend
