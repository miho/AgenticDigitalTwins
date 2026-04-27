; Hamilton STAR Digital Twin — NSIS customization for electron-builder.
; Adds Start Menu shortcuts for the standalone Method Editor and the MCP server,
; and cleans them up on uninstall.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Method Editor.lnk" \
    "$INSTDIR\resources\launchers\run-editor.bat" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\MCP Server.lnk" \
    "$INSTDIR\resources\launchers\run-mcp.bat" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Method Editor.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\MCP Server.lnk"
!macroend
