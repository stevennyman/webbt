/* eslint-disable no-console */

let debugPrints = false;

let requestId = 0;
let requests = {};

let commandPorts = {};

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
        portsObjects.get(port).nativeConnection.postMessage(msg);
    });
}

const subscriptions = {};
const devices = {};
function nativePortOnMessage(msg) {
    if (debugPrints) {
        console.log('Received native message:', msg);
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
        const port = subscriptions[msg.subscriptionId];
        if (port) {
            port.postMessage(msg);
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

let portsObjects = new WeakMap();
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
function startScanning(port) {
    if (!scanningCounter) {
        nativeRequest('scan', {}, port);
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
        if (!filter.companyIdentifier) {
            throw new Error('manufacturerData is missing required companyIdentifier');
        }
        let companyIdentifierFlag = false;
        for (const elem of device.manufacturerData) {
            for (const elemInner of filter.manufacturerData) {
                if (elem.companyIdentifier == elemInner.companyIdentifier) {
                    companyIdentifierFlag = true;
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
                }
            }
        }
        if (!companyIdentifierFlag) {
            return false;
        }
    }
    return true;
}

async function requestDevice(port, options) {
    if (!options.filters && !options.acceptAllDevices) {
        // TODO better filters validation, proper error message
        throw new Error('Filters must be provided');
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

    portsObjects.get(port).nativeConnection.onMessage.addListener(scanResultListener);
    port.postMessage({ _type: 'showDeviceChooser' });
    startScanning(port);
    try {
        const deviceAddress = await new Promise((resolve, reject) => {
            port.onMessage.addListener(msg => {
                if (msg.type === 'WebBluetoothPolyPageToCS') {
                    // This is a message from the page itself, not from the content script.
                    // Therefore, we don't trust it.
                    return;
                }
                if (msg.cmd === 'chooserPair') {
                    resolve(msg.deviceId);
                }
                if (msg.cmd === 'chooserCancel') {
                    reject(new Error('User canceled device chooser'));
                }
            });
        });

        portsObjects.get(port).knownDeviceIds.add(deviceAddress);

        return {
            address: deviceAddress,
            __rssi: deviceRssi[deviceAddress],
            name: deviceNames[deviceAddress],
        };
    } finally {
        stopScanning(port);
        portsObjects.get(port).nativeConnection.onMessage.removeListener(scanResultListener);
    }
}

async function gattConnect(port, address) {
    /* Security measure: make sure this device address has been
       previously returned by requestDevice() */
    if (!portsObjects.get(port).knownDeviceIds.has(address)) {
        throw new Error('Unknown device address');
    }

    const gattId = await nativeRequest('connect', { address: address.replace(/:/g, '') }, port);
    portsObjects.get(port).devices.add(gattId);
    if (!devices[gattId]) {
        devices[gattId] = new Set();
    }
    devices[gattId].add(port);
    return gattId;
}

async function gattDisconnect(port, gattId) {
    portsObjects.get(port).devices.delete(gattId);
    devices[gattId].delete(port);
    if (devices[gattId].size === 0) {
        delete characteristicCache[gattId];
        delete devices[gattId];
        return await nativeRequest('disconnect', { device: gattId }, port);
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

    subscriptions[subscriptionId] = port;
    portsObjects.get(port).subscriptions.add(subscriptionId);
    return subscriptionId;
}

async function stopNotifications(port, gattId, service, characteristic) {
    const subscriptionId = await nativeRequest('unsubscribe', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    }, port);

    delete subscriptions[subscriptionId];
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
};

chrome.runtime.onConnect.addListener((port) => {
    portsObjects.set(port, {
        scanCount: 0,
        devices: new Set(),
        subscriptions: new Set(),
        knownDeviceIds: new Set(),
        nativeConnection: chrome.runtime.connectNative('web_bluetooth.server'),
    });

    portsObjects.get(port).nativeConnection.onMessage.addListener(nativePortOnMessage);
    portsObjects.get(port).nativeConnection.onDisconnect.addListener(nativePortOnDisconnect);

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

        // close the dedicated host process
        portsObjects.get(port).nativeConnection.disconnect();
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
