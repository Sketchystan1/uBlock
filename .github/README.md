# uBlock Origin (MV3 build)

The real uBlock Origin, with the full engine, rebuilt for Manifest V3 so it still works on Chrome 139+ after the old MV2 version stopped working.

Just a fork. All credit to [gorhill/uBlock](https://github.com/gorhill/uBlock).

## Install

Chrome removed [webRequestBlocking](https://developer.chrome.com/docs/extensions/reference/api/webRequest). The only way to get it back is to install the extension through enterprise policy. Other Chromium-based browsers probably use similar methods. Point Chrome to the update URL and allowlist the extension ID. This installs uBO and keeps it updated automatically. 

ID: `cbmpaamhmhdhnkofemgdlnbdadbpmjkn`.
Update URL: `https://sketchystan1.github.io/uBlock/update.xml` (use `update-dev.xml` for beta builds).

### Windows
Download [ublock.reg](ublock.reg) and double-click, or use script:

```powershell
$ID="cbmpaamhmhdhnkofemgdlnbdadbpmjkn"; $U="https://sketchystan1.github.io/uBlock/update.xml"; New-Item -Force "HKCU:\SOFTWARE\Google\Chrome\Extensions\$ID" | Out-Null; Set-ItemProperty "HKCU:\SOFTWARE\Google\Chrome\Extensions\$ID" update_url $U; New-Item -Force "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist" | Out-Null; Set-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist" 1 $ID
```

### Linux

```sh
ID=cbmpaamhmhdhnkofemgdlnbdadbpmjkn && sudo mkdir -p /opt/google/chrome/extensions /etc/opt/chrome/policies/managed && echo "{\"external_update_url\":\"https://sketchystan1.github.io/uBlock/update.xml\"}" | sudo tee /opt/google/chrome/extensions/$ID.json && echo "{\"ExtensionInstallAllowlist\":[\"$ID\"]}" | sudo tee /etc/opt/chrome/policies/managed/ublock.json
```

### macOS

```sh
ID=cbmpaamhmhdhnkofemgdlnbdadbpmjkn && sudo mkdir -p "/Library/Application Support/Google/Chrome/External Extensions" "/Library/Managed Preferences" && echo "{\"external_update_url\":\"https://sketchystan1.github.io/uBlock/update.xml\"}" | sudo tee "/Library/Application Support/Google/Chrome/External Extensions/$ID.json" && sudo defaults write "/Library/Managed Preferences/com.google.Chrome" ExtensionInstallAllowlist -array $ID
```

## Uninstall
<details>
<summary>Details</summary>

**Windows**

```powershell
$ID="cbmpaamhmhdhnkofemgdlnbdadbpmjkn"; Remove-Item "HKCU:\SOFTWARE\Google\Chrome\Extensions\$ID" -Recurse; Remove-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist" 1
```

**Linux**

```sh
ID=cbmpaamhmhdhnkofemgdlnbdadbpmjkn && sudo rm -f /opt/google/chrome/extensions/$ID.json /etc/opt/chrome/policies/managed/ublock.json
```

**macOS**

```sh
ID=cbmpaamhmhdhnkofemgdlnbdadbpmjkn && sudo rm "/Library/Application Support/Google/Chrome/External Extensions/$ID.json" && sudo defaults delete "/Library/Managed Preferences/com.google.Chrome" ExtensionInstallAllowlist
```

Chrome removes uBO on next restart.

</details>

## Donate

USDT (TRC20): TDAr6Lu2sYtArJYAgUpyfuk6rKNvvyMA87  
USDC (Base): 0x762712dcC8e3E757Cf3FC077AeF0b4EDa8692b7B

