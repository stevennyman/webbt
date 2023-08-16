/* global navigator, window, Zone */

if (!navigator.bluetooth) {
    // eslint-disable-next-line no-console
    console.log('Windows 10 Web Bluetooth Polyfill loaded');

    (function () {
        const connectionSymbol = Symbol('connection');

        const outstandingRequests = {};
        const activeSubscriptions = {};
        const connectedDevices = new Set();
        let requestId = 0;
        window.addEventListener('message', event => {
            if (event.source === window && event.data && event.data.type === 'WebBluetoothPolyCSToPage') {
                if (event.data.event === 'disconnectEvent') {
                    const { device } = event.data;
                    Array.from(connectedDevices)
                        .filter(d => d.gatt[connectionSymbol] === device)
                        .forEach(matchingDevice => {
                            matchingDevice.gatt[connectionSymbol] = null;
                            matchingDevice.dispatchEvent({ type: 'gattserverdisconnected' });
                            connectedDevices.delete(matchingDevice);
                        });
                    return;
                }
                if (event.data.subscriptionId) {
                    const subscription = activeSubscriptions[event.data.subscriptionId];
                    if (subscription) {
                        subscription(event.data);
                    }
                    return;
                }
                const request = outstandingRequests[event.data.id];
                if (request) {
                    if (event.data.error) {
                        request.reject(event.data.error);
                    } else {
                        request.resolve(event.data.result);
                    }
                    delete outstandingRequests[event.data.id];
                }
            }
        }, false);

        function callExtension(command, args) {
            return new Promise((resolve, reject) => {
                outstandingRequests[requestId] = { resolve, reject };
                window.postMessage({
                    type: 'WebBluetoothPolyPageToCS',
                    id: requestId++,
                    command,
                    args,
                }, '*');
            });
        }

        // Implmentation reference: https://developer.mozilla.org/en/docs/Web/API/EventTarget
        const listeners = Symbol('listeners');
        const originalSymbol = Symbol('original');
        class BluetoothEventTarget {
            constructor() {
                this[listeners] = {};
            }

            addEventListener(type, callback) {
                if (typeof Zone !== 'undefined' && Zone.current && Zone.current.wrap) {
                    const original = callback;
                    callback = Zone.current.wrap(callback);
                    callback[originalSymbol] = original;
                }
                if (!(type in this[listeners])) {
                    this[listeners][type] = [];
                }
                this[listeners][type].push(callback);
            }

            removeEventListener(type, callback) {
                if (!(type in this[listeners])) {
                    return;
                }
                var stack = this[listeners][type];
                for (var i = 0, l = stack.length; i < l; i++) {
                    if (stack[i] === callback || stack[i][originalSymbol] === callback) {
                        stack.splice(i, 1);
                        return;
                    }
                }
            }

            dispatchEvent(event) {
                event.target = this;
                if (event.type === 'characteristicvaluechanged' && this.oncharacteristicvaluechanged) {
                    this.oncharacteristicvaluechanged.call(this, event);
                } else if (event.type === 'gattserverdisconnected' && this.ongattserverdisconnected ) {
                    this.ongattserverdisconnected.call(this, event);
                }
                if (!(event.type in this[listeners])) {
                    return true;
                }
                var stack = [].concat(this[listeners][event.type]);
                for (var i = 0, l = stack.length; i < l; i++) {
                    stack[i].call(this, event);
                }
                return !event.defaultPrevented;
            }
        }

        const subscriptionId = Symbol('subscriptionId');
        const notificationsStarted = Symbol('notificationsStarted');
        class BluetoothRemoteGATTCharacteristic extends BluetoothEventTarget {
            constructor(service, uuid, properties) {
                super();
                this.service = service;
                this.uuid = uuid;
                this.properties = properties;
                this.value = null;
            }

            get _connection() {
                return this.service.device.gatt._connection;
            }

            async getDescriptor(bluetoothDescriptorUUID) {
                const result = await callExtension('getDescriptor',
                    [this._connection, this.service.uuid, this.uuid, bluetoothDescriptorUUID]);
                return new BluetoothRemoteGATTDescriptor(this, result.uuid, result.value);
            }

            async getDescriptors(bluetoothDescriptorUUID) {
                const result = await callExtension('getDescriptors',
                    [this._connection, this.service.uuid, this.uuid, bluetoothDescriptorUUID]);
                let output = [];
                for (const elem of result.list) {
                    output.push(new BluetoothRemoteGATTDescriptor(this, elem.uuid, elem.value));
                }
                return output;
            }

            async readValue() {
                const result = await callExtension('readValue', [this._connection, this.service.uuid, this.uuid]);
                this.value = new DataView(new Uint8Array(result).buffer);
                this.dispatchEvent({
                    type: 'characteristicvaluechanged',
                    bubbles: true,
                });
                return this.value;
            }

            async writeValue(value) {
                const byteValues = Array.from(new Uint8Array(value.buffer || value));
                await callExtension('writeValue',
                    [this._connection, this.service.uuid, this.uuid, byteValues]);
            }

            async writeValueWithResponse(value) {
                const byteValues = Array.from(new Uint8Array(value.buffer || value));
                await callExtension('writeValueWithResponse',
                    [this._connection, this.service.uuid, this.uuid, byteValues]);
            }

            async writeValueWithoutResponse(value) {
                const byteValues = Array.from(new Uint8Array(value.buffer || value));
                await callExtension('writeValueWithoutResponse',
                    [this._connection, this.service.uuid, this.uuid, byteValues]);
            }

            async startNotifications() {
                if (this[notificationsStarted]) {
                    // already subscribed, do nothing
                    return this;
                }
                this[notificationsStarted] = true;

                try {
                    this[subscriptionId] = await callExtension('startNotifications',
                        [this._connection, this.service.uuid, this.uuid]);
                } catch (err) {
                    this[notificationsStarted] = false;
                    throw err;
                }
                activeSubscriptions[this[subscriptionId]] = (event) => {
                    this.value = new DataView(new Uint8Array(event.value).buffer);
                    this.dispatchEvent({
                        type: 'characteristicvaluechanged',
                        bubbles: true,
                    });
                };
                return this;
            }

            async stopNotifications() {
                this[subscriptionId] = await callExtension('stopNotifications',
                    [this._connection, this.service.uuid, this.uuid]);
                delete activeSubscriptions[this[subscriptionId]];
                this[subscriptionId] = null;
                this[notificationsStarted] = false;
                return this;
            }
        }

        class BluetoothRemoteGATTService extends BluetoothEventTarget {
            constructor(device, uuid, isPrimary) {
                super();
                this.device = device;
                this.uuid = uuid;
                this.isPrimary = isPrimary;
                Object.defineProperty(this, 'device', { enumerable: false });
            }

            async getCharacteristic(characteristic) {
                let { uuid, properties } = await callExtension('getCharacteristic',
                    [this.device.gatt._connection, this.uuid, characteristic]);
                return new BluetoothRemoteGATTCharacteristic(this, uuid, properties);
            }

            async getCharacteristics(characteristic) {
                let result = await callExtension('getCharacteristics',
                    [this.device.gatt._connection, this.uuid, characteristic]);
                return result.map(({ uuid, properties }) =>
                    new BluetoothRemoteGATTCharacteristic(this, uuid, properties));
            }

            async getIncludedService(/* service */) {
                // TODO implement
                throw new Error('Not implemented');
            }

            async getIncludedServices(/* service */) {
                // TODO implement
                throw new Error('Not implemented');
            }
        }

        class BluetoothRemoteGATTServer {
            constructor(device) {
                this.device = device;
                this[connectionSymbol] = null;
            }

            async connect() {
                let result = await callExtension('gattConnect', [this.device.id]);
                connectedDevices.add(this.device);
                this[connectionSymbol] = result;
                return this;
            }

            disconnect() {
                if (!this.connected) {
                    return;
                }

                callExtension('gattDisconnect', [this._connection]);
                this[connectionSymbol] = null;
                connectedDevices.delete(this.device);
                this.device.dispatchEvent({ type: 'gattserverdisconnected' });
            }

            get connected() {
                return this[connectionSymbol] !== null;
            }

            get _connection() {
                if (!this.connected) {
                    throw new Error('Invalid state: GATT server not connected');
                }
                return this[connectionSymbol];
            }

            async getPrimaryService(service) {
                let uuid = await callExtension('getPrimaryService', [this._connection, service]);
                if (!uuid) {
                    throw new Error(`Service ${service} not found`);
                }
                return new BluetoothRemoteGATTService(this.device, uuid, true);
            }

            async getPrimaryServices(service) {
                let result = await callExtension('getPrimaryServices', [this._connection, service]);
                return result.map(uuid => new BluetoothRemoteGATTService(this.device, uuid, true));
            }
        }

        class BluetoothDevice extends BluetoothEventTarget {
            constructor(id, name) {
                super();
                this.id = id;
                this.name = name;
                this.gatt = new BluetoothRemoteGATTServer(this);
            }
        }

        class BluetoothRemoteGATTDescriptor {
            constructor(characteristic, uuid, value) {
                this.characteristic = characteristic;
                this.uuid = uuid;
                this.value = new DataView(new Uint8Array(value).buffer);
            }

            async readValue() {
                let result = await callExtension('readDescriptorValue',
                    [this.characteristic._connection, this.characteristic.service.uuid,
                        this.characteristic.uuid, this.uuid]);
                this.value = new DataView(new Uint8Array(result.value).buffer);
                return this.value;
            }

            async writeValue(array) {
                let result = await callExtension('writeDescriptorValue',
                    [this.characteristic._connection, this.characteristic.service.uuid,
                        this.characteristic.uuid, this.uuid, array]);
                this.value = new DataView(new Uint8Array(result.value).buffer);
                return;
            }
        }

        navigator.bluetooth = {
            requestDevice: async function (...args) {
                try {
                    let result = await callExtension('requestDevice', args);
                    return new BluetoothDevice(result.address, result.name);
                } catch (error) {
                    // Windows only
                    if (error == 'The device is not ready for use.\r\n\r\nThe device is not ready for use.\r\n') {
                        throw new Error('Unable to start scanning for Bluetooth devices. ' +
                        'Ensure that your device is Bluetooth-capable and that Bluetooth is turned on.');
                    } else {
                        throw error;
                    }
                }
            },
            getAvailability: async function () {
                let result = await callExtension('availability', []);
                return result;
            },
        };

        function handleUnnamedUUID(alias, result) {
            if (result) {
                return BluetoothUUID.canonicalUUID(result);
            }
            try {
                return BluetoothUUID.canonicalUUID(alias);
            /* eslint-disable-next-line no-empty*/
            } catch (error) {}
            if (alias.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
                return alias;
            }
            throw new TypeError('Not a valid name, short UUID, or full UUID');
        }

        BluetoothUUID = {
            canonicalUUID: function (alias) {
                let aliasint = Number(alias);
                if (isNaN(aliasint)) {
                    throw new TypeError('Not a valid number');
                }
                if (aliasint > 0xFFFFFFFF) {
                    throw new TypeError('Value is too large');
                }
                let result = aliasint.toString(16).padStart('8', '0') + '-0000-1000-8000-00805f9b34fb';
                return result;
            },
            getService: function (alias) {
                return handleUnnamedUUID(alias, STANDARD_GATT_SERVICES[alias] || null);
            },
            getCharacteristic: function (alias) {
                return handleUnnamedUUID(alias, STANDARD_GATT_CHARACTERISTICS[alias] || null);
            },
            getDescriptor: function (alias) {
                return handleUnnamedUUID(alias, STANDARD_GATT_DESCRIPTORS[alias] || null);
            },
        };
    })();
}
