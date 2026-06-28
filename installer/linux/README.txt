WebBT Server for Firefox (Linux)
================================

This package contains the native application component required by the WebBT Firefox extension, which brings Web Bluetooth support to Firefox.

Files in this package:
- install.sh    : Installer script (detects CPU architecture and installs the correct binary).
- uninstall.sh  : Uninstaller script.
- README.txt    : This file.
- LICENSE.txt   : MIT license for WebBT.
- bin/          : Contains precompiled BLEServer binaries for x86_64, aarch64, and i686. Installer script places these in the right place and registers them for use with Firefox.

Installation
------------

1. Open a terminal in this directory.
2. Run the installer script:

   - To install for the CURRENT USER only:
     ./install.sh

   - To install SYSTEM-WIDE for all users:
     sudo ./install.sh

3. Install the WebBT extension in Firefox:
   - From Mozilla Add-ons:  https://addons.mozilla.org/firefox/addon/webbt/
   - Or download the .xpi file from the GitHub releases:
     https://github.com/stevennyman/webbt/releases

Uninstallation
--------------

To uninstall, run the uninstall script:

- If you installed for the current user:
  ~/.local/share/webbt-server/uninstall.sh

- If you installed system-wide:
  sudo /opt/webbt-server/uninstall.sh

Troubleshooting
---------------

- Ensure BlueZ is installed and the bluetooth service is running:
  systemctl is-active bluetooth

- If you see a warning about the 'bluetooth' group during installation, add your user to the group:
  sudo usermod -aG bluetooth $USER
  (Then log out and back in)

- For Flatpak Firefox:
  Flatpak Firefox is heavily sandboxed and cannot communicate with the host by default. The installer will attempt to run the following command automatically to grant it permission to spawn the host process. If it fails, or if you need to apply it manually, run:
  flatpak override --user --talk-name=org.freedesktop.Flatpak org.mozilla.firefox

  If you wish to revoke this permission later for security reasons, run:
  flatpak override --user --unset-talk-name=org.freedesktop.Flatpak org.mozilla.firefox

- See also the GitHub repository for the WebBT project:
  https://github.com/stevennyman/webbt

- Support is available in the GitHub Discussions page:
  https://github.com/stevennyman/webbt/discussions
