const SUPPORTED_HOST_API_VERSIONS = [1, 2];

let debugPrints = false;

let requestId = 0;
let requests = {};

let commandPorts = {};
let activePorts = 0;
let nativePort = null;

let listeners = {};
let listenercnts = {};

const COOLDOWN_MS = 30* 1000;
let lastInfoTab = 0;
let infoTabId = null;

let nativeResolve = null;
let nativeReady = null;

let pairingPorts = {};

let currentRecommendedUpdateContents = null;
let currentOptionalUpdateContents = null;

// upgrades will only be offered against these servers
// a community server should provide a different serverName in its Start message)
const WEBBT_FIRSTPARTY_SERVERS = ['bleserver-win-cppcx', 'rust-server'];

const WEBBT_SERVER_UPDATES = {
    // we're not requiring 0.5.2 server users to update to 0.5.3 but we are recommending it
    // server API remains compatible, some users may have restrictions preventing them from installing software
    'recommended': {
        'version': '0.5.3',
        'upgrade_versions': ['0.5.2'],
        'upgrade_message': 'A recommended update for WebBT Server, version 0.5.3, is now available ' +
            'for your system. This update improves performance and pairing reliability.',
    },
    // we're not requiring 0.5.2 or 0.5.3 server users to update to the rewrite but we are offering it
    'optional': {
        'version': '0.6.0',
        'upgrade_versions': ['0.5.2', '0.5.3'],
        'upgrade_message': 'An optional update for WebBT Server, version 0.6.0, is now available ' +
            'for your system. This update is a cross-platform rewrite of WebBT Server that is compatible ' +
            'with Windows, macOS, and Linux.',
    },
};

// this is a flag that can be set by the server at startup as this differs by implementation
// C++/CX uses one global scanning instance where the extension keeps count of how many instances are required
// Note: to prevent race conditions, any logic that evaluates this variable should await nativeReady
let serverApiVersion = 1;

function removeFirst(arr, value) {
    const i = arr.indexOf(value);
    if (i !== -1) arr.splice(i, 1);
}

async function openOrFocusInfoTab(alwaysShow) {
    if (Date.now() - lastInfoTab < COOLDOWN_MS) return;
    if (!alwaysShow && (await browser.storage.local.get('hideInstallation')).hideInstallation) return;
    lastInfoTab = Date.now();
    if (infoTabId != null) {
        try {
            await browser.tabs.update(infoTabId, { active: true });
        } catch {
            infoTabId = (await browser.tabs.create({ url: '/installation.html' })).id;
        }
    } else {
        infoTabId = (await browser.tabs.create({ url: '/installation.html' })).id;
    }
}

browser.runtime.onInstalled.addListener((details) => {
    if (details.reason == 'update' && (details.previousVersion == '0.5.2' || details.previousVersion == '0.5.3')) {
        openOrFocusInfoTab(true);
    }
});


async function nativeRequest(cmd, params, port) {
    return new Promise(async (resolve, reject) => {
        const currentRequestId = requestId++;
        requests[currentRequestId] = { resolve, reject };
        commandPorts[currentRequestId] = port;
        const msg = Object.assign(params || {}, {
            cmd,
            _id: currentRequestId,
        });
        if (cmd != 'ping') {
            await nativeReady;
        }
        if (debugPrints) {
            console.log('Sent native message:', msg);
        }
        const hostPort = nativePort;
        if (!hostPort) {
            delete requests[currentRequestId];
            delete commandPorts[currentRequestId];
            reject('WebBT native host is not connected');
            return;
        }
        try {
            hostPort.postMessage(msg);
        } catch (e) {
            if (debugPrints) {
                console.log(e);
            }
            nativeResolve();
            delete requests[currentRequestId];
            delete commandPorts[currentRequestId];
            if (hostPort.error && hostPort.error.message.startsWith('No such native application ')) {
                await openOrFocusInfoTab();
                port.postMessage({ _type: 'hideDeviceChooser' });
                reject('WebBT server not installed. https://github.com/stevennyman/webbt/releases/latest');
            } else {
                reject(e);
            }
        }
    });
}

const subscriptions = {};
const devices = {};

function nativePortOnMessage(msg) {
    if (msg._type === 'Start' && 'apiVersion' in msg) {
        serverApiVersion = msg.apiVersion;
    }
    nativeResolve();
    if (debugPrints && msg._type != 'scanResult') {
        console.log('Received native message:', msg);
    }
    if (msg._type === 'Start') {
        if (!SUPPORTED_HOST_API_VERSIONS.includes(msg.apiVersion)) {
            nativePort.disconnect();
            for (const reqId in requests) {
                delete commandPorts[reqId];
                const { reject, resolve } = requests[reqId];
                reject('Unsupported WebBT server version. Extension or server update required. https://github.com/stevennyman/webbt/releases/latest');
                delete requests[reqId];
            }
            requests = {};
            commandPorts = {};
            console.log('Unsupported WebBT server version. Extension or server update required. https://github.com/stevennyman/webbt/releases/latest');
            openOrFocusInfoTab();
        } else {
            if (WEBBT_FIRSTPARTY_SERVERS.includes(msg.serverName) &&
            WEBBT_SERVER_UPDATES.recommended.upgrade_versions.includes(msg.serverVersion)) {
                currentRecommendedUpdateContents = { _type: 'recommendedUpdate', message: WEBBT_SERVER_UPDATES.recommended.upgrade_message, consoleMessage: WEBBT_SERVER_UPDATES.recommended.upgrade_message + ' https://github.com/stevennyman/webbt/releases/latest' };
                for (const reqId in requests) {
                    commandPorts[reqId].postMessage({
                        currentRecommendedUpdateContents: currentRecommendedUpdateContents,
                    });
                }
            } else {
                currentRecommendedUpdateContents = null;
                for (const reqId in requests) {
                    commandPorts[reqId].postMessage({ currentRecommendedUpdateContents: null });
                }
            }

            if (WEBBT_FIRSTPARTY_SERVERS.includes(msg.serverName) &&
            WEBBT_SERVER_UPDATES.optional.upgrade_versions.includes(msg.serverVersion)) {
                currentOptionalUpdateContents = { _type: 'optionalUpdate', message: WEBBT_SERVER_UPDATES.optional.upgrade_message, consoleMessage: WEBBT_SERVER_UPDATES.optional.upgrade_message + ' https://github.com/stevennyman/webbt/releases/latest' };
                for (const reqId in requests) {
                    commandPorts[reqId].postMessage({
                        currentOptionalUpdateContents: currentOptionalUpdateContents,
                    });
                }
            } else {
                currentOptionalUpdateContents = null;
                for (const reqId in requests) {
                    commandPorts[reqId].postMessage({ currentOptionalUpdateContents: null });
                }
            }
        }
    }
    // should be compatible with API v1 and v2 though less customized to API v1 than before
    if (msg.pairingType) {
        if (serverApiVersion == 1) {
            commandPorts[msg._id].postMessage({ ...msg, pairingId: msg._id });
        } else {
            // Server API v2+
            for (const portIt of Object.values(commandPorts)) {
                try {
                    portIt.postMessage(msg);
                    (pairingPorts[msg.pairingId] ??= new Set()).add(portIt);
                } catch (error) {}
            }
        }
    }

    // not emitted on Server API v1
    if (msg._type === 'pairing_hideDialog') {
        const pairingPortList = pairingPorts[msg.pairingId] ?? new Set();
        for (const portIt of pairingPortList) {
            try {
                portIt.postMessage(msg);
            } catch (error) {}
        }
        delete pairingPorts[msg.pairingId];
    }
    if (msg._type === 'response' && requests[msg._id]) {
        delete commandPorts[msg._id];
        const { reject, resolve } = requests[msg._id];
        if (msg.error) {
            reject(msg.error);
        } else {
            resolve(msg.result);
        }
        delete requests[msg._id];
    }
    if (msg._type === 'valueChangedNotification') {
        const portList = subscriptions[msg.subscriptionId];
        if (portList) {
            for (const port of portList) {
                port.postMessage(msg);
            }
        }
    }
    if (msg._type === 'disconnectEvent') {
        const gattId = msg.device;
        const device = devices[gattId];
        const devicePorts = device ? [...device] : [];

        // The page may reconnect synchronously from gattserverdisconnected.
        // Clean up the old connection first so that a reconnect reusing the
        // same legacy C++ server GATT ID is not removed by this cleanup.
        delete characteristicCache[gattId];
        delete devices[gattId];
        // Purge stale subscriptions so re-subscribe sends fresh CCCD writes
        for (const key of Object.keys(subscriptions)) {
            if (key.startsWith('subscription_' + gattId + '_')) {
                delete subscriptions[key];
            }
        }
        for (const origin of Object.keys(subscriptionOrigins)) {
            subscriptionOrigins[origin] = subscriptionOrigins[origin].filter(
                ([subscriptionGattId]) => subscriptionGattId !== gattId,
            );
            if (!subscriptionOrigins[origin].length) {
                delete subscriptionOrigins[origin];
            }
        }
        if (device) {
            devicePorts.forEach(async port => {
                try {
                    const webId = await gattIdToWebId(gattId, port);
                    if (webId !== null) {
                        port.postMessage({ event: 'disconnectEvent', device: webId });
                    }
                    portsObjects.get(port)?.devices.delete(gattId);
                } catch (error) {
                    console.error('Unable to forward disconnect event:', error);
                }
            });
        }
    }
}

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

const portsObjects = new Map();
const subscriptionOrigins = {};
const characteristicCache = {};

function trackOriginSubscription(origin, gattId, service, characteristic, port) {
    const list = (subscriptionOrigins[origin] ??= []);
    const exists = list.some(
        ([id, svc, char, prt]) => id === gattId && svc === service && char === characteristic && prt === port,
    );
    if (!exists) {
        list.push([gattId, service, characteristic, port]);
    }
}

function untrackOriginSubscription(origin, gattId, service, characteristic, port) {
    const list = subscriptionOrigins[origin];
    if (!list) {
        return;
    }
    const index = list.findIndex(
        ([id, svc, char, prt]) => id === gattId && svc === service && char === characteristic && prt === port,
    );
    if (index > -1) {
        list.splice(index, 1);
    }
    if (!list.length) {
        delete subscriptionOrigins[origin];
    }
}

function removePortFromSubscriptionOrigins(port) {
    const origin = port.sender.origin;
    const list = subscriptionOrigins[origin];
    if (!list) {
        return;
    }
    subscriptionOrigins[origin] = list.filter(([, , , prt]) => prt !== port);
    if (!subscriptionOrigins[origin].length) {
        delete subscriptionOrigins[origin];
    }
}

function nativePortOnDisconnect(port) {
    nativeResolve();
    if (nativePort !== port) {
        return;
    }

    for (const reqId in requests) {
        requests[reqId].reject(port.error?.message || 'WebBT native host disconnected');
        delete commandPorts[reqId];
    }
    requests = {};
    commandPorts = {};
    nativePort = null;
    console.log('Disconnected!', port.error);
}

function leftPad(s, count, pad) {
    while (s.length < count) {
        s = pad + s;
    }
    return s;
}

function normalizeUuid(uuid, standardUuids = {}) {
    const origUuid = uuid;
    if (standardUuids[uuid]) {
        uuid = standardUuids[uuid];
    }
    if (typeof uuid === 'string' && /^(0x)?[0-9a-f]{1,8}$/.test(uuid)) {
        uuid = parseInt(uuid, 16);
    }
    // 16 or 32 bit GUID
    if (typeof uuid === 'number' && uuid > 0) {
        return `${leftPad(uuid.toString(16), 8, '0')}-0000-1000-8000-00805f9b34fb`;
    }
    if (/^{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}?$/.test(uuid)) {
        return uuid.replace('{', '').replace('}', '').toLowerCase();
    }
    throw new Error(`Invalid UUID format: ${origUuid}`);
}

function normalizeServiceUuid(uuid) {
    return normalizeUuid(uuid, STANDARD_GATT_SERVICES);
}

function addResolvedAdvertisementMetadata(msg) {
    if (msg.appearance !== null && msg.appearance !== undefined) {
        const appearanceName = STANDARD_GATT_APPEARANCES[msg.appearance];
        if (appearanceName && msg.appearance !== 0) {
            msg.appearanceName = appearanceName;
        }
    }
    const manufacturerNames = (msg.manufacturerData ?? [])
        .map(entry => BLUETOOTH_COMPANY_IDENTIFIERS[entry.companyIdentifier])
        .filter(Boolean);
    if (manufacturerNames.length) {
        msg.manufacturerNames = [...new Set(manufacturerNames)];
    }
}

function normalizeCharacteristicUuid(uuid) {
    return normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS);
}

function windowsServiceUuid(uuid) {
    if (serverApiVersion === 2) {
        return normalizeUuid(uuid, STANDARD_GATT_SERVICES);
    }
    return '{' + normalizeUuid(uuid, STANDARD_GATT_SERVICES) + '}';
}

function windowsCharacteristicUuid(uuid) {
    if (serverApiVersion === 2) {
        return normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS);
    }
    return '{' + normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS) + '}';
}

function windowsDescriptorUuid(uuid) {
    if (uuid) {
        if (serverApiVersion === 2) {
            return normalizeUuid(uuid, STANDARD_GATT_DESCRIPTORS);
        }
        return '{' + normalizeUuid(uuid, STANDARD_GATT_DESCRIPTORS) + '}';
    } else {
        return uuid;
    }
}

let scanningCounter = 0;
async function startScanning(port, name) {
    await nativeReady;
    if (!scanningCounter) {
        await nativeRequest('scan', { name: name }, port);
    }
    portsObjects.get(port).scanCount++;
    portsObjects.get(port).scanNames.push(name);
    scanningCounter++;
}

async function stopScanning(port, name) {
    await nativeReady;
    scanningCounter--;
    portsObjects.get(port).scanCount--;
    removeFirst(portsObjects.get(port).scanNames, name);
    if (!scanningCounter && nativePort && !(nativePort.error)) {
        await nativeRequest('stopScan', {}, port);
    }
}

// intended for use with manufacturerData or serviceData
function processPrefixMask(elem, elemInner) {
    if (elemInner.dataPrefix) {
        let desprefix = new Uint8Array(elemInner.dataPrefix);
        let data = new Uint8Array(elem.data);
        if (elemInner.mask) {
            const reqlength = desprefix.length;
            if (elemInner.mask.length != reqlength) {
                throw new Error('Mask length must equal prefix length');
            }
            for (let i = 0; i < reqlength; i++) {
                desprefix[i] = desprefix[i] & elemInner.mask[i];
                data[i] = data[i] & elemInner.mask[i];
            }
        }
        for (let i = 0; i < desprefix.length; i++) {
            if (i >= data.length) {
                return false;
            }
            if (desprefix[i] != data[i]) {
                return false;
            }
        }
    }
    return true;
}

function canonicalizeFilterBytes(value, name) {
    let bytes;
    if (Array.isArray(value)) {
        bytes = new Uint8Array(value);
    } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
        throw new TypeError(`${name} must be a BufferSource`);
    }
    return bytes;
}

function matchDeviceFilter(filter, device) {
    if (filter.services) {
        const deviceServices = device.serviceUuids.map(normalizeServiceUuid);
        if (!filter.services.map(normalizeServiceUuid).every(uuid => deviceServices.includes(uuid))) {
            return false;
        }
    }
    if (filter.name && filter.name !== device.localName) {
        return false;
    }
    if (filter.namePrefix && (!device.localName || device.localName.indexOf(filter.namePrefix) !== 0)) {
        return false;
    }

    if (filter.manufacturerData) {
        const companyIdentifierMatch = filter.manufacturerData.every(elemInner =>
            device.manufacturerData.some(elem =>
                elem.companyIdentifier == elemInner.companyIdentifier && processPrefixMask(elem, elemInner)));
        if (!companyIdentifierMatch) {
            return false;
        }
    }

    if (filter.serviceData) {
        const serviceDataMatch = filter.serviceData.every(elemInner =>
            device.serviceData.some(elem =>
                normalizeServiceUuid(elem.service) === normalizeServiceUuid(elemInner.service) &&
                processPrefixMask(elem, elemInner)));
        if (!serviceDataMatch) {
            return false;
        }
    }
    return true;
}

const webIdToGattIdMap = {};
const webIdToAddressMap = {};
const gattIdToWebIdMap = {};

// caching function for webId to gattId conversions since browser storage access can be a bit slow
async function webIdToGattId(webId, port = null, origin = null) {
    if (origin === null) {
        origin = port.sender.origin;
    }
    const storageKey = 'originDevices_'+origin;
    if (!(origin in webIdToGattIdMap)) {
        webIdToGattIdMap[origin] = {};
    }
    if (webId in webIdToGattIdMap[origin]) { // && webIdToGattIdMap[origin][webId] != null) {
        return webIdToGattIdMap[origin][webId];
    } else {
        const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
        let compl = false;
        for (const dev of currentOriginDevices) {
            if (dev.webId === webId) {
                compl = true;
                webIdToGattIdMap[origin][webId] = dev.gattId;
                return dev.gattId;
            }
        }
        if (!compl) {
            return null;
        }
    }
}

// caching function for webId to address conversions since browser storage access can be a bit slow
async function webIdToAddress(webId, port = null, origin = null) {
    if (origin === null) {
        origin = port.sender.origin;
    }
    const storageKey = 'originDevices_'+origin;
    if (!(origin in webIdToAddressMap)) {
        webIdToAddressMap[origin] = {};
    }
    if (webId in webIdToAddressMap[origin]) { // && webIdToAddressMap[origin][webId] != null) {
        return webIdToAddressMap[origin][webId];
    } else {
        const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
        let compl = false;
        for (const dev of currentOriginDevices) {
            if (dev.webId === webId) {
                compl = true;
                webIdToAddressMap[origin][webId] = dev.address;
                return dev.address;
            }
        }
        if (!compl) {
            return null;
        }
    }
}

async function gattIdToWebId(gattId, port = null, origin = null) {
    if (origin === null) {
        origin = port.sender.origin;
    }
    if (!(origin in gattIdToWebIdMap)) {
        gattIdToWebIdMap[origin] = {};
    }
    if (gattId in gattIdToWebIdMap[origin]) {
        return gattIdToWebIdMap[origin][gattId];
    }
    const storageKey = 'originDevices_'+origin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    for (const dev of currentOriginDevices) {
        if (dev.gattId === gattId) {
            gattIdToWebIdMap[origin][gattId] = dev.webId;
            return dev.webId;
        }
    }
    return null;
}

async function requestDevice(port, options) {
    if ((!options.filters && !options.acceptAllDevices) || (options.filters && options.acceptAllDevices)) {
        throw new Error('One of filters or acceptAllDevices must be provided');
    }
    if (options.filters && (!Array.isArray(options.filters) || !options.filters.length)) {
        throw new Error('filters must be a non-empty array');
    }
    if (options.exclusionFilters && ! options.filters) {
        throw new Error('exclusionFilters requires filters');
    }

    for (const filter of [...(options.filters ?? []), ...(options.exclusionFilters ?? [])]) {
        if (!filter || typeof filter !== 'object') {
            throw new Error('Device filters must be objects');
        }
        if (filter.services && (!Array.isArray(filter.services) || !filter.services.length)) {
            throw new Error('services must be a non-empty array');
        }
        if (filter.manufacturerData &&
            (!Array.isArray(filter.manufacturerData) || !filter.manufacturerData.length)) {
            throw new Error('manufacturerData must be a non-empty array');
        }
        if (filter.serviceData &&
            (!Array.isArray(filter.serviceData) || !filter.serviceData.length)) {
            throw new Error('serviceData must be a non-empty array');
        }
        if (!filter.services && !filter.name && !filter.namePrefix &&
            !filter.manufacturerData && !filter.serviceData) {
            throw new Error('Each filter must specify a service, name, namePrefix, manufacturerData, or serviceData');
        }
        if (filter.manufacturerData) {
            const companyIdentifiers = new Set();
            for (const elem of filter.manufacturerData) {
                if (!elem || typeof elem !== 'object') {
                    throw new TypeError('manufacturerData entries must be objects');
                }
                if (elem.companyIdentifier === undefined || elem.companyIdentifier === null) {
                    throw new TypeError('manufacturerData is missing required companyIdentifier');
                }
                const companyIdentifier = Number(elem.companyIdentifier);
                if (!Number.isInteger(companyIdentifier) || companyIdentifier < 0 || companyIdentifier > 0xffff) {
                    throw new TypeError('companyIdentifier must be an unsigned short');
                }
                if (companyIdentifiers.has(companyIdentifier)) {
                    throw new TypeError('manufacturerData must not contain duplicate companyIdentifier values');
                }
                companyIdentifiers.add(companyIdentifier);
                elem.companyIdentifier = companyIdentifier;
                if (elem.dataPrefix !== undefined) {
                    const dataPrefix = canonicalizeFilterBytes(elem.dataPrefix, 'dataPrefix');
                    if (!dataPrefix.length) {
                        throw new TypeError('dataPrefix must not be empty');
                    }
                    elem.dataPrefix = dataPrefix;
                    if (elem.mask !== undefined) {
                        const mask = canonicalizeFilterBytes(elem.mask, 'mask');
                        if (mask.length !== dataPrefix.length) {
                            throw new TypeError('mask length must equal dataPrefix length');
                        }
                        elem.mask = mask;
                    }
                } else if (elem.mask !== undefined) {
                    const mask = canonicalizeFilterBytes(elem.mask, 'mask');
                    if (mask.length !== 0) {
                        throw new TypeError('mask length must equal dataPrefix length');
                    }
                    elem.mask = mask;
                }
            }
        }
        if (filter.serviceData) {
            for (const elem of filter.serviceData) {
                if (!elem.service) {
                    throw new Error('serviceData is missing required service');
                }
            }
        }
    }

    let deviceNames = {};
    let deviceRssi = {};
    const SCAN_NAME = 'requestDevice_'+port.sender.contextId;
    function scanResultListener(msg) {
        if (msg._type === 'scanResult' && (!msg.scanName || msg.scanName == SCAN_NAME)) {
            if (msg.localName) {
                deviceNames[msg.bluetoothAddress] = msg.localName;
            } else {
                msg.localName = deviceNames[msg.bluetoothAddress];
            }
            for (let i = 0; i < msg.serviceData.length; i++) {
                msg.serviceData[i].service = normalizeServiceUuid(msg.serviceData[i].service);
            }
            addResolvedAdvertisementMetadata(msg);
            deviceRssi[msg.bluetoothAddress] = msg.rssi;
            if (options.acceptAllDevices ||
                options.filters.some(filter => matchDeviceFilter(filter, msg))) {
                if ((options.exclusionFilters &&
                    !options.exclusionFilters.some(filter => matchDeviceFilter(filter, msg)))
                    || !options.exclusionFilters) {
                    port.postMessage(msg);
                }
            }
        }
    }

    nativePort.onMessage.addListener(scanResultListener);
    port.postMessage({
        _type: 'showDeviceChooser', currentRecommendedUpdateContents: currentRecommendedUpdateContents,
        currentOptionalUpdateContents: currentOptionalUpdateContents,
    });
    try {
        await startScanning(port, SCAN_NAME);
    } catch (error) {
        if (error == 'The device is not ready for use.\r\n\r\nThe device is not ready for use.\r\n'
            || error == 'No Bluetooth adapter available or Bluetooth is turned off in your system settings.') {
            port.postMessage({ _type: 'deviceChooserBluetoothError' });
        }
        throw error;
    }
    try {
        const deviceInfo = await new Promise((resolve, reject) => {
            port.onMessage.addListener(msg => {
                if (msg.type === 'WebBluetoothPolyPageToCS') {
                    // This is a message from the page itself, not from the content script.
                    // Therefore, we don't trust it.
                    return;
                }
                if (msg.cmd === 'chooserPair') {
                    resolve({ deviceAddress: msg.deviceId, gattId: msg.gattId });
                }
                if (msg.cmd === 'chooserCancel') {
                    reject(new Error('User canceled device chooser'));
                }
            });
        });

        const deviceAddress = deviceInfo.deviceAddress;
        const gattId = deviceInfo.gattId;

        portsObjects.get(port).knownDeviceIds.add(deviceAddress);
        if (gattId) {
            portsObjects.get(port).knownGattIds.add(gattId);
        }
        portsObjects.get(port).deviceIdNames[deviceAddress] = deviceNames[deviceAddress];

        const storageKey = 'originDevices_'+port.sender.origin;
        const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
        let alreadyInStorage = false;
        const deviceUuids = new Set();
        let currentWebId;
        for (let i = 0; i < currentOriginDevices.length; i++) {
            deviceUuids.add(currentOriginDevices[i].webId);
            if (currentOriginDevices[i].address === deviceAddress) {
                currentWebId = currentOriginDevices[i].webId;
                alreadyInStorage = true;
                currentOriginDevices[i].gattId = gattId;
                if (!(currentOriginDevices[i].name === deviceNames[deviceAddress])) {
                    // hopefully this doesn't cause valuable names to be lost
                    currentOriginDevices[i].name = deviceNames[deviceAddress];
                }
            }
        }
        if (!alreadyInStorage) {
            let desWebId;
            while (true) {
                // requires Firefox 95 and secure origin
                desWebId = crypto.randomUUID();
                if (!(deviceUuids.has(desWebId))) {
                    currentWebId = desWebId;
                    break;
                }
            }
            currentOriginDevices.push({
                address: deviceAddress, name: deviceNames[deviceAddress], gattId: gattId, webId: currentWebId,
            });
        }
        if (gattId) {
            (gattIdToWebIdMap[port.sender.origin] ??= {})[gattId] = currentWebId;
        }
        await browser.storage.local.set({ [storageKey]: currentOriginDevices });

        return {
            address: currentWebId,
            __rssi: deviceRssi[deviceAddress],
            name: deviceNames[deviceAddress],
        };
    } finally {
        await stopScanning(port, SCAN_NAME);
        nativePort.onMessage.removeListener(scanResultListener);
    }
}

async function watchAdvertisements(port, webId) {
    let address = await webIdToAddress(webId, port);
    let gattId = await webIdToGattId(webId, port);
    const storageKey = 'originDevices_'+port.sender.origin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    let validMatchFound = false;
    let deviceName = 'Device Name Unknown';
    // let deviceRssi = 0;
    for (const originDevice of currentOriginDevices) {
        if (originDevice.address === address || (gattId && originDevice.gattId === gattId)) {
            validMatchFound = true;
            deviceName = originDevice.name;
            break;
        }
    }

    // make sure device allowed for origin
    if (!validMatchFound) {
        return { exception: 'UnknownError' };
    }

    if (!await nativeRequest('availability', {}, port)) {
        return { exception: 'InvalidStateError' };
    }

    const listenerKey = 'dev_'+port.sender.contextId+gattId;
    if (listenerKey in listenercnts) {
        listenercnts[listenerKey]++;
        return;
    } else {
        listenercnts[listenerKey] = 1;
    }

    portsObjects.get(port).knownDeviceIds.add(address);
    portsObjects.get(port).knownGattIds.add(gattId);

    function scanResultListener(msg) {
        // Do not mutate the native message before other listeners receive it.
        msg = structuredClone(msg);
        if (msg._type === 'scanResult') {
            msg._type = 'adScanResult';
            msg.subscriptionId = 'scanRequest_'+webId;
            if (msg.bluetoothAddress === address || msg.gattId === gattId) {
                if (msg.localName) {
                    deviceName = msg.localName;
                } else {
                    msg.localName = deviceName;
                }
                for (let i = 0; i < msg.serviceData.length; i++) {
                    msg.serviceData[i].service = normalizeServiceUuid(msg.serviceData[i].service);
                }
                // deviceRssi = msg.rssi;
                delete msg['gattId'];
                msg.address = webId;
                port.postMessage(msg);
            }
        }
    }

    listeners['dev_'+port.sender.contextId+gattId] = scanResultListener;
    nativePort.onMessage.addListener(scanResultListener);

    await startScanning(port, 'dev_'+port.sender.contextId+gattId);

    return { currentRecommendedUpdateContents: currentRecommendedUpdateContents,
        currentOptionalUpdateContents: currentOptionalUpdateContents };
}

async function stopAdvertisements(port, webId, stopAll = false) {
    let gattId = await webIdToGattId(webId, port);
    if ('dev_'+port.sender.contextId+gattId in listeners) {
        listenercnts['dev_'+port.sender.contextId+gattId]--;
        if (stopAll) {
            listenercnts['dev_'+port.sender.contextId+gattId] = 0;
        }
        if (listenercnts['dev_'+port.sender.contextId+gattId] == 0) {
            nativePort.onMessage.removeListener(listeners['dev_'+port.sender.contextId+gattId]);
            delete listeners['dev_'+port.sender.contextId+gattId];
            delete listenercnts['dev_'+port.sender.contextId+gattId];
            await stopScanning(port, 'dev_'+port.sender.contextId+gattId);
        }
    }
}

async function gattConnect(port, webId) {
    let address = await webIdToAddress(webId, port);
    /* Security measure: make sure this device address has been
       previously returned by requestDevice() */
    if (!portsObjects.get(port).knownDeviceIds.has(address)) {
        throw new Error('Unknown device address');
    }

    const storedGattId = await webIdToGattId(webId, port);
    const connectId = serverApiVersion === 2 && typeof storedGattId === 'string'
        ? storedGattId
        : address.replace(/:/g, '');
    const gattId = await nativeRequest('connect', { address: connectId }, port);
    if (gattId != null) {
        if (!(port.sender.origin in webIdToGattIdMap)) {
            webIdToGattIdMap[port.sender.origin] = {};
        }
        webIdToGattIdMap[port.sender.origin][webId] = gattId;
    }
    portsObjects.get(port).devices.add(gattId);
    if (!devices[gattId]) {
        devices[gattId] = new Set();
    }
    devices[gattId].add(port);

    // this is the location where the gattId is to be saved/associated with the device
    const storageKey = 'originDevices_'+port.sender.origin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    let alreadyInStorage = false;
    let needUpdate = false;
    for (let i = 0; i < currentOriginDevices.length; i++) {
        if (currentOriginDevices[i].address === address) {
            alreadyInStorage = true;
            if (!(currentOriginDevices[i].gattId === gattId)) {
                needUpdate = true;
                currentOriginDevices[i].gattId = gattId;
            }
        }
    }
    if (!alreadyInStorage) {
        currentOriginDevices.push({
            address: address, name: portsObjects.get(port).deviceIdNames[address], gattId: gattId,
        });
        needUpdate = true;
    }
    if (needUpdate) {
        await browser.storage.local.set({ [storageKey]: currentOriginDevices });
    }
    return gattId;
}

async function gattDisconnect(port, webId, gattId = null) {
    if (gattId === null) {
        gattId = await webIdToGattId(webId, port);
    }
    try {
        portsObjects.get(port).devices.delete(gattId);
    } catch {}
    if (gattId in devices) {
        devices[gattId].delete(port);
        if (devices[gattId].size === 0) {
            delete characteristicCache[gattId];
            delete devices[gattId];
            if (nativePort && !(nativePort.error)) {
                return await nativeRequest('disconnect', { device: gattId }, port);
            }
        }
    }
}

async function getPrimaryService(port, webId, service) {
    return (await getPrimaryServices(port, webId, service))[0];
}

async function getPrimaryServices(port, webId, service) {
    let gattId = await webIdToGattId(webId, port);
    let options = { device: gattId };
    if (service) {
        options.service = windowsServiceUuid(service);
    }
    const services = await nativeRequest('services', options, port);
    return services.map(normalizeServiceUuid);
}

async function getCharacteristic(port, webId, service, characteristic) {
    const char = (await getCharacteristics(port, webId, service, characteristic)).find(() => true);
    if (!char) {
        throw new Error(`Characteristic ${characteristic} not found`);
    }
    return char;
}

async function getCharacteristics(port, webId, service, characteristic) {
    let gattId = await webIdToGattId(webId, port);
    if (!characteristicCache[gattId]) {
        characteristicCache[gattId] = {};
    }
    if (!characteristicCache[gattId][service]) {
        characteristicCache[gattId][service] = nativeRequest('characteristics', {
            device: gattId,
            service: windowsServiceUuid(service),
        }, port);
    }
    const result = await characteristicCache[gattId][service];
    const characterstics = result.map(c => Object.assign({}, c, { uuid: normalizeCharacteristicUuid(c.uuid) }));
    if (characteristic) {
        return characterstics
            .filter(c => normalizeCharacteristicUuid(c.uuid) == normalizeCharacteristicUuid(characteristic));
    } else {
        return characterstics;
    }
}

async function readValue(port, webId, service, characteristic) {
    let gattId = await webIdToGattId(webId, port);
    return await nativeRequest('read', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    }, port);
}

async function writeValue(port, webId, service, characteristic, value) {
    let gattId = await webIdToGattId(webId, port);
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('write', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        value,
    }, port);
}

async function writeValueWithResponse(port, webId, service, characteristic, value) {
    let gattId = await webIdToGattId(webId, port);
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('writeWithResponse', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        value,
    }, port);
}

async function writeValueWithoutResponse(port, webId, service, characteristic, value) {
    let gattId = await webIdToGattId(webId, port);
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('writeWithoutResponse', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        value,
    }, port);
}

async function startNotifications(port, webId, service, characteristic) {
    let gattId = await webIdToGattId(webId, port);
    // Rust (API v2) server must return subscriptionNames in this format
    const subscriptionName =
        'subscription_'+gattId+'_'+windowsServiceUuid(service)+'_'+
        windowsCharacteristicUuid(characteristic);
    // already notifying for this port
    if (subscriptions[subscriptionName] && subscriptions[subscriptionName].size && serverApiVersion === 2) {
        subscriptions[subscriptionName].add(port);
        trackOriginSubscription(port.sender.origin, gattId, service, characteristic, port);
        return subscriptionName;
    }
    const subscriptionId = await nativeRequest('subscribe', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    }, port);

    if (!subscriptions[subscriptionId]) {
        subscriptions[subscriptionId] = new Set();
    }
    subscriptions[subscriptionId].add(port);
    trackOriginSubscription(port.sender.origin, gattId, service, characteristic, port);
    return subscriptionId;
}

async function stopNotifications(port, webId, service, characteristic) {
    let gattId = await webIdToGattId(webId, port);
    let subscriptionId;
    const subscriptionName =
        'subscription_'+gattId+'_'+windowsServiceUuid(service)+'_'+
        windowsCharacteristicUuid(characteristic);
    const originSubscriptions = subscriptionOrigins[port.sender.origin] ?? [];
    const trackedSubscription = originSubscriptions.some(
        ([subscriptionGattId, subscriptionService, subscriptionCharacteristic, subscriptionPort]) =>
            subscriptionGattId === gattId && subscriptionService === service &&
            subscriptionCharacteristic === characteristic && subscriptionPort === port,
    );
    if (!trackedSubscription) {
        return serverApiVersion === 2 ? subscriptionName : undefined;
    }
    if (subscriptions[subscriptionName] && subscriptions[subscriptionName].size > 1 && serverApiVersion === 2) {
        subscriptions[subscriptionName].delete(port);
        untrackOriginSubscription(port.sender.origin, gattId, service, characteristic, port);
        return subscriptionName;
    }
    if (nativePort && !(nativePort.error)) {
        subscriptionId = await nativeRequest('unsubscribe', {
            device: gattId,
            service: windowsServiceUuid(service),
            characteristic: windowsCharacteristicUuid(characteristic),
        }, port);
    }

    if (subscriptionId && subscriptions[subscriptionId]) {
        subscriptions[subscriptionId].delete(port);
    }
    if (serverApiVersion === 2) {
        delete subscriptions[subscriptionName];
    } else if (subscriptionId && subscriptions[subscriptionId] && !subscriptions[subscriptionId].size) {
        delete subscriptions[subscriptionId];
    }

    untrackOriginSubscription(port.sender.origin, gattId, service, characteristic, port);

    return subscriptionId;
}

async function accept(port, _id) {
    return await nativeRequest('accept', { origId: _id }, port);
}

async function acceptPin(port, _id, pin) {
    return await nativeRequest('acceptPin', { origId: _id, pin: pin }, port);
}

async function cancel(port, _id) {
    return await nativeRequest('cancel', { origId: _id }, port);
}

async function availability(port) {
    return await nativeRequest('availability', {}, port);
}

async function getDescriptor(port, webId, service, characteristic, descriptor) {
    let gattId = await webIdToGattId(webId, port);
    let req = await nativeRequest('getDescriptor', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        descriptor: windowsDescriptorUuid(descriptor),
    }, port);

    req.uuid = normalizeUuid(req.uuid);

    return req;
}

async function getDescriptors(port, webId, service, characteristic, descriptor) {
    let gattId = await webIdToGattId(webId, port);
    let req = await nativeRequest('getDescriptors', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        descriptor: windowsDescriptorUuid(descriptor),
    }, port);

    for (const elem of req.list) {
        elem.uuid = normalizeUuid(elem.uuid);
    }

    return req;
}

async function readDescriptorValue(port, webId, service, characteristic, descriptor) {
    let gattId = await webIdToGattId(webId, port);
    let req = await nativeRequest('readDescriptorValue', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        descriptor: windowsDescriptorUuid(descriptor),
    }, port);

    req.uuid = normalizeUuid(req.uuid);

    return req;
}

async function writeDescriptorValue(port, webId, service, characteristic, descriptor, value) {
    let gattId = await webIdToGattId(webId, port);
    let req = await nativeRequest('writeDescriptorValue', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        descriptor: windowsDescriptorUuid(descriptor),
        value: value,
    }, port);

    req.uuid = normalizeUuid(req.uuid);

    return req;
}

async function getOriginDevices(port) {
    const storageKey = 'originDevices_'+port.sender.origin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    const result = new Set();

    for (const originDev of currentOriginDevices) {
        result.add({ address: originDev.webId, name: originDev.name });
    }
    return result;
}

async function forgetDevice(port, webId, origin = null) {
    const desiredOrigin = (origin ?? port.sender.origin);
    let address = await webIdToAddress(webId, null, desiredOrigin);
    const gattId = await webIdToGattId(webId, null, desiredOrigin);
    if (address === null) {
        return;
    }
    const storageKey = 'originDevices_'+desiredOrigin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    for (let i = 0; i < currentOriginDevices.length; i++) {
        if (currentOriginDevices[i].address === address) {
            currentOriginDevices.splice(i, 1);
            i--;
        }
    }
    if (currentOriginDevices.length === 0) {
        await browser.storage.local.remove(storageKey);
    }
    // this needs to affect all connections to a given domain name
    for (const portObj of portsObjects) {
        if (portObj[0].sender.origin === desiredOrigin) {
            // gattDisconnect removes from devices and disconnects
            await gattDisconnect(portObj[0], webId);
            portObj[1].knownDeviceIds.delete(address);
            portObj[1].knownGattIds.delete(gattId);
            const devIdNames = portObj[1].deviceIdNames;
            delete devIdNames[address];
        }
    }

    // also remove from subscriptions
    if (desiredOrigin in subscriptionOrigins) {
        for (const [subscriptionGattId, service, characteristic, subPort] of [...subscriptionOrigins[desiredOrigin]]) {
            if (subscriptionGattId === gattId) {
                await stopNotifications(subPort, webId, service, characteristic);
            }
        }
    }

    // also stop advertisements
    await stopAdvertisements(port, webId, true);

    if (desiredOrigin in webIdToGattIdMap) {
        delete webIdToGattIdMap[desiredOrigin][webId];
    }

    if (desiredOrigin in webIdToAddressMap) {
        delete webIdToAddressMap[desiredOrigin][webId];
    }
    if (desiredOrigin in gattIdToWebIdMap && gattId !== null) {
        delete gattIdToWebIdMap[desiredOrigin][gattId];
    }

    if (currentOriginDevices.length === 0) {
        await browser.storage.local.remove(storageKey);
    } else {
        await browser.storage.local.set({ [storageKey]: currentOriginDevices });
    }
}

function openOptions() {
    chrome.runtime.openOptionsPage();
}

const exportedMethods = {
    requestDevice,
    gattConnect,
    gattDisconnect,
    getPrimaryService,
    getPrimaryServices,
    getCharacteristic,
    getCharacteristics,
    readValue,
    writeValue,
    writeValueWithResponse,
    writeValueWithoutResponse,
    startNotifications,
    stopNotifications,
    accept,
    acceptPin,
    cancel,
    availability,
    getDescriptor,
    getDescriptors,
    readDescriptorValue,
    writeDescriptorValue,
    getOriginDevices,
    watchAdvertisements,
    stopAdvertisements,
    forgetDevice,
    openOptions,
};

chrome.runtime.onConnect.addListener((port) => {
    portsObjects.set(port, {
        scanCount: 0,
        scanNames: [],
        devices: new Set(),
        // subscriptions: new Set(),
        knownDeviceIds: new Set(),
        knownGattIds: new Set(),
        deviceIdNames: new Map(),
    });

    if (port.sender.url != browser.runtime.getURL('options.html')) {
        activePorts++;

        if (nativePort === null) {
            nativeReady = new Promise((resolve) => {
                nativeResolve = resolve;
            });
            nativePort = chrome.runtime.connectNative('webbt.server');
            nativePort.onDisconnect.addListener(nativePortOnDisconnect);
            nativePort.onMessage.addListener(nativePortOnMessage);
        }


        nativeRequest('ping', {}, port).then(() => {
            console.log('Connected to server');
        });
    }

    port.onDisconnect.addListener(async () => {
        const portState = portsObjects.get(port);
        if (!portState) {
            return;
        }

        const disconnects = [...portState.devices]
            .map(gattId => gattDisconnect(port, null, gattId));
        await Promise.allSettled(disconnects);
        while (portState.scanCount > 0) {
            await stopScanning(port, portState.scanNames.pop());
        }
        for (const value of Object.values(subscriptions)) {
            value.delete(port);
        }
        removePortFromSubscriptionOrigins(port);
        for (const pairingId of Object.keys(pairingPorts)) {
            pairingPorts[pairingId].delete(port);
            if (!pairingPorts[pairingId].size) {
                delete pairingPorts[pairingId];
            }
        }

        // close the dedicated host process if nothing else is using it
        if (port.sender.url != browser.runtime.getURL('options.html')) {
            activePorts--;
            if (!activePorts && nativePort) {
                nativePort.disconnect();
                nativePort = null;
            }
        }

        // this approximates the previous WeakMap usage for portsObjects
        portsObjects.delete(port);
    });

    port.onMessage.addListener((request) => {
        function sendResponse(response) {
            port.postMessage(Object.assign(response, { id: request.id, origin: request.origin }));
        }
        if (!request.command) {
            sendResponse({ error: 'Missing `command`' });
        }
        if (!(request.args instanceof Array)) {
            sendResponse({ error: '`args` must be an array' });
        }
        const fn = exportedMethods[request.command];
        if (fn) {
            fn(port, ...request.args)
                .then(result => sendResponse({ result }))
                .catch(error => sendResponse({ error: error.toString() }));
            return true;
        } else {
            sendResponse({ error: 'Unknown command: ' + request.command });
        }
    });
});
