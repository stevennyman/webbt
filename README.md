<p align="center">
    <img src="extension/logo.svg" alt="WebBT for Firefox Logo" width="120"/>
</p>

# WebBT for Firefox

This extension enables Web Bluetooth in Firefox on Windows, macOS, and Linux (experimental). See [Credits](#credits) for details about the history of this repository including the origin of this fork.

## System Requirements

* Firefox 128 or newer
* One of the following operating systems:
    * Windows 10 Creators Update (version 1703 / build 15063) or newer
        * All features generally supported. Reading `txPower` on Windows requires Windows 10 version 2004 (build 19041) or newer.
    * macOS 10.15+
        * Most features generally supported, though the macOS system has some limitations including reduced support for reading descriptors, no access to extended characteristic properties, no `appearance` property on advertisements, cannot subscribe to ANCS/AMS, etc.
    * Linux (experimental)
        * All features generally supported; support is considered experimental because of `bluez` reliability issues with connecting to devices.

## Installation

1. Install [the WebBT Firefox extension](https://addons.mozilla.org/firefox/addon/webbt/)
2. Run the provided [WebBT server installer](https://github.com/stevennyman/webbt/releases/latest) for your platform.

That's it! Enjoy Web Bluetooth in Firefox :-)

## Troubleshooting

1. (All Operating Systems) If the application is unable to pair your devices (for example throwing an `Unreachable` exception during pairing), rebooting both your computer and your Bluetooth device may solve the problem. You can also try unpairing the devices from each other from the settings on both devices and/or turning Bluetooth off then back on again. On Windows, this can be done from the [Settings app](ms-settings:bluetooth).

2. (Windows, Linux) Try first pairing your device in your OS Settings before using it with a website.

3. (Linux) With dual-mode Bluetooth devices, `bluez` may try to connect to legacy Bluetooth rather than Bluetooth LE, leading to connection errors. Consider unpairing your device from your system if this happens.

4. (Linux, potentially Windows) Devices using resolvable private addresses may not automatically re-pair with devices the second time they are used, as device permissions are stored using the address known upon connection time rather than the address used once paired.

5. (Linux) In some cases, turning off Bluetooth or disconnecting your device from your Linux UI or CLI might cause issues with re-connecting your device until Linux is restarted.

6. (Linux) Consider updating the version of `bluez` installed on your system, available from https://github.com/bluez/bluez. Updating your kernel might also help.

### Installation issues

1. Open the Devtools console of any web page, and look for the message: "WebBT loaded". If you don't see this message, it means that either the extension was not installed correctly, or you already have something setting the `navigator.bluetooth` object to some value.
2. Follow these [instructions on the original repo](https://github.com/urish/web-bluetooth-polyfill/issues/21#issuecomment-308990559) to debug the background page of the extension.

<details>
<summary>Less Common Installation Issues (Windows)</summary>
    
1. Run the `winver` program to verify that you have Windows 10 Creators Update or later. It should display: "Version 1703 (OS Build 15063.413)" or higher. Or use macOS 10.15+ or Linux.
2. Try to running `C:\Program Files (x86)\WebBT Server for Firefox\BLEServer.exe` manually. If an error message containing something like `"VCRUNTIME140.dll is missing"` appears, try manually installing [Visual C++ Redistributable for Visual Studio 2015-2022 (x86)](https://aka.ms/vs/17/release/vc_redist.x86.exe). Then launch `C:\Program Files (x86)\WebBT Server for Firefox\BLEServer.exe` one more time. If a black window containing `[{"_type":"Start","apiVersion":2,"serverName":"rust-server","serverVersion":"0.6.0"}` appears, then the BLEServer is working correctly. Although since Windows 10 build 1709 it can still be blocked from running by Windows Defender SmartScreen so Firefox won't be able to start it by itself. You may disable SmartScreen for applications and programs in Windows Defender settings. It's also worth making sure that `WebBT Server for Firefox` folder and files inside have Windows' users permissions for read, write and execute ( Right Click -> Properties -> Security ).
   
</details>

## Uninstallation

If you encountered a bug, please feel free to open an issue.

First, uninstall the extension from Firefox by visiting `about:addons`. Then, follow the instructions for your platform to uninstall WebBT Server.

### Windows

Use the System settings app. Go to Apps > Installed apps (you can use the URL `ms-settings:appsfeatures` to go directly to this page), select the `...` next to `WebBT Server for Firefox`, select Uninstall, and follow the prompts.

### macOS

To uninstall on macOS, run [installer/macos/uninstall.sh](installer/macos/uninstall.sh) from a terminal. If you installed systemwide, run it with `sudo`.

### Linux

To uninstall on Linux, run the `uninstall.sh` script that was copied into the install directory:

- Per-user install: `"$HOME/.local/share/webbt-server/uninstall.sh"`
- System-wide install: `sudo /opt/webbt-server/uninstall.sh`

## Current State

TL;DR - Should work out of the box with most Web Bluetooth apps.

Most of the functionality is already there, but there might be slight differences between the current implementation and the spec.

List of API methods / events and their implementation status:

- [X] requestDevice
- [X] getAvailability
- [X] Device Chooser UI
- [X] Device Chooser filtering (manufacturerData, serviceData, companyIdentifier, dataPrefix, mask, exclusionFilters)
- [X] watchAdvertisements
- [X] getDevices
- [X] forgetDevice
- [X] gatt.connect
- [X] gatt.disconnect
- [X] gattserverdisconnected event
- [ ] serviceadded / servicechanged / serviceremoved events ([#3 on original repo](https://github.com/urish/web-bluetooth-polyfill/issues/3))
- [X] getPrimaryService / getPrimaryServices
- [X] getCharacteristic / getCharacteristics
- [X] writeValue
- [X] writeValueWithResponse
- [X] writeValueWithoutResponse
- [X] readValue
- [X] startNotifications / characteristicvaluechanged event
- [X] stopNotifications
- [ ] getIncludedService / getIncludedServices ([#5 on original repo](https://github.com/urish/web-bluetooth-polyfill/issues/5))
- [X] getDescriptor / getDescriptors ([#6 on original repo](https://github.com/urish/web-bluetooth-polyfill/issues/6))
- [X] descriptor readValue
- [X] descriptor writeValue
- [ ] requestLEScan
- [ ] availabilityChanged event
- [ ] referringDevice ?
- [ ] watchingAdvertisements property
- [ ] TODO add additional entries for this list

## Future Work
- Implement all remaining APIs
- Add timeout/page hide event to scanning and other operations as needed

## Developing

### Required tools

* Rust toolchain for your platform and CPU architecture (we currently build for x86 (excluding macOS), x64, and ARM64)
* Git
* Firefox 128 or later
* Inno Setup (for building the Windows installer)
* Xcode Command Line Tools (for building the macOS installer)
* Microsoft Visual C++ v14 Redistributable (required on Windows for both the Rust and legacy C++ BLEServer)
* Visual Studio 2022 or 2026 Community Edition with "Desktop development with C++" workload installed (for building the legacy Windows C++ BLEServer; Rust also needs this but current only recognizes Visual Studio 2022)
* BlueZ (required on Linux)

### Steps
1. In the `rust_server` directory, run `cargo build`. (For the legacy Windows C++ BLEServer: Open the Visual Studio solution and compile the project.)
2. Tp build the Windows installer, open the Inno Setup (`.iss`) file and compile and run the installer. (For the legacy Windows C++ BLEServer: Remove `#define USE_RUST`.) To build the macOS pkg, compile `rust_server` for both macOS targets and run `installer/macos/build-pkg.sh`. To build the Linux tarball, compile `rust_server` for all three Linux targets (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `i686-unknown-linux-gnu`) and run `installer/linux/build-tarball.sh`.
4. Install the extension into Firefox using `about:debugging`.
5. (Optional) Names for GATT characteristics, descriptors, and services can be updated/synchronized with the Bluetooth SIG assigned numbers by updating the `Bluetooth_SIG_UUIDs` submodule then running `update_uuids.py`.

## Credits

This extension is a fork and expansion of the deprecated [Web Bluetooth Polyfill by Uri Shaked](https://github.com/urish/web-bluetooth-polyfill), which provided an implementation of Web Bluetooth for Chrome on Windows before it was provided as part of the browser. This fork adds a number of additional features that weren't implemented in the original extension to cover a more complete portion of the Web Bluetooth specification, allows pairing devices that require authentication, adds Firefox support, improves privacy/security, and also adds a simpler installer. See [this comparison](https://github.com/stevennyman/web-bluetooth-firefox/compare/73ba353a889ce6d7136637bd104875a3d5ee651f...master) for details.
