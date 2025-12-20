<p align="center">
    <img src="extension/logo.svg" alt="WebBT for Firefox Logo" width="120"/>
</p>

# WebBT for Firefox

This extension enables Web Bluetooth in Firefox on Windows 10 and Windows 11. See [Credits](#credits) for details about the history of this repository including the origin of this fork.

## Installation

1. You need to have Windows 10 Creators Update (version 1703 / build 15063) or newer, and Firefox 128 or newer.
    * Note: reading `txPower` requires Windows 10 version 2004 (build 19041) or newer.
2. Install [the WebBT Firefox extension](https://addons.mozilla.org/firefox/addon/webbt/) and run the provided [WebBT server installer](https://github.com/stevennyman/webbt/releases/latest).

That's it! Enjoy Web Bluetooth in Firefox :-)

## Troubleshooting

1. If the application is unable to pair your devices (for example throwing an `Unreachable` exception during pairing), rebooting both your computer and your Bluetooth device may solve the problem. You can also try unpairing the devices from each other from the settings on both devices and/or turning Bluetooth off then back on again. On Windows, this can be done from the [Settings app](ms-settings:bluetooth).

### Installation issues
1. Open the Devtools console of any web page, and look for the message: "WebBT loaded". If you don't see this message, it means that either the extension was not installed correctly, or you already have something setting the `navigator.bluetooth` object to some value.
2. Follow these [instructions on the original repo](https://github.com/urish/web-bluetooth-polyfill/issues/21#issuecomment-308990559) to debug the background page of the extension.

<details>
<summary>Less Common Installation Issues</summary>
    
1. Run the `winver` program to verify that you have Windows 10 Creators Update or later. It should display: "Version 1703 (OS Build 15063.413)" or higher.
2. Try to running `C:\Program Files (x86)\WebBT Server for Firefox\BLEServer.exe` manually. If an error message containing something like `"VCRUNTIME140.dll is missing"` appears, try manually installing [Visual C++ Redistributable for Visual Studio 2015-2022 (x86)](https://aka.ms/vs/17/release/vc_redist.x86.exe). Then launch `C:\Program Files (x86)\WebBT Server for Firefox\BLEServer.exe` one more time. If a black window containing `[{"_type":"Start","apiVersion":1,"serverName":"bleserver-win-cppcx","serverVersion":"0.5.3"}` appears, then the BLEServer is working correctly. Although since Windows 10 build 1709 it can still be blocked from running by Windows Defender SmartScreen so Firefox won't be able to start it by itself. You may disable SmartScreen for applications and programs in Windows Defender settings. It's also worth making sure that `WebBT Server for Firefox` folder and files inside have Windows' users permissions for read, write and execute ( Right Click -> Properties -> Security ).
   
</details>

## Current State

TL;DR - Should work out of the box with most Web Bluetooth apps. Currently Windows-only.

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
- Rewrite BLEServer to enable cross-platform usage, possibly using Rust and the Bluest library
- Implement all remaining APIs
- Add timeout/page hide event to scanning and other operations as needed

## Developing

1. Open the Visual Studio solution and compile the project.
2. Open the Inno Setup (`.iss`) file and compile and run the installer.
3. Install the extension into Firefox using `about:debugging`.
4. (Optional) Names for GATT characteristics, descriptors, and services can be updated/synchronized with the Bluetooth SIG assigned numbers by updating the `Bluetooth_SIG_UUIDs` submodule then running `update_uuids.py`.

## Credits

This extension is a fork and expansion of the deprecated [Web Bluetooth Polyfill by Uri Shaked](https://github.com/urish/web-bluetooth-polyfill), which provided an implementation of Web Bluetooth for Chrome on Windows before it was provided as part of the browser. This fork adds a number of additional features that weren't implemented in the original extension to cover a more complete portion of the Web Bluetooth specification, allows pairing devices that require authentication, adds Firefox support, improves privacy/security, and also adds a simpler installer. See [this comparison](https://github.com/stevennyman/web-bluetooth-firefox/compare/73ba353a889ce6d7136637bd104875a3d5ee651f...master) for details.
