// Connect to background script
var port = null;
let chooserUI = null;

let recommendedUpdateShown = false;
let optionalUpdateShown = false;

function disconnectport() {
    if (port) {
        port.disconnect();
        port = null;
    }
}
// TODO this might not be correct. Only supposed to disconnect active scanning.
window.addEventListener('pagehide', disconnectport);

function getChooserUI() {
    if (!chooserUI) {
        chooserUI = new DeviceChooserUI();
        chooserUI.onPair = (deviceId, gattId) => port.postMessage({ cmd: 'chooserPair', deviceId, gattId });
        chooserUI.onCancel = () => port.postMessage({ cmd: 'chooserCancel' });
    }
    return chooserUI;
}

function portMsg(message) {
    if (message.error === 'Unsupported WebBT server version. Extension or server update required. https://github.com/stevennyman/webbt/releases/latest') {
        if (chooserUI) {
            chooserUI.hide();
        }
        // do not return here
    }

    if ('currentRecommendedUpdateContents' in message && message.currentRecommendedUpdateContents) {
        if (chooserUI) {
            chooserUI.showRecommendedUpdate(message.currentRecommendedUpdateContents.message);
        }
        if (!recommendedUpdateShown) {
            console.log(message.currentRecommendedUpdateContents.consoleMessage);
            recommendedUpdateShown = true;
        }
    } else if ('currentRecommendedUpdateContents' in message && message.currentRecommendedUpdateContents === null) {
        if (chooserUI) {
            chooserUI.hideRecommendedUpdate();
        }
        recommendedUpdateShown = false;
    }

    if ('currentOptionalUpdateContents' in message && message.currentOptionalUpdateContents) {
        if (chooserUI) {
            chooserUI.showOptionalUpdate(message.currentOptionalUpdateContents.message);
        }
        if (!optionalUpdateShown) {
            console.log(message.currentOptionalUpdateContents.consoleMessage);
            optionalUpdateShown = true;
        }
    } else if ('currentOptionalUpdateContents' in message && message.currentOptionalUpdateContents === null) {
        if (chooserUI) {
            chooserUI.hideOptionalUpdate();
        }
        optionalUpdateShown = false;
    }

    if (message._type === 'showDeviceChooser') {
        const ui = getChooserUI();
        if (message.currentRecommendedUpdateContents) {
            ui.showRecommendedUpdate(message.currentRecommendedUpdateContents.message);
        }
        if (message.currentOptionalUpdateContents) {
            ui.showOptionalUpdate(message.currentOptionalUpdateContents.message);
        }
        ui.show();
        return;
    }

    if (message._type === 'hideDeviceChooser') {
        if (chooserUI) {
            chooserUI.hide();
        }
        return;
    }

    if (message._type === 'deviceChooserBluetoothError') {
        if (chooserUI) {
            chooserUI.winError();
        }
        return;
    }

    if (message._type === 'scanResult') {
        if (chooserUI) {
            chooserUI.updateDevice(
                message.bluetoothAddress,
                message.localName,
                message.gattId,
                message.appearanceName,
                message.manufacturerNames,
                message.rssi,
            );
        }
        return;
    }

    // actually displaying this confirmation is optional
    // the application is allowed to accept on behalf of the user
    // https://learn.microsoft.com/en-us/uwp/api/windows.devices.enumeration.devicepairingkinds?view=winrt-22621
    if (message._type === 'pairing_confirmOnly') {
        getChooserUI().showPairingConfirmOnly(message.pairingId, accepted => {
            if (accepted) {
                port.postMessage({ command: 'accept', args: [message.pairingId] });
            } else {
                port.postMessage({ command: 'cancel', args: [message.pairingId] });
            }
        });
        return;
    }

    if (message._type === 'pairing_displayPin') {
        getChooserUI().showPairingDisplayPin(message.pairingId, message.pin, accepted => {
            if (accepted) {
                port.postMessage({ command: 'accept', args: [message.pairingId] });
            } else {
                port.postMessage({ command: 'cancel', args: [message.pairingId] });
            }
        });
        return;
    }

    if (message._type === 'pairing_confirmPinMatch') {
        getChooserUI().showPairingConfirmPinMatch(message.pairingId, message.pin, accepted => {
            if (accepted) {
                port.postMessage({ command: 'accept', args: [message.pairingId] });
            } else {
                port.postMessage({ command: 'cancel', args: [message.pairingId] });
            }
        });
        return;
    }

    if (message._type === 'pairing_providePin') {
        getChooserUI().showPairingProvidePin(message.pairingId, pin => {
            if (pin === null) {
                port.postMessage({ command: 'cancel', args: [message.pairingId] });
            } else {
                port.postMessage({ command: 'acceptPin', args: [message.pairingId, pin] });
            }
        });
        return;
    }

    // Sent when the same pairing request was already resolved in another tab
    // (the request can be delivered to multiple tabs at once). No response is
    // sent back here -- the resolution already happened wherever it was answered.
    if (message._type === 'pairing_hideDialog') {
        if (chooserUI) {
            chooserUI.hidePairingDialogForId(message.pairingId);
        }
        return;
    }

    window.postMessage(Object.assign({}, message, {
        type: 'WebBluetoothPolyCSToPage',
    }), message.origin || '*');
}

// Listen for Web Bluetooth Requests
window.addEventListener('message', event => {
    if (event.source === window && event.data && event.data.type === 'WebBluetoothPolyPageToCS') {
        if (!port) {
            port = chrome.runtime.connect();
            port.onMessage.addListener(portMsg);
        }
        port.postMessage(Object.assign({}, event.data, { origin: event.origin }));
    }
}, false);

// Device Chooser UI
class DeviceChooserUI {
    constructor() {
        this.createElements();
        this.onCancel = () => null;
        this.onPair = () => null;
        this.manufacturerNames = new Map();
        this.appearanceNames = new Map();
        // FIFO queue of pending pairing requests. Each entry: { id, kind, pin, callback }.
        // Only the head of the queue is ever rendered/shown; everything else waits.
        // `current` mirrors the entry currently on screen (or null if none is shown).
        this.pairingQueue = [];
        this.currentPairing = null;
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
                #chooser-dialog, #nobluetooth, #pairing-confirmOnly, #pairing-displayPin,
                #pairing-confirmPinMatch, #pairing-providePin {
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

                .device-name {
                    font-weight: bold;
                }

                .device-header {
                    align-items: center;
                    display: flex;
                    gap: 8px;
                    justify-content: space-between;
                }

                .signal-strength {
                    align-items: end;
                    display: flex;
                    gap: 2px;
                    height: 14px;
                    padding: 0 2px;
                }

                .signal-bar {
                    background: #8a8a8a;
                    border-radius: 1px;
                    display: block;
                    width: 3px;
                }

                .signal-bar:nth-child(1) {
                    height: 4px;
                }

                .signal-bar:nth-child(2) {
                    height: 7px;
                }

                .signal-bar:nth-child(3) {
                    height: 10px;
                }

                .signal-bar:nth-child(4) {
                    height: 14px;
                }

                .signal-bar.active {
                    background: #286c8f;
                }

                .device-metadata {
                    color: #555;
                    font-size: 0.9em;
                    line-height: 1.2em;
                    margin-top: 2px;
                    height: 1.2em;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .device-item:hover {
                    background: #ddddee;
                }

                .device-item.selected {
                    background: #aaaaff;
                    color: white;
                }

                .device-item.selected .device-metadata {
                    color: #eeeeff;
                }

                #buttons, #buttons_nobluetooth, .pairing-buttons {
                    display: flex;
                    justify-content: flex-end;
                }

                #buttons button, #buttons_nobluetooth button, .pairing-buttons button {
                    cursor: pointer;
                    border: solid #c0c0c0 1px;
                    border-radius: 3px;
                    margin-left: 8px;
                    background: #edebea;
                    padding: 4px 12px;
                }

                #recommendedUpdate {
                    background: #f0d759;
                    margin-bottom: 6px;
                }
                
                #linux-experimental {
                    background: #f0d759;
                    margin-bottom: 6px;
                }

                #optionalUpdate {
                    color: #23222b;
                    background-color: rgb(133, 250, 133);
                    margin-bottom: 6px;
                }

                .pairing-title {
                    font-weight: bold;
                    margin-bottom: 8px;
                }

                .pairing-pin {
                    font-size: 1.4em;
                    font-weight: bold;
                    letter-spacing: 0.1em;
                    text-align: center;
                    background: #f2f1f0;
                    border: solid #9e9e9e 1px;
                    padding: 8px;
                    margin: 8px 0;
                }

                .pairing-field-row {
                    margin: 8px 0;
                }

                .pairing-field-row label {
                    display: block;
                    margin-bottom: 4px;
                }

                .pairing-field-row input {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 4px 6px;
                    border: solid #9e9e9e 1px;
                    border-radius: 2px;
                }

            </style>

            <dialog id="chooser-dialog">
                <span id="hostname"> </span> wants to pair
                <div id="device-list">
                </div>
                <div id="recommendedUpdate" hidden>
                    <span id="recommendedUpdateText"></span><br /><a href="https://github.com/stevennyman/webbt/releases" target="_blank">Download Now</a>
                </div>
                <div id="optionalUpdate" hidden>
                    <span id="optionalUpdateText"></span><br /><a href="https://github.com/stevennyman/webbt/releases" target="_blank">Download Now</a>
                </div>
                <div id="linux-experimental" hidden>
                    <span id="linux-experimental-text">Linux support is experimental. Please see <a href="https://github.com/stevennyman/webbt#troubleshooting" target="_blank">troubleshooting</a> and report any issues as needed. PRs welcome!</span>
                </div>
                <div id="buttons">
                    <button id="btn-cancel">Cancel</button>
                    <button id="btn-pair">Pair</button>
                </div>
                <div id="footer">
                    This website will be able to retain access to this device for future visits. Access can be revoked in <a href="" target="_blank" id="openOptions">Web Bluetooth Options</a>.<br /> <br />
                    Powered by <a href="https://github.com/stevennyman/webbt" target="_blank">WebBT for Firefox</a>
                </div>
            </dialog>

            <dialog id="nobluetooth">
                <div><span><b>Unable to start scanning for Bluetooth devices.</b></span></div>
                <div><span>Ensure that your device is Bluetooth-capable and that Bluetooth is turned on.</span></div>
                <br>
                <div><span>
                    <a id="windows_bluetoothlink" href="ms-settings:bluetooth" target="_blank" hidden>Go to Windows Bluetooth Settings</a>
                    <a href="x-apple.systempreferences:com.apple.BluetoothSettings" id="macos_bluetoothlink" target="_blank" hidden>Go to macOS Bluetooth Settings</a>
                </span></div>
                <br>
                <div id="buttons_nobluetooth">
                    <button id="nobluetooth_ok">OK</button>
                </div>
            </dialog>

            <dialog id="pairing-confirmOnly">
                <div class="pairing-title">Bluetooth Pairing</div>
                <div>Press OK to confirm you would like to pair with your device.</div>
                <div class="pairing-buttons">
                    <button id="pairing-confirmOnly-cancel">Cancel</button>
                    <button id="pairing-confirmOnly-ok">OK</button>
                </div>
            </dialog>

            <dialog id="pairing-displayPin">
                <div class="pairing-title">Bluetooth Pairing</div>
                <div>Use the following PIN to pair your device:</div>
                <div class="pairing-pin" id="pairing-displayPin-pin"></div>
                <div class="pairing-buttons">
                    <button id="pairing-displayPin-cancel">Cancel</button>
                    <button id="pairing-displayPin-ok">OK</button>
                </div>
            </dialog>

            <dialog id="pairing-confirmPinMatch">
                <div class="pairing-title">Bluetooth Pairing</div>
                <div>Confirm the following PIN is displayed on your device:</div>
                <div class="pairing-pin" id="pairing-confirmPinMatch-pin"></div>
                <div class="pairing-buttons">
                    <button id="pairing-confirmPinMatch-cancel">Cancel</button>
                    <button id="pairing-confirmPinMatch-ok">OK</button>
                </div>
            </dialog>

            <dialog id="pairing-providePin">
                <div class="pairing-title">Bluetooth Pairing</div>
                <div>Enter the PIN required to connect to your device.</div>
                <div class="pairing-field-row">
                    <label for="pairing-providePin-pin">PIN</label>
                    <input type="text" id="pairing-providePin-pin" autocomplete="off">
                </div>
                <div class="pairing-buttons">
                    <button id="pairing-providePin-cancel">Cancel</button>
                    <button id="pairing-providePin-ok">OK</button>
                </div>
            </dialog>
        `;

        this.btnPair = shadowRoot.getElementById('btn-pair');
        this.deviceListElement = shadowRoot.getElementById('device-list');
        this.chooserDialog = shadowRoot.getElementById('chooser-dialog');
        this.chooserDialog?.addEventListener('close', () => {
            this.manufacturerNames.clear();
            this.appearanceNames.clear();
        });
        this.nobluetooth = shadowRoot.getElementById('nobluetooth');
        this.nobluetooth_ok = shadowRoot.getElementById('nobluetooth_ok');

        if (navigator.platform.includes("Win")) {
            shadowRoot.getElementById('windows_bluetoothlink')?.removeAttribute('hidden');
        }

        if (navigator.platform.includes("Mac")) {
            shadowRoot.getElementById('macos_bluetoothlink')?.removeAttribute('hidden');
        }

        if (navigator.platform.includes("Linux")) {
            shadowRoot.getElementById('linux-experimental')?.removeAttribute('hidden');
        }

        this.recommendedUpdate = shadowRoot.getElementById('recommendedUpdate');
        this.recommendedUpdateText = shadowRoot.getElementById('recommendedUpdateText');

        this.optionalUpdate = shadowRoot.getElementById('optionalUpdate');
        this.optionalUpdateText = shadowRoot.getElementById('optionalUpdateText');

        this.openOptions = shadowRoot.getElementById('openOptions');
        this.openOptions.href = chrome.runtime.getURL('options.html');
        this.openOptions.addEventListener('click', e => {
            port.postMessage({ command: 'openOptions', args: [] });
            e.preventDefault();
            return false;
        });

        this.chooserDialog.addEventListener('click', e => e.stopPropagation());
        shadowRoot.getElementById('hostname').innerText = document.location.hostname;
        shadowRoot.getElementById('btn-cancel').addEventListener('click', () => this.cancel());
        this.btnPair.addEventListener('click', () => this.pair());
        this.nobluetooth.addEventListener('click', e => e.stopPropagation());
        this.nobluetooth_ok.addEventListener('click', () => this.cancel());

        this.setupPairingConfirmOnly(shadowRoot);
        this.setupPairingDisplayPin(shadowRoot);
        this.setupPairingConfirmPinMatch(shadowRoot);
        this.setupPairingProvidePin(shadowRoot);
    }

    setupPairingConfirmOnly(shadowRoot) {
        this.pairingConfirmOnlyDialog = shadowRoot.getElementById('pairing-confirmOnly');
        this.pairingConfirmOnlyDialog.addEventListener('click', e => e.stopPropagation());
        shadowRoot.getElementById('pairing-confirmOnly-cancel').addEventListener('click', () => this.resolveCurrentPairing(false));
        shadowRoot.getElementById('pairing-confirmOnly-ok').addEventListener('click', () => this.resolveCurrentPairing(true));
    }

    setupPairingDisplayPin(shadowRoot) {
        this.pairingDisplayPinDialog = shadowRoot.getElementById('pairing-displayPin');
        this.pairingDisplayPinPin = shadowRoot.getElementById('pairing-displayPin-pin');
        this.pairingDisplayPinDialog.addEventListener('click', e => e.stopPropagation());
        shadowRoot.getElementById('pairing-displayPin-cancel').addEventListener('click', () => this.resolveCurrentPairing(false));
        shadowRoot.getElementById('pairing-displayPin-ok').addEventListener('click', () => this.resolveCurrentPairing(true));
    }

    setupPairingConfirmPinMatch(shadowRoot) {
        this.pairingConfirmPinMatchDialog = shadowRoot.getElementById('pairing-confirmPinMatch');
        this.pairingConfirmPinMatchPin = shadowRoot.getElementById('pairing-confirmPinMatch-pin');
        this.pairingConfirmPinMatchDialog.addEventListener('click', e => e.stopPropagation());
        shadowRoot.getElementById('pairing-confirmPinMatch-cancel').addEventListener('click', () => this.resolveCurrentPairing(false));
        shadowRoot.getElementById('pairing-confirmPinMatch-ok').addEventListener('click', () => this.resolveCurrentPairing(true));
    }

    setupPairingProvidePin(shadowRoot) {
        this.pairingProvidePinDialog = shadowRoot.getElementById('pairing-providePin');
        this.pairingProvidePinInput = shadowRoot.getElementById('pairing-providePin-pin');
        this.pairingProvidePinDialog.addEventListener('click', e => e.stopPropagation());
        shadowRoot.getElementById('pairing-providePin-cancel').addEventListener('click', () => this.resolveCurrentPairing(null));
        shadowRoot.getElementById('pairing-providePin-ok').addEventListener('click', () => {
            this.resolveCurrentPairing(this.pairingProvidePinInput.value);
        });
        this.pairingProvidePinInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.resolveCurrentPairing(this.pairingProvidePinInput.value);
            }
        });
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
        if (this.chooserDialog.open) {
            this.chooserDialog.close();
        }
        if (this.nobluetooth.open) {
            this.nobluetooth.close();
        }
        this.maybeRemoveContainer();
    }

    showRecommendedUpdate(updateText) {
        this.recommendedUpdateText.innerText = updateText;
        this.recommendedUpdate.removeAttribute('hidden');
    }

    showOptionalUpdate(updateText) {
        this.optionalUpdateText.innerText = updateText;
        this.optionalUpdate.removeAttribute('hidden');
    }

    hideRecommendedUpdate() {
        this.recommendedUpdate.hidden = true;
    }

    hideOptionalUpdate() {
        this.optionalUpdate.hidden = true;
    }

    winError() {
        this.chooserDialog.close();
        this.onCancel();
        this.nobluetooth.showModal();
    }

    cancel() {
        this.hide();
        this.onCancel();
    }

    pair() {
        if (this.btnPair.disabled) {
            return;
        }
        this.hide();
        this.onPair(this.selectedDeviceId, this.selectedGattId);
    }

    updateDevice(address, name, gattId, appearanceName, manufacturerNames, rssi) {
        let deviceElement = this.shadowRoot.querySelector(`.device-item[bluetoothId='${address}']`);
        if (!deviceElement) {
            deviceElement = document.createElement('div');
            deviceElement.tabIndex = 0;
            deviceElement.ariaRole = 'button';
            deviceElement.setAttribute('bluetoothId', address);
            deviceElement.setAttribute('gattId', gattId);
            deviceElement.classList.add('device-item');
            const deviceHeader = document.createElement('div');
            deviceHeader.classList.add('device-header');
            const deviceName = document.createElement('div');
            deviceName.classList.add('device-name');
            deviceHeader.appendChild(deviceName);
            const signalStrength = document.createElement('span');
            signalStrength.classList.add('signal-strength');
            signalStrength.setAttribute('role', 'img');
            for (let i = 0; i < 4; i++) {
                const signalBar = document.createElement('span');
                signalBar.classList.add('signal-bar');
                signalStrength.appendChild(signalBar);
            }
            deviceHeader.appendChild(signalStrength);
            deviceElement.appendChild(deviceHeader);
            const deviceMetadata = document.createElement('div');
            deviceMetadata.classList.add('device-metadata');
            deviceElement.appendChild(deviceMetadata);
            deviceElement.addEventListener('click', () => this.selectDevice(address, deviceElement, gattId));
            deviceElement.addEventListener('dblclick', () => {
                this.selectDevice(address, deviceElement, gattId);
                this.pair();
            });
            deviceElement.addEventListener('keydown', e => {
                if (e.keyCode === 13 || e.keyCode === 32) {
                    this.selectDevice(address, deviceElement, gattId);
                }
            });
            this.deviceListElement.appendChild(deviceElement);
        }
        const manufacturerNamesForDevice = this.manufacturerNames.get(address) ?? new Set();
        manufacturerNames?.forEach(name => manufacturerNamesForDevice.add(name));
        this.manufacturerNames.set(address, manufacturerNamesForDevice);
        if (appearanceName && !this.appearanceNames.has(address)) {
            this.appearanceNames.set(address, appearanceName);
        }
        deviceElement.querySelector('.device-name').textContent = name || address.toUpperCase();
        const signalStrength = deviceElement.querySelector('.signal-strength');
        const signalLevel = Number.isFinite(rssi)
            ? rssi >= -60 ? 4 : rssi >= -75 ? 3 : rssi >= -90 ? 2 : 1
            : 0;
        signalStrength.querySelectorAll('.signal-bar').forEach((bar, index) => {
            bar.classList.toggle('active', index < signalLevel);
        });
        signalStrength.setAttribute(
            'aria-label',
            signalLevel ? `Signal strength: ${['', 'Very weak', 'Weak', 'Good', 'Excellent'][signalLevel]}`
                : 'Signal strength unavailable',
        );
        signalStrength.title = signalStrength.getAttribute('aria-label');
        const metadata = [this.appearanceNames.get(address), manufacturerNamesForDevice.size
            ? [...manufacturerNamesForDevice].join(', ')
            : null]
            .filter(Boolean)
            .join(' | ');
        const metadataElement = deviceElement.querySelector('.device-metadata');
        metadataElement.textContent = metadata;
        metadataElement.hidden = false;
        metadataElement.style.visibility = metadata ? 'visible' : 'hidden';
        // TODO handle duplicate device names?
    }

    selectDevice(address, deviceElement, gattId) {
        this.selectedDeviceId = address;
        this.selectedGattId = gattId;
        this.btnPair.disabled = false;
        const previousSelected = this.deviceListElement.querySelector('.selected');
        if (previousSelected) {
            previousSelected.classList.remove('selected');
        }
        deviceElement.classList.add('selected');
    }

    // --- Pairing ceremony dialogs ---
    //
    // Pairing requests are queued globally (regardless of kind) since only one
    // pairing dialog is ever shown at a time. Each show* call enqueues a
    // { id, kind, pin, callback } entry and tries to advance the queue; if
    // something is already showing, the new entry just waits its turn.
    // resolveCurrentPairing closes whatever's on screen, fires its callback,
    // and advances to the next queued entry (if any).

    enqueuePairing(entry) {
        this.pairingQueue.push(entry);
        this.advancePairingQueue();
    }

    advancePairingQueue() {
        if (this.currentPairing || this.pairingQueue.length === 0) {
            return;
        }
        const entry = this.pairingQueue.shift();
        this.currentPairing = entry;
        document.body.appendChild(this.container);

        switch (entry.kind) {
            case 'confirmOnly':
                this.pairingConfirmOnlyDialog.showModal();
                break;
            case 'displayPin':
                this.pairingDisplayPinPin.innerText = entry.pin;
                this.pairingDisplayPinDialog.showModal();
                break;
            case 'confirmPinMatch':
                this.pairingConfirmPinMatchPin.innerText = entry.pin;
                this.pairingConfirmPinMatchDialog.showModal();
                break;
            case 'providePin':
                this.pairingProvidePinInput.value = '';
                this.pairingProvidePinDialog.showModal();
                this.pairingProvidePinInput.focus();
                break;
        }
    }

    // Maps a pairing kind to its <dialog> element and closes it. Used by both
    // resolveCurrentPairing (user answered) and hidePairingDialogForId
    // (another tab answered first).
    closeCurrentPairingDialog(kind) {
        switch (kind) {
            case 'confirmOnly':
                this.pairingConfirmOnlyDialog.close();
                break;
            case 'displayPin':
                this.pairingDisplayPinDialog.close();
                break;
            case 'confirmPinMatch':
                this.pairingConfirmPinMatchDialog.close();
                break;
            case 'providePin':
                this.pairingProvidePinDialog.close();
                break;
        }
    }

    // value is the dialog's answer: boolean for confirm-style dialogs, string
    // (or null for cancel) for providePin.
    resolveCurrentPairing(value) {
        if (!this.currentPairing) {
            return;
        }
        const { kind, callback } = this.currentPairing;
        this.closeCurrentPairingDialog(kind);
        this.currentPairing = null;
        this.maybeRemoveContainer();
        if (callback) callback(value);
        this.advancePairingQueue();
    }

    // Handles pairing_hideDialog: the same pairing request was already
    // resolved in another tab, so this tab should stop asking without sending
    // any response of its own (the response already went out from wherever
    // it was answered).
    hidePairingDialogForId(id) {
        if (this.currentPairing && this.currentPairing.id === id) {
            this.closeCurrentPairingDialog(this.currentPairing.kind);
            this.currentPairing = null;
            this.maybeRemoveContainer();
            this.advancePairingQueue();
            return;
        }
        // Not currently shown -- if it's still waiting in the queue, drop it
        // silently so it never gets shown.
        this.pairingQueue = this.pairingQueue.filter(entry => entry.id !== id);
    }

    showPairingConfirmOnly(id, callback) {
        this.enqueuePairing({ id, kind: 'confirmOnly', callback });
    }

    showPairingDisplayPin(id, pin, callback) {
        this.enqueuePairing({ id, kind: 'displayPin', pin, callback });
    }

    showPairingConfirmPinMatch(id, pin, callback) {
        this.enqueuePairing({ id, kind: 'confirmPinMatch', pin, callback });
    }

    showPairingProvidePin(id, callback) {
        this.enqueuePairing({ id, kind: 'providePin', callback });
    }

    // The shared container is appended to document.body by show()/advancePairingQueue;
    // only remove it once nothing is left open, since the chooser dialog and
    // pairing dialogs can in principle overlap during a session.
    maybeRemoveContainer() {
        const anyOpen = this.shadowRoot.querySelector('dialog[open]');
        if (!anyOpen && this.container.parentNode) {
            document.body.removeChild(this.container);
        }
    }
}
