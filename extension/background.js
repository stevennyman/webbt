const SUPPORTED_HOST_API_VERSION = 1;

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

let currentRecommendedUpdateContents = null;

async function openOrFocusInfoTab() {
    if (Date.now() - lastInfoTab < COOLDOWN_MS) return;
    if ((await browser.storage.local.get('hideInstallation')).hideInstallation) return;
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


async function nativeRequest(cmd, params, port) {
    return new Promise(async (resolve, reject) => {
        requests[requestId] = { resolve, reject };
        commandPorts[requestId] = port;
        const msg = Object.assign(params || {}, {
            cmd,
            _id: requestId++,
        });
        if (cmd != 'ping') {
            await nativeReady;
            if (debugPrints) {
                console.log('nativeReady complete');
            }
        }
        if (debugPrints) {
            console.log('Sent native message:', msg);
        }
        try {
            nativePort.postMessage(msg);
        } catch (e) {
            if (debugPrints) {
                console.log(e);
            }
            nativeResolve();
            if (nativePort.error && nativePort.error.message.startsWith('No such native application ')) {
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
    nativeResolve();
    if (debugPrints) {
        console.log('Received native message:', msg);
    }
    if (msg._type === 'Start') {
        if (msg.apiVersion != SUPPORTED_HOST_API_VERSION) {
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
        } else if (msg.serverName == 'bleserver-win-cppcx' && msg.serverVersion == '0.5.2') {
            // we're not requiring 0.5.2 server users to update but we are recommending it
            // server API remains compatible, some users may have restrictions preventing them from installing software
            currentRecommendedUpdateContents = { _type: 'recommendedUpdate', message: 'A recommended update for WebBT Server, version 0.5.3, is now available for your system. This update improves performance and pairing reliability.', consoleMessage: 'A recommended update for WebBT Server, version 0.5.3, is now available for your system. This update improves performance and pairing reliability. https://github.com/stevennyman/webbt/releases/latest' };
            for (const reqId in requests) {
                commandPorts[reqId].postMessage({ currentRecommendedUpdateContents: currentRecommendedUpdateContents });
            }
        } else {
            currentRecommendedUpdateContents = null;
            for (const reqId in requests) {
                commandPorts[reqId].postMessage({ currentRecommendedUpdateContents: null });
            }
        }
    }
    if (msg.pairingType && commandPorts[msg._id]) {
        commandPorts[msg._id].postMessage(msg);
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
        if (device) {
            device.forEach(async port => {
                port.postMessage({ event: 'disconnectEvent', device: (await gattIdToWebId(gattId, port)) });
                portsObjects.get(port).devices.delete(gattId);
            });
            delete characteristicCache[gattId];
            delete devices[gattId];
        }
    }
}

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

const portsObjects = new Map();
const subscriptionOrigins = {};
const characteristicCache = {};

function nativePortOnDisconnect(port) {
    nativeResolve();
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

function normalizeCharacteristicUuid(uuid) {
    return normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS);
}

function windowsServiceUuid(uuid) {
    return '{' + normalizeUuid(uuid, STANDARD_GATT_SERVICES) + '}';
}

function windowsCharacteristicUuid(uuid) {
    return '{' + normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS) + '}';
}

function windowsDescriptorUuid(uuid) {
    if (uuid) {
        return '{' + normalizeUuid(uuid, STANDARD_GATT_DESCRIPTORS) + '}';
    } else {
        return uuid;
    }
}

let scanningCounter = 0;
async function startScanning(port) {
    if (!scanningCounter) {
        await nativeRequest('scan', {}, port);
    }
    portsObjects.get(port).scanCount++;
    scanningCounter++;
}

function stopScanning(port) {
    scanningCounter--;
    portsObjects.get(port).scanCount--;
    if (!scanningCounter && nativePort && !(nativePort.error)) {
        nativeRequest('stopScan', {}, port);
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
        let companyIdentifierFlag = false;
        for (const elem of device.manufacturerData) {
            for (const elemInner of filter.manufacturerData) {
                if (!elemInner.companyIdentifier) {
                    throw new Error('manufacturerData is missing required companyIdentifier');
                }
                if (elem.companyIdentifier == elemInner.companyIdentifier) {
                    companyIdentifierFlag = true;
                    if (processPrefixMask(elem, elemInner) === false) {
                        return false;
                    }
                }
            }
        }
        if (!companyIdentifierFlag) {
            return false;
        }
    }

    if (filter.serviceData) {
        let serviceFlag = false;
        for (const elem of device.serviceData) {
            for (const elemInner of filter.serviceData) {
                if (!elemInner.service) {
                    throw new Error('serviceData is missing required service');
                }
                if (normalizeServiceUuid(elem.service) == normalizeServiceUuid(elemInner.service)) {
                    serviceFlag = true;
                    if (processPrefixMask(elem, elemInner) === false) {
                        return false;
                    }
                }
            }
        }
        if (!serviceFlag) {
            return false;
        }
    }
    return true;
}

const webIdToGattIdMap = {};
const webIdToAddressMap = {};

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

// TODO: this function (infrequently used) does not cache values and may be slow
async function gattIdToWebId(gattId, port = null, origin = null) {
    if (origin === null) {
        origin = port.sender.origin;
    }
    const storageKey = 'originDevices_'+origin;
    if (!(origin in webIdToAddressMap)) {
        webIdToAddressMap[origin] = {};
    }

    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    let compl = false;
    for (const dev of currentOriginDevices) {
        if (dev.gattId === gattId) {
            compl = true;
            // webIdToAddressMap[origin][webId] = dev.address;
            return dev.webId;
        }
    }
    if (!compl) {
        return null;
    }
}

async function requestDevice(port, options) {
    if ((!options.filters && !options.acceptAllDevices) || (options.filters && options.acceptAllDevices)) {
        // TODO better filters validation, proper error message
        // Most validation is implemented except for empty list checks
        throw new Error('One of filters or acceptAllDevices must be provided');
    }
    if (options.exclusionFilters && ! options.filters) {
        throw new Error('exclusionFilters requires filters');
    }
    if (options.filters) {
        if (options.filters.manufacturerData) {
            for (const elem of options.filters.manufacturerData) {
                if (!elem.companyIdentifier) {
                    throw new Error('manufacturerData is missing required companyIdentifier');
                }
            }
        }
        if (options.filters.serviceData) {
            for (const elem of options.filters.serviceData) {
                if (!elem.service) {
                    throw new Error('serviceData is missing required service');
                }
            }
        }
    }

    let deviceNames = {};
    let deviceRssi = {};
    function scanResultListener(msg) {
        if (msg._type === 'scanResult') {
            if (msg.localName) {
                deviceNames[msg.bluetoothAddress] = msg.localName;
            } else {
                msg.localName = deviceNames[msg.bluetoothAddress];
            }
            for (let i = 0; i < msg.serviceData.length; i++) {
                msg.serviceData[i].service = normalizeServiceUuid(msg.serviceData[i].service);
            }
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
    });
    try {
        await startScanning(port);
    } catch (error) {
        if (error == 'The device is not ready for use.\r\n\r\nThe device is not ready for use.\r\n') {
            port.postMessage({ _type: 'deviceChooserWinError' });
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
        await browser.storage.local.set({ [storageKey]: currentOriginDevices });

        return {
            address: currentWebId,
            __rssi: deviceRssi[deviceAddress],
            name: deviceNames[deviceAddress],
        };
    } finally {
        stopScanning(port);
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

    if ('dev_'+port+gattId in listenercnts) {
        listenercnts['dev_'+port.sender.contextId+gattId]++;
        return;
    } else {
        listenercnts['dev_'+port.sender.contextId+gattId] = 1;
    }

    // TODO: throw InvalidStateError if Bluetooth off

    portsObjects.get(port).knownDeviceIds.add(address);
    portsObjects.get(port).knownGattIds.add(gattId);

    function scanResultListener(msg) {
        msg = structuredClone(msg); // todo: is this necessary?
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

    await startScanning(port);

    return { currentRecommendedUpdateContents: currentRecommendedUpdateContents };
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
            await stopScanning(port);
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

    const gattId = await nativeRequest('connect', { address: address.replace(/:/g, '') }, port);
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
    const subscriptionId = await nativeRequest('subscribe', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    }, port);

    if (!subscriptions[subscriptionId]) {
        subscriptions[subscriptionId] = new Set();
    }
    subscriptions[subscriptionId].add(port);

    ((subscriptionOrigins[port.sender.origin] ??= {})[gattId] ??= []).push([service, characteristic, port]);
    portsObjects.get(port).subscriptions.add(subscriptionId);
    return subscriptionId;
}

async function stopNotifications(port, webId, service, characteristic) {
    let gattId = await webIdToGattId(webId, port);
    let subscriptionId;
    if (nativePort && !(nativePort.error)) {
        subscriptionId = await nativeRequest('unsubscribe', {
            device: gattId,
            service: windowsServiceUuid(service),
            characteristic: windowsCharacteristicUuid(characteristic),
        }, port);
    }

    subscriptions[subscriptionId].delete(port);
    if (!subscriptions[subscriptionId].size) {
        delete subscriptions[subscriptionId];
    }

    // remove subscriptionOrigins entry and clean up empty keys if needed
    const originSubscriptions = subscriptionOrigins[port.sender.origin][gattId];
    const index = originSubscriptions.findIndex(
        ([svc, char, prt]) => svc === service && char === characteristic && prt === port,
    );
    if (index > -1) originSubscriptions.splice(index, 1);
    if (!originSubscriptions.length) delete subscriptionOrigins[port.sender.origin][gattId];
    if (!Object.keys(subscriptionOrigins[port.sender.origin]).length) delete subscriptionOrigins[port.sender.origin];

    portsObjects.get(port).subscriptions.delete(subscriptionId);
    return subscriptionId;
}

async function accept(port, _id) {
    return await nativeRequest('accept', { origId: _id }, port);
}

async function acceptPasswordCredential(port, _id, username, password) {
    return await nativeRequest('acceptPasswordCredential',
        { origId: _id, username: username, password: password }, port);
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

            // TODO check this
            const devIdNames = portObj[1].deviceIdNames;
            delete devIdNames[address];
        }
    }

    // also remove from subscriptions
    if (desiredOrigin in subscriptionOrigins) {
        for (const possibleAddress of Object.keys(subscriptionOrigins[desiredOrigin])) {
            if (possibleAddress.endsWith(address)) {
                const subList = subscriptionOrigins[desiredOrigin][possibleAddress];
                for (const elem of subList) {
                    await stopNotifications(elem[2], webId, elem[0], elem[1]);
                }
            }
        }
    }

    // also stop advertisements
    await stopAdvertisements(port, webId, true);

    // TODO refactor connection to primarily use gatt IDs?

    if (desiredOrigin in webIdToGattIdMap) {
        for (const possibleAddress of Object.entries(webIdToGattIdMap[desiredOrigin])) {
            if (possibleAddress[1].endsWith(address)) {
                delete webIdToGattIdMap[desiredOrigin][possibleAddress[0]];
            }
        }
    }

    if (desiredOrigin in webIdToAddressMap) {
        for (const possibleAddress of Object.entries(webIdToAddressMap[desiredOrigin])) {
            if (possibleAddress[1] == address) {
                delete webIdToAddressMap[desiredOrigin][possibleAddress[0]];
            }
        }
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
    acceptPasswordCredential,
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
        devices: new Set(),
        subscriptions: new Set(),
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

    port.onDisconnect.addListener(() => {
        for (let gattDevice of portsObjects.get(port).devices.values()) {
            gattDisconnect(port, gattDevice);
        }
        while (portsObjects.get(port).scanCount > 0) {
            stopScanning(port);
        }
        for (const value of Object.values(subscriptions)) {
            value.delete(port);
        }

        // close the dedicated host process if nothing else is using it
        if (port.sender.url != browser.runtime.getURL('options.html')) {
            activePorts--;
            if (!activePorts) {
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
