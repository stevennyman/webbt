# Web Bluetooth for Firefox

The Polyfill extension enables Web Bluetooth in Firefox on Windows 10 and Windows 11. 

## Installation

1. You need to have Windows 10 Creators Update (version 1703 / build 15063) or newer, and Firefox 128 or newer.
2. Run the provided installer (coming soon)

That's it! Enjoy Web Bluetooth on Windows :-)

## Developing

1. Open the Visual Studio solution and compile the project.
2. Open the Inno Setup (`.iss`) file and compile and run the installer.
3. Install the extension into Firefox using `about:debugging`.
4. Names can be synchronized with the Bluetooth SIG assigned numbers by updating the submodule then running `update_uuids.py`.

## Troubleshooting

1. Run the `winver` program to verify that you have Windows 10 Creators Update. It should display: "Version 1703 (OS Build 15063.413)" or higher.
2. Try to running `C:\Program Files (x86)\Web Bluetooth Polyfill\BLEServer.exe` manually. If an error message containing something like `"VCRUNTIME140.dll is missing"` appears, install [Visual C++ Redistributable for Visual Studio 2015 (x86)](https://www.microsoft.com/en-us/download/details.aspx?id=48145). Then launch `C:\Program Files (x86)\Web Bluetooth Polyfill\BLEServer.exe` one more time. If a black window containing `{"_type":"Start"}` appears, then the BLEServer is working correctly. Although since Windows 10 build 1709 it can still be blocked from running by Windows Defender SmartScreen so Chrome won't be able to start it by itself. You may disable SmartScreen for applications and programs in Windows Defender settings. It's also worth making sure that `Web Bluetooth Polyfill` folder and files inside have window's users permissions for read, write and execution ( right click -> properties -> security ).
4. Open the Devtools console of any web page, and look for the message: "Web Bluetooth Polyfill loaded". If you don't see this message, it means that either the extension was not installed correctly, or you already have something setting the `navigator.bluetooth` object to some value.
5. Follow the [instructions here](https://github.com/urish/web-bluetooth-polyfill/issues/21#issuecomment-308990559) to debug the background page of the extension.

## Current State

Currently WIP, with work being done to improve the UI as well as the persistent device pairing system. As such a compiled release is not yet available.

Currently Windows-only.

TL;DR - Should work out of the box with most Web Bluetooth apps.

Most of the functionality is already there, but there might be slight differences between the current implementation and the spec.

List of API methods / events and their implementation status:

- [X] requestDevice
- [X] Device Chooser UI 
- [X] gatt.connect
- [X] gatt.disconnect
- [X] gattserverdisconnected event
- [ ] serviceadded / servicechanged / serviceremoved events ([#3](https://github.com/urish/web-bluetooth-polyfill/issues/3))
- [X] getPrimaryService / getPrimaryServices
- [X] getCharacteristic / getCharacteristics
- [X] writeValue
- [X] readValue
- [X] startNotifications / characteristicvaluechanged event
- [X] stopNotifications
- [ ] getIncludedService / getIncludedServices ([#5](https://github.com/urish/web-bluetooth-polyfill/issues/5))
- [X] getDescriptor / getDescriptors ([#6](https://github.com/urish/web-bluetooth-polyfill/issues/6))
- [ ] TODO add additional entries for this list

## Credits

This extension is a fork and expansion of the deprecated [Web Bluetooth Polyfill by Urish](https://github.com/urish/web-bluetooth-polyfill), which provided an implementation of Web Bluetooth for Chrome on Windows before it was provided as part of the browser. This fork adds a number of additional features that weren't implemented in the original extension to cover a more complete portion of the Web Bluetooth specification, adds Firefox support, and also adds a simpler installer.
