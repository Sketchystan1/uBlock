# uBlock Origin (Sketchy MV3 Fork)

Full uBlock Origin, rebuilt for Manifest V3.  
ID: `cbmpaamhmhdhnkofemgdlnbdadbpmjkn`  

Just a fork. All credit to original [gorhill/uBlock](https://github.com/gorhill/uBlock).

## Why

Chrome dropped Manifest V2, so the old uBO stopped working. This fork is MV3.

Under MV3 the blocking APIs still exist: `webRequestBlocking` (cancel a request) and `asyncBlocking` (hold a request until the filters decide). But Chrome now only hands them to an extension that is force-installed by policy on enterprise managed system.

# Install

Extension must be **force-installed** by policy and system look **managed** for browser. Ways to do this: 
- **fake-mdm.reg** - fake mobile device management.
- **version.dll** - fake domain-joined management.
- **Chrome Enterprise Core** - real browser management.

Know another option? Share it in [Discussions](https://github.com/Sketchystan1/uBlock/discussions).

## Windows - choose only one!

### Fake MDM 

Not working in Windows Home.

1. Run [fake-mdm.reg](fake-mdm.reg)
2. Run force install uBO: [chrome.reg](chrome.reg), [edge.reg](edge.reg), [vivaldi.reg](vivaldi.reg), [chromium.reg](chromium.reg), [yandex.reg](yandex.reg).
3. Restart the browser.

### Fake Domain-joined

Not working in Edge.

1. Download [version.dll](https://github.com/Sketchystan1/uBlock/releases/tag/shim-latest) or [build it](version-shim/build.bat).
2. Copy it next to the browser exe, e.g. `C:\Program Files\Google\Chrome\Application\version.dll`.
3. Run force install uBO: [chrome.reg](chrome.reg), [edge.reg](edge.reg), [vivaldi.reg](vivaldi.reg), [chromium.reg](chromium.reg), [yandex.reg](yandex.reg).
4. Restart the browser.

## Chrome Enterprise Core - Windows, macOS

1. Sign up for [Chrome Enterprise Core](https://enterprise.google.com/signup/chrome-browser/email?origin=cbcm&source=browsermgmt) 

2. Get a token: [Google Admin console](https://admin.google.com) → **Devices → Chrome → Managed browsers → Enroll**.
3. Add token to system
   ```powershell
   # Windows
   Set-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome" CloudManagementEnrollmentToken "<YOUR_TOKEN>"
   ```
   ```sh
   # macOS
   sudo mkdir -p /Library/Google/Chrome && echo "<YOUR_TOKEN>" | sudo tee /Library/Google/Chrome/CloudManagementEnrollmentToken
   ```
4. Restart the browser. Open `chrome://management`. It should say managed.
5. Force install uBO: push it from the Admin console or locally run on Windows: [chrome.reg](chrome.reg), [edge.reg](edge.reg), [vivaldi.reg](vivaldi.reg), [chromium.reg](chromium.reg), [yandex.reg](yandex.reg).
   ```sh
   # macOS
   defaults write com.google.Chrome ExtensionSettings -dict cbmpaamhmhdhnkofemgdlnbdadbpmjkn '{ installation_mode = force_installed; update_url = "https://sketchystan1.github.io/uBlock/update.xml"; }'
   # Not Chrome? Swap `com.google.Chrome`, `com.microsoft.Edge`, `com.vivaldi.Vivaldi`, `org.chromium.Chromium` `YandexBrowser`.
   ```
   
6. Restart the browser.

## Linux

No managed device required, only a policy file:

```sh
ID=cbmpaamhmhdhnkofemgdlnbdadbpmjkn && U=https://sketchystan1.github.io/uBlock/update.xml && sudo mkdir -p /etc/opt/chrome/policies/managed && echo "{\"ExtensionSettings\":{\"$ID\":{\"installation_mode\":\"force_installed\",\"update_url\":\"$U\"}}}" | sudo tee /etc/opt/chrome/policies/managed/ublock.json
```
Restart the browser.

# Uninstall
<details>
<summary>How</summary>

**Windows**: double-click the one for your browser: [chrome-uninstall.reg](chrome-uninstall.reg), [edge-uninstall.reg](edge-uninstall.reg), [vivaldi-uninstall.reg](vivaldi-uninstall.reg), [chromium-uninstall.reg](chromium-uninstall.reg), [yandex-uninstall.reg](yandex-uninstall.reg).

To undo the managed part too: run [fake-mdm-undo.reg](fake-mdm-undo.reg), or (Enterprise Core) remove the browser in the Admin console.

**macOS** (Enterprise Core): drop the force-install policy, then the enrollment token:
```sh
defaults delete com.google.Chrome ExtensionSettings; sudo rm -f /Library/Google/Chrome/CloudManagementEnrollmentToken
```
Restart the browser. (Other browser? Swap `com.google.Chrome` for yours — see the install note.)

**Linux**
```sh
sudo rm -f /etc/opt/chrome/policies/managed/ublock.json /opt/google/chrome/extensions/cbmpaamhmhdhnkofemgdlnbdadbpmjkn.json
```

Chrome drops uBO on next restart.

</details>

## Donate

USDT (TRC20): TDAr6Lu2sYtArJYAgUpyfuk6rKNvvyMA87  
USDC (Base): 0x762712dcC8e3E757Cf3FC077AeF0b4EDa8692b7B
