!macro customInstall
  Delete "$INSTDIR\portable.json"
  WriteRegStr HKCU "Software\Classes\Applications\Markit.exe" "FriendlyAppName" "Markit"
  WriteRegStr HKCU "Software\Classes\Applications\Markit.exe\shell\open\command" "" '$\"$INSTDIR\Markit.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\.md\OpenWithList\Markit.exe" "" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithList\Markit.exe" "" ""
  WriteRegStr HKCU "Software\Classes\Applications\Markit.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\Markit.exe\SupportedTypes" ".markdown" ""
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\Markit.exe"
  DeleteRegKey HKCU "Software\Classes\.md\OpenWithList\Markit.exe"
  DeleteRegKey HKCU "Software\Classes\.markdown\OpenWithList\Markit.exe"
!macroend
