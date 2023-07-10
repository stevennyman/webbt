/* global window, document */

// Connect to background script
let port = chrome.runtime.connect();
let chooserUI = null;

port.onMessage.addListener(message => {
    if (message._type === 'showDeviceChooser') {
        if (!chooserUI) {
            chooserUI = new DeviceChooserUI();
            chooserUI.onPair = deviceId => port.postMessage({ cmd: 'chooserPair', deviceId });
            chooserUI.onCancel = () => port.postMessage({ cmd: 'chooserCancel' });
        }
        chooserUI.show();
        return;
    }

    if (message._type === 'scanResult') {
        if (chooserUI) {
            chooserUI.updateDevice(message.bluetoothAddress, message.localName, message.rssi);
        }
        return;
    }

    // actually displaying this confirmation is optional
    // the application is allowed to accept on behalf of the user
    // https://learn.microsoft.com/en-us/uwp/api/windows.devices.enumeration.devicepairingkinds?view=winrt-22621
    if (message._type === 'pairing_confirmOnly') {
        if (confirm('Bluetooth Pairing\n\nPress OK to confirm you would like to pair with your device.')) {
            port.postMessage({ command: 'accept', args: [message._id] });
        } else {
            port.postMessage({ command: 'cancel', args: [message._id] });
        }
        return;
    }

    if (message._type === 'pairing_displayPin') {
        if (confirm('Bluetooth Pairing\n\nUse the following PIN to pair your device: '+message.pin)) {
            port.postMessage({ command: 'accept', args: [message._id] });
        } else {
            port.postMessage({ command: 'cancel', args: [message._id] });
        }
        return;
    }

    if (message._type === 'pairing_confirmPinMatch') {
        if (confirm('Bluetooth Pairing\n\nConfirm the following PIN is displayed on your device: '+message.pin)) {
            port.postMessage({ command: 'accept', args: [message._id] });
        } else {
            port.postMessage({ command: 'cancel', args: [message._id] });
        }
        return;
    }

    // not sure if this is relevant to Bluetooth but it is included in the list of possible ceremonies
    // https://learn.microsoft.com/en-us/uwp/api/windows.devices.enumeration.devicepairingkinds?view=winrt-22621
    if (message._type === 'pairing_providePasswordCredential') {
        let username = prompt('Bluetooth Pairing\n\nEnter the username required to connect to your device:');
        if (username === null) {
            port.postMessage({ command: 'cancel', args: [message._id] });
        }
        let password = prompt('Bluetooth Pairing\n\nEnter the password required to connect to your device:');
        if (password === null) {
            port.postMessage({ command: 'cancel', args: [message._id] });
        }
        port.postMessage({ command: 'acceptPasswordCredential', args: [message._id, username, password] });
        return;
    }

    if (message._type === 'pairing_providePin') {
        let pin = prompt('Bluetooth Pairing\n\nEnter the PIN required to connect to your device:');
        if (pin === null) {
            port.postMessage({ command: 'cancel', args: [message._id] });
        }
        port.postMessage({ command: 'acceptPin', args: [message._id, pin] });
        return;
    }

    window.postMessage(Object.assign({}, message, {
        type: 'WebBluetoothPolyCSToPage',
    }), message.origin || '*');
});

// Listen for Web Bluetooth Requests
window.addEventListener('message', event => {
    if (event.source === window && event.data && event.data.type === 'WebBluetoothPolyPageToCS') {
        port.postMessage(Object.assign({}, event.data, { origin: event.origin }));
    }
}, false);

// Device Chooser UI
class DeviceChooserUI {
    constructor() {
        this.createElements();
        this.onCancel = () => null;
        this.onPair = () => null;
    }

    createElements() {
        this.container = document.createElement('div');
        this.container.style.position = 'fixed';
        this.container.style.zIndex = 99999;
        this.container.style.top = 0;
        this.container.style.left = 0;
        this.container.style.bottom = 0;
        this.container.style.right = 0;
        this.container.addEventListener('click', () => this.cancel());
        document.body.appendChild(this.container);

        const shadowRoot = this.container.attachShadow({ mode: 'closed' });
        this.shadowRoot = shadowRoot;
        shadowRoot.innerHTML = `
            <style>
                #chooser-dialog {
                    width: 380px;
                    background: white;
                    margin: 0 auto;
                    border: solid #bababa 1px;
                    border-radius: 2px;
                    padding: 16px;
                    box-shadow: 0 2px 3px rgba(0,0,0,0.4);
                    user-select: none;
                    color: black;
                    font-family: sans-serif;
                    font-size: initial;
                    text-align: left;
                }

                #device-list {
                    background: #f2f1f0;
                    height: 320px;
                    min-height: 32px;
                    max-height: calc(100vh - 120px);
                    border: solid #9e9e9e 1px;
                    margin: 8px 0;
                    overflow: auto;
                }

                .device-item {
                    padding: 4px 8px;
                    cursor: pointer;
                }

                .device-item:hover {
                    background: #ddddee;
                }

                .device-item.selected {
                    background: #aaaaff;
                    color: white;
                }

                #buttons {
                    display: flex;
                    justify-content: flex-end;
                }

                #buttons button {
                    cursor: pointer;
                    border: solid #c0c0c0 1px;
                    border-radius: 3px;
                    margin-left: 8px;
                    background: #edebea;
                    padding: 4px 12px;
                }

            </style>

            <dialog id="chooser-dialog">
                <span id="hostname"> </span> wants to pair
                <div id="device-list">
                </div>
                <div id="buttons">
                    <button id="btn-cancel">Cancel</button>
                    <button id="btn-pair">Pair</button>
                </div>
                <div id="footer">
                    Powered by <a href="https://github.com/urish/web-bluetooth-polyfill" target="_blank">Web Bluetooth Polyfill</a>
                </div>
            </dialog>
        `;

        this.btnPair = shadowRoot.getElementById('btn-pair');
        this.deviceListElement = shadowRoot.getElementById('device-list');
        this.chooserDialog = shadowRoot.getElementById('chooser-dialog');

        this.chooserDialog.addEventListener('click', e => e.stopPropagation());
        shadowRoot.getElementById('hostname').innerText = document.location.hostname;
        shadowRoot.getElementById('btn-cancel').addEventListener('click', () => this.cancel());
        this.btnPair.addEventListener('click', () => this.pair());
    }

    show() {
        this.btnPair.disabled = true;
        while (this.deviceListElement.firstChild) {
            this.deviceListElement.removeChild(this.deviceListElement.firstChild);
        }
        document.body.appendChild(this.container);
        this.chooserDialog.showModal();
        // TODO listen for escape key to close the dialog
    }

    hide() {
        document.body.removeChild(this.container);
    }

    cancel() {
        this.hide();
        this.onCancel();
    }

    pair() {
        this.hide();
        this.onPair(this.selectedDeviceId);
    }

    updateDevice(address, name) {
        let deviceElement = this.shadowRoot.querySelector(`.device-item[bluetoothId='${address}']`);
        if (!deviceElement) {
            deviceElement = document.createElement('div');
            deviceElement.tabIndex = 0;
            deviceElement.ariaRole = 'button';
            deviceElement.setAttribute('bluetoothId', address);
            deviceElement.classList.add('device-item');
            deviceElement.innerText = address.toUpperCase();
            deviceElement.addEventListener('click', () => this.selectDevice(address, deviceElement));
            deviceElement.addEventListener('keydown', e => {
                if (e.keyCode === 13 || e.keyCode === 32) {
                    this.selectDevice(address, deviceElement);
                }
            });
            this.deviceListElement.appendChild(deviceElement);
        }
        if (name) {
            deviceElement.innerText = name;
        }
        // TODO indicate RSSI
        // TODO handle duplicate device names?
    }

    selectDevice(address, deviceElement) {
        this.selectedDeviceId = address;
        this.btnPair.disabled = false;
        const previousSelected = this.deviceListElement.querySelector('.selected');
        if (previousSelected) {
            previousSelected.classList.remove('selected');
        }
        deviceElement.classList.add('selected');
    }
}

// Inject the Polyfill

var script = document.createElement('script');
script.src = chrome.extension.getURL('polyfill.js');
document.documentElement.appendChild(script);
