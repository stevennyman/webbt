/* eslint-disable no-console */

SUPPORTED_HOST_API_VERSION = 1;

let debugPrints = true;

let requestId = 0;
let requests = {};

let commandPorts = {};
let activePorts = 0;
let nativePort = null;

let listeners = {};
let listenercnts = {};

async function nativeRequest(cmd, params, port) {
    return new Promise((resolve, reject) => {
        requests[requestId] = { resolve, reject };
        commandPorts[requestId] = port;
        const msg = Object.assign(params || {}, {
            cmd,
            _id: requestId++,
        });
        if (debugPrints) {
            console.log('Sent native message:', msg);
        }
        nativePort.postMessage(msg);
    });
}

const subscriptions = {};
const devices = {};

function nativePortOnMessage(msg) {
    if (debugPrints) {
        console.log('Received native message:', msg);
    }
    if (msg._type === 'Start') {
        if (msg.apiVersion != SUPPORTED_HOST_API_VERSION) {
            nativePort.disconnect();
            for (const reqId in requests) {
                delete commandPorts[reqId];
                const { reject, resolve } = requests[reqId];
                reject('Unsupported host version');
                delete requests[reqId];
            }
            requests = {};
            commandPorts = {};
            console.log('Unsupported host version!');
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
            device.forEach(port => {
                port.postMessage({ event: 'disconnectEvent', device: gattId });
                portsObjects.get(port).devices.delete(gattId);
            });
            delete characteristicCache[gattId];
            delete devices[gattId];
        }
    }
}

const portsObjects = new Map();
const subscriptionOrigins = {};
const characteristicCache = {};

function nativePortOnDisconnect() {
    console.log('Disconnected!', chrome.runtime.lastError.message);
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
    if (!scanningCounter) {
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
    port.postMessage({ _type: 'showDeviceChooser' });
    try {
        await startScanning(port);
    } catch (error) {
        if (error == 'The device is not ready for use.\r\n\r\nThe device is not ready for use.\r\n') {
            port.postMessage({ _type: 'deviceChooserWinError' });
            throw error;
        }
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
                    resolve({deviceAddress: msg.deviceId, gattId: msg.gattId});
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
        for (let i = 0; i < currentOriginDevices.length; i++) {
            if (currentOriginDevices[i].address === deviceAddress) {
                alreadyInStorage = true;
                if (!(currentOriginDevices[i].name === deviceNames[deviceAddress])) {
                    // hopefully this doesn't cause valuable names to be lost
                    currentOriginDevices[i].name = deviceNames[deviceAddress];
                }
            }
        }
        if (!alreadyInStorage) {
            currentOriginDevices.push({ address: deviceAddress, name: deviceNames[deviceAddress], gattId: gattId });
        }
        await browser.storage.local.set({ [storageKey]: currentOriginDevices });

        return {
            address: deviceAddress,
            __rssi: deviceRssi[deviceAddress],
            name: deviceNames[deviceAddress],
            gattId: gattId,
        };
    } finally {
        stopScanning(port);
        nativePort.onMessage.removeListener(scanResultListener);
    }
}

async function watchAdvertisements(port, address, gattId) {
    const storageKey = 'originDevices_'+port.sender.origin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    let validMatchFound = false;
    let deviceName = 'Device Name Unknown';
    let deviceRssi = 0;
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
        listenercnts['dev_'+port+gattId]++;
        return;
    } else {
        listenercnts['dev_'+port+gattId] = 1;
    }

    // TODO: throw InvalidStateError if Bluetooth off

    portsObjects.get(port).knownDeviceIds.add(address);
    portsObjects.get(port).knownGattIds.add(gattId);

    function scanResultListener(msg) {
        msg = structuredClone(msg); // todo: is this necessary?
        if (msg._type === 'scanResult') {
            msg._type = 'adScanResult';
            msg.subscriptionId = 'scanRequest_'+address;
            if (msg.bluetoothAddress === address || msg.gattId === gattId) {
                if (msg.localName) {
                    deviceName = msg.localName;
                } else {
                    msg.localName = deviceName;
                }
                for (let i = 0; i < msg.serviceData.length; i++) {
                    msg.serviceData[i].service = normalizeServiceUuid(msg.serviceData[i].service);
                }
                deviceRssi = msg.rssi;
                port.postMessage(msg);
            }
        }
    }

    listeners['dev_'+port+gattId] = scanResultListener;
    nativePort.onMessage.addListener(scanResultListener);

    await startScanning(port);

    return {};
}

async function stopAdvertisements(port, address, gattId, stopAll = false) {
    if ('dev_'+port+gattId in listeners) {
        listenercnts['dev_'+port+gattId]--;
        if (stopAll) {
            listenercnts['dev_'+port+gattId] = 0;
        }
        if (listenercnts['dev_'+port+gattId] == 0) {
            nativePort.onMessage.removeListener(listeners['dev_'+port+gattId]);
            delete listeners['dev_'+port+gattId];
            delete listenercnts['dev_'+port+gattId];
            await stopScanning(port);
        }
    }
}

async function gattConnect(port, address) {
    /* Security measure: make sure this device address has been
       previously returned by requestDevice() */
    // TODO we also need to save the gattId from below
    if (!portsObjects.get(port).knownDeviceIds.has(address)) {
        throw new Error('Unknown device address');
    }

    const gattId = await nativeRequest('connect', { address: address.replace(/:/g, '') }, port);
    portsObjects.get(port).devices.add(gattId);
    if (!devices[gattId]) {
        devices[gattId] = new Set();
    }
    devices[gattId].add(port);

    // this is the location where the gattId is to be saved/associated with the device
    const storageKey = 'originDevices_'+port.sender.origin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
    let alreadyInStorage = false;
    for (let i = 0; i < currentOriginDevices.length; i++) {
        if (currentOriginDevices[i].address === address) {
            alreadyInStorage = true;
            if (!(currentOriginDevices[i].gattId === gattId)) {
                currentOriginDevices[i].gattId = gattId;
            }
        }
    }
    if (!alreadyInStorage) {
        currentOriginDevices.push({ address: address, name: deviceNames[address], gattId: gattId });
    }
    await browser.storage.local.set({ [storageKey]: currentOriginDevices });
    port.postMessage({ event: "gattIdUpdateEvent", address: address, gattId: gattId });
    return gattId;
}

async function gattDisconnect(port, gattId) {
    portsObjects.get(port).devices.delete(gattId);
    if (gattId in devices) {
        devices[gattId].delete(port);
        if (devices[gattId].size === 0) {
            delete characteristicCache[gattId];
            delete devices[gattId];
            return await nativeRequest('disconnect', { device: gattId }, port);
        }
    }

}

async function getPrimaryService(port, gattId, service) {
    return (await getPrimaryServices(port, gattId, service))[0];
}

async function getPrimaryServices(port, gattId, service) {
    let options = { device: gattId };
    if (service) {
        options.service = windowsServiceUuid(service);
    }
    const services = await nativeRequest('services', options, port);
    return services.map(normalizeServiceUuid);
}

async function getCharacteristic(port, gattId, service, characteristic) {
    const char = (await getCharacteristics(port, gattId, service, characteristic)).find(() => true);
    if (!char) {
        throw new Error(`Characteristic ${characteristic} not found`);
    }
    return char;
}

async function getCharacteristics(port, gattId, service, characteristic) {
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

async function readValue(port, gattId, service, characteristic) {
    return await nativeRequest('read', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    }, port);
}

async function writeValue(port, gattId, service, characteristic, value) {
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

async function writeValueWithResponse(port, gattId, service, characteristic, value) {
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

async function writeValueWithoutResponse(port, gattId, service, characteristic, value) {
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

async function startNotifications(port, gattId, service, characteristic) {
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

async function stopNotifications(port, gattId, service, characteristic) {
    const subscriptionId = await nativeRequest('unsubscribe', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    }, port);

    subscriptions[subscriptionId].delete(port);
    if (!subscriptions[subscriptionId].size) {
        delete subscriptions[subscriptionId];
    }

    // remove subscriptionOrigins entry and clean up empty keys if needed
    const originSubscriptions = subscriptionOrigins[port.sender.origin][gattId];
    const index = originSubscriptions.findIndex(
        ([svc, char, prt]) => svc === service && char === characteristic && prt === port
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

async function getDescriptor(port, gattId, service, characteristic, descriptor) {
    let req = await nativeRequest('getDescriptor', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        descriptor: windowsDescriptorUuid(descriptor),
    }, port);

    req.uuid = normalizeUuid(req.uuid);

    return req;
}

async function getDescriptors(port, gattId, service, characteristic, descriptor) {
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

async function readDescriptorValue(port, gattId, service, characteristic, descriptor) {
    let req = await nativeRequest('readDescriptorValue', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        descriptor: windowsDescriptorUuid(descriptor),
    }, port);

    req.uuid = normalizeUuid(req.uuid);

    return req;
}

async function writeDescriptorValue(port, gattId, service, characteristic, descriptor, value) {
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
        result.add(originDev);
    }
    return result;
}

async function forgetDevice(port, deviceId, gattId, origin = null) {
    const desiredOrigin = (origin ?? port.sender.origin);
    const storageKey = 'originDevices_'+desiredOrigin;
    const currentOriginDevices = (await browser.storage.local.get({ [storageKey]: [] }))[storageKey];
        for (let i = 0; i < currentOriginDevices.length; i++) {
        if (currentOriginDevices[i].address === deviceId) {
            currentOriginDevices.splice(i, 1);
            i--;
        }
    }
    if (currentOriginDevices.length === 0) {
        await browser.storage.local.remove(storageKey);
    }
    // this needs to affect all connections to a given domain name
    for (const portObj of portsObjects) {
        console.log(portObj[0]);
        if (portObj[0].sender.origin === desiredOrigin) {
            // gattDisconnect removes from devices and disconnects
            await gattDisconnect(portObj[0], deviceId);
            console.log(portObj[1]);
            portObj[1].knownDeviceIds.delete(deviceId);

            // TODO check this
            const devIdNames = portObj[1].deviceIdNames;
            delete devIdNames[deviceId];
        }
    }

    // also remove from subscriptions
    if (desiredOrigin in subscriptionOrigins && deviceId in subscriptionOrigins[desiredOrigin]) {
        const subList = subscriptionOrigins[desiredOrigin][deviceId];
        for (const elem of subList) {
            await stopNotifications(elem[2], deviceId, elem[0], elem[1]);
        }
    }

    // also stop advertisements
    await stopAdvertisements(port, deviceId, gattId, true);    

    // TODO refactor connection to primarily use gatt IDs?

    if (currentOriginDevices.length === 0) {
        await browser.storage.local.remove(storageKey);
    } else {
        await browser.storage.local.set({ [storageKey]: currentOriginDevices });
    }
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
};

chrome.runtime.onConnect.addListener((port) => {
    activePorts++;

    portsObjects.set(port, {
        scanCount: 0,
        devices: new Set(),
        subscriptions: new Set(),
        knownDeviceIds: new Set(),
        knownGattIds: new Set(),
        deviceIdNames: new Map(),
    });

    if (nativePort === null) {
        nativePort = chrome.runtime.connectNative('web_bluetooth.server');
    }

    nativePort.onMessage.addListener(nativePortOnMessage);
    nativePort.onDisconnect.addListener(nativePortOnDisconnect);

    nativeRequest('ping', {}, port).then(() => {
        console.log('Connected to server');
    });

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
        activePorts--;
        if (!activePorts) {
            nativePort.disconnect();
            nativePort = null;
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
