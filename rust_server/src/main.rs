// WebBT Server
// Copyright (C) 2025, Steven Nyman. License: MIT.

use bluest::{Adapter, ConnectionEvent, Device, DeviceId, Uuid};
use serde_json::{Map, Value, json};
use single_instance::SingleInstance;
use tokio::task::JoinHandle;
use webextension_native_messaging::{read_message, write_message};
use std::{collections::HashMap, sync::{Arc}};
use tokio::sync::{Mutex, mpsc, oneshot};
use futures_lite::stream::StreamExt;

const API_VERSION: i32 = 2;

// enum ServiceCmd {
//     Read { char_uuid: Uuid, resp: oneshot::Sender<Result<Vec<u8>, String>> },
//     Write { char_uuid: Uuid, data: Vec<u8>, with_rsp: bool, resp: oneshot::Sender<Result<(), String>> },
//     Subscribe { char_uuid: Uuid, sub_name: String, resp: oneshot::Sender<Result<(), String>> },
//     Stop,
// }

// async fn service_actor(device_id: DeviceId, service_str: Value, mut rx:mpsc::Receiver<ServiceCmd>) {

// }

async fn process_command(command: Value, active_scans: Arc<Mutex<HashMap<String, JoinHandle<()>>>>, device_cache: Arc<Mutex<HashMap<String, Device>>>, active_subscriptions: Arc<Mutex<HashMap<String, JoinHandle<()>>>>) {
    let mut response = Map::new();
    response.insert("_type".into(), "response".into());
    let cmd_id: i64 = command.get("_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    response.insert("_id".into(), cmd_id.into());

    match execute_command(&command, active_scans, device_cache, active_subscriptions).await {
        Ok(result) => {
            response.insert("result".into(), result);
        }
        Err(e) => {
            response.insert("result".into(), Value::Null);
            response.insert("error".into(), Value::String(e.to_string()));
        }
    }

    let _ = write_message(&response);
}

// background thread
async fn scan_advertisements(name: &str, service_list: Vec<Uuid>, device_cache: Arc<Mutex<HashMap<String, Device>>>) -> Result<(), Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await.expect("Adapter required to scan");
    let mut scan_final = adapter.scan(service_list.as_slice()).await?;
    while let Some(discovered_device) = scan_final.next().await {
        let mut device_cache_ul = device_cache.lock().await;
        device_cache_ul.insert(discovered_device.device.id().to_string(), discovered_device.device.clone());
        let mut msg = Map::new();
        msg.insert("_type".into(), "scanResult".into());
        // NEW for Rust
        msg.insert("scanName".into(), name.into());
        // not necessarily an address any more
        msg.insert("bluetoothAddress".into(), discovered_device.device.id().to_string().into());
        msg.insert("rssi".into(), discovered_device.rssi.into());
        // dropping timestamp, advType which were unused
        msg.insert("localName".into(), discovered_device.adv_data.local_name.or(Some("".to_string())).into());
        // TODO REGRESSION reimplement appearance
        msg.insert("appearance".into(), Value::Null);
        //msg.insert("appearance".into(), discovered_device.adv_data.service_data);
        let tx_power = discovered_device.adv_data.tx_power_level;
        match tx_power {
            Some(result) => {
                msg.insert("txPower".into(), result.into());
            }
            None => {
                msg.insert("txPower".into(), Value::Null);
            }
        }
        let service_uuids: Vec<_> = discovered_device
            .adv_data
            .services
            .into_iter()
            .map(|u| u.to_string().into())
            .collect();
        msg.insert("serviceUuids".into(), Value::Array(service_uuids));
        // REGRESSION this library doesn't support multiple manufacturer data
        let manufacturer_data = discovered_device.adv_data.manufacturer_data;
        match manufacturer_data {
            Some(result) => {
                msg.insert("manufacturerData".into(), json!([{"companyIdentifier": result.company_id, "data": result.data}]));
            }
            None => {
                msg.insert("manufacturerData".into(), json!([]));
            }
        }

        // REGRESSION? UUID format
        let service_data: Vec<Value> = discovered_device
            .adv_data
            .service_data
            .iter()
            .map(|(uuid, data)| json!({ "service": uuid.to_string(), "data": data.clone() }))
            .collect();
        msg.insert("serviceData".into(), json!(service_data));

        // now a duplicate of bluetoothAddress
        msg.insert("gattId".into(), discovered_device.device.id().to_string().into());
        
        let _ = write_message(&msg);
    }

    Ok(())
}

async fn notify_characteristic(dev: &Device, service: &Value, characteristic: &Value, subscription_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    let service_uuid_str = service.as_str().ok_or_else(|| "Service string not available")?;
    let service_uuid = Uuid::parse_str(service_uuid_str)?;
    let services = dev.discover_services_with_uuid(service_uuid).await?;
    let res = services.get(0).ok_or_else(|| "Service not available")?;
    let reschr = res.discover_characteristics_with_uuid(Uuid::parse_str(characteristic.as_str().ok_or_else(|| "Characteristic not available")?)?).await?;
    let mut scan = reschr.get(0).ok_or_else(|| "Characteristic not found")?.notify().await?;
    while let Some(value) = scan.next().await {
        let mut msg = Map::new();
        msg.insert("_type".into(), "valueChangedNotification".into());
        // NEW for Rust
        msg.insert("subscriptionId".into(), subscription_name.into());
        // not necessarily an address any more
        msg.insert("value".into(), value?.into());
        
        let _ = write_message(&msg);
    }

    Ok(())
}

async fn execute_command(command: &Value, active_scans: Arc<Mutex<HashMap<String, JoinHandle<()>>>>, device_cache: Arc<Mutex<HashMap<String, Device>>>, active_subscriptions: Arc<Mutex<HashMap<String, JoinHandle<()>>>>) -> Result<Value, Box<dyn std::error::Error>> {
    match command.get("cmd") {
        Some(Value::String(t)) => match t.as_str() {
            "ping" => {
                return Ok(Value::String("pong".into()));
            }
            "scan" => {
                // TODO move to separate function
                let name = command.get("name")
                    .and_then(|v| v.as_str())
                    .ok_or("No name for subscribe command")?
                    .to_string();
                let name_clone = name.clone();
                let service_list: Vec<Uuid> = command.get("serviceList")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .filter_map(|s| Uuid::parse_str(s).ok())
                            .collect()
                    })
                    .unwrap_or_default();
                let handle = tokio::spawn(async move {
                    let _ = scan_advertisements(&name_clone, service_list, device_cache).await;
                });
                let mut active_locked = active_scans.lock().await;
                active_locked.insert(name, handle);
                return Ok(Value::Null);
            }
            "stopScan" => {
                // TODO move to separate function
                let name = command.get("name")
                    .and_then(|v| v.as_str())
                    .ok_or("No name for subscribe command")?
                    .to_string();
                let mut active_locked = active_scans.lock().await;
                active_locked.remove(&name).ok_or_else(||"Active scan not found")?.abort();
                return Ok(Value::Null);
            }
            "connect" => {
                let device_string = command.get("address")
                    .and_then(|v| v.as_str())
                    .ok_or("No address for connect command")?
                    .to_string();
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .unwrap()
                        // .ok_or("Device not found in cache")?
                };
                return connect(&device_id).await;
            }
            "disconnect" => {
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                return disconnect(&device_id).await;
            }
            "services" => {
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let service_uuid = command.get("service").unwrap_or(&Value::Null);
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                return Ok(json!(services(&device_id, service_uuid).await?));
            }
            "characteristics" => {
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let service_uuid = command.get("service").ok_or_else(|| "Service required")?;
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                return Ok(characteristics(&device_id, service_uuid).await?);
            }
            "read" => {
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let service_uuid = command.get("service").ok_or_else(|| "Service required")?;
                let char_uuid = command.get("characteristic").ok_or_else(|| "Characteristic required")?;
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                return read(&device_id, service_uuid, char_uuid).await;
            }
            "write" | "writeWithoutResponse" => {
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let service_uuid = command.get("service").ok_or_else(|| "Service required")?;
                let char_uuid = command.get("characteristic").ok_or_else(|| "Characteristic required")?;
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                let write_val: Vec<u8> = command
                    .get("value")
                    .and_then(|v| v.as_array())
                    .ok_or("value not an array")?
                    .iter()
                    .map(|v| {
                        let n = v.as_u64().ok_or("values must be numbers")?;
                        u8::try_from(n).map_err(|_| "value items out of range 0-255")
                    })
                    .collect::<Result<_, _>>()?;
                return write_without_response(&device_id, service_uuid, char_uuid, &write_val).await;
            }
            "writeWithResponse" => {
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let service_uuid = command.get("service").ok_or_else(|| "Service required")?;
                let char_uuid = command.get("characteristic").ok_or_else(|| "Characteristic required")?;
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                let write_val: Vec<u8> = command
                    .get("value")
                    .and_then(|v| v.as_array())
                    .ok_or("value not an array")?
                    .iter()
                    .map(|v| {
                        let n = v.as_u64().ok_or("values must be numbers")?;
                        u8::try_from(n).map_err(|_| "value items out of range 0-255")
                    })
                    .collect::<Result<_, _>>()?;
                return write_with_response(&device_id, service_uuid, char_uuid, &write_val).await;
            }
            "subscribe" => {
                let mut active_subscriptions_locked = active_subscriptions.lock().await;
                let device_string = command.get("device")
                    .and_then(|v| v.as_str())
                    .ok_or("No device for disconnect command")?
                    .to_string();
                let service_uuid = command.get("service").ok_or_else(|| "Service required")?;
                let char_uuid = command.get("characteristic").ok_or_else(|| "Characteristic required")?;
                let device_id = {
                    let device_cache_ul = device_cache.lock().await;
                    device_cache_ul
                        .get(&device_string)
                        .map(|d| d.clone())
                        .ok_or("Device not found in cache")?
                };
                let subscription_name = command.get("subscriptionName")
                    .and_then(|v| v.as_str())
                    .ok_or("No subscriptionName for subscribe command")?
                    .to_string();
                let subscription_name_clone = subscription_name.clone();
                let service_uuid_clone = service_uuid.clone();
                let char_uuid_clone = char_uuid.clone();
                let handle = tokio::spawn(async move {
                    let _ = notify_characteristic(&device_id, &service_uuid_clone, &char_uuid_clone, &subscription_name_clone).await;
                });
                active_subscriptions_locked.insert(subscription_name.clone(), handle);
                return Ok(subscription_name.into());
            }
            "unsubscribe" => {
                let mut active_subscriptions_locked = active_subscriptions.lock().await; // PROBLEM
                let subscription_name = command.get("subscriptionName")
                    .and_then(|v| v.as_str())
                    .ok_or("No subscriptionName for subscribe command")?
                    .to_string();
                active_subscriptions_locked.remove(&subscription_name).ok_or_else(||"Active subscription not found")?.abort();
                return Ok(subscription_name.into());
            }
            "accept" => {

            }
            "acceptPasswordCredential" => {

            }
            "acceptPin" => {

            }
            "cancel" => {

            }
            "availability" => {
                return check_availability().await;
            }
            "getDescriptor" => {

            }
            "getDescriptors" => {

            }
            "readDescriptorValue" => {

            }
            "writeDescriptorValue" => {

            }
            _ => {
                
            }
        }
        Some(_) => {
            // doing nothing, handled externally
        }
        None => {
            // doing nothing, handled externally
        }
    }
    Err("Command not found".into())
}

async fn check_availability() -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await;
    match adapter {
        Ok(_) => {
            return Ok(Value::Bool(true));
        }
        Err(_) => {
            return Ok(Value::Bool(false));
        }
    }
}

async fn device_event(device: &Device) {
    // we are assuming at most one disconnection here, so the thread will terminate after that
    let adapter = Adapter::default().await.expect("Adapter required to scan");
    let mut dev_event_stream = adapter.device_connection_events(device).await.unwrap();
    while let Some(dev_event) = dev_event_stream.next().await {
        if let ConnectionEvent::Disconnected = dev_event {
            let msg = json!({"_type": "disconnectEvent", "device": device.id().to_string()});
            let _ = write_message(&msg);
            let _ = disconnect(&device).await;
            break;
        }
    }
    // TODO do disconnect cleanup also
}

async fn connect(dev: &Device) -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    if !(dev.is_connected().await) {
        let dev_clone = dev.clone();
        tokio::spawn(async move {
            device_event(&dev_clone).await;
        });
        adapter.connect_device(&dev).await?;
    }
    // On Windows you don't really connect until you do something with the device
    // this is a bit slow though
    // if cfg!(windows) {
    dev.discover_services_with_uuid(Uuid::from_u128(0x1799)).await?;
    // }
    Ok(Value::String(dev.id().to_string()))
}

async fn disconnect(dev: &Device) -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    if dev.is_connected().await {
        adapter.disconnect_device(&dev).await?;
    }
    // TODO terminate any notification streams
    Ok(Value::Null)
}

async fn services(dev: &Device, service: &Value) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    if service != &Value::Null {
        let service_uuid_str = service.as_str().ok_or_else(|| "Service string not available")?;
        let service_uuid = Uuid::parse_str(service_uuid_str)?;
        let res = dev.discover_services_with_uuid(service_uuid).await?
            .into_iter()
            // TODO check this on Linux
            .map(|v| v.uuid().to_string())
            .collect::<Vec<String>>();
        return Ok(res);
    } else {
        let res = dev.discover_services().await?
            .into_iter()
            .map(|v| v.uuid().to_string())
            .collect::<Vec<String>>();
        return Ok(res);
    }
}

async fn characteristics(dev: &Device, service: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    let service_uuid_str = service.as_str().ok_or_else(|| "Service string not available")?;
    let service_uuid = Uuid::parse_str(service_uuid_str)?;
    let services = dev.discover_services_with_uuid(service_uuid).await?;
    let res = services.get(0).ok_or_else(|| "Service not available")?;
    let reschr = res.discover_characteristics().await?;
    let mut charval = Vec::new();
    for f in reschr.iter() {
        let f_props = f.properties().await?;
        let f_uuid = f.uuid().to_string();
        charval.push(json!({"uuid": f_uuid, "properties": {
            "broadcast": f_props.broadcast,
            "read": f_props.read,
            "writeWithoutResponse": f_props.write_without_response,
            "write": f_props.write,
            "notify": f_props.notify,
            "indicate": f_props.indicate,
            "authenticatedSignedWrites": f_props.authenticated_signed_writes,
            "reliableWrite": f_props.reliable_write,
            "writableAuxiliaries": f_props.writable_auxiliaries
            // also available but not included: extended_properties
        }}));
    }
    Ok(Value::Array(charval))
}

async fn read(dev: &Device, service: &Value, characteristic: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    let service_uuid_str = service.as_str().ok_or_else(|| "Service string not available")?;
    let service_uuid = Uuid::parse_str(service_uuid_str)?;
    let services = dev.discover_services_with_uuid(service_uuid).await?;
    let res = services.get(0).ok_or_else(|| "Service not available")?;
    let reschr = res.discover_characteristics_with_uuid(Uuid::parse_str(characteristic.as_str().ok_or_else(|| "Characteristic not available")?)?).await?;
    Ok(json!(reschr.get(0).ok_or_else(|| "Characteristic not available")?.read().await?))
}

async fn write_without_response(dev: &Device, service: &Value, characteristic: &Value, write_val: &[u8]) -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    let service_uuid_str = service.as_str().ok_or_else(|| "Service string not available")?;
    let service_uuid = Uuid::parse_str(service_uuid_str)
        .map_err(|e| format!("Invalid service UUID '{}': {}", service_uuid_str, e))?;

    let services = dev.discover_services_with_uuid(service_uuid).await
        .map_err(|e| format!("discover_services_with_uuid failed: {}", e))?;
    let res = services.get(0).ok_or_else(|| "Service not available")?;

    let char_str = characteristic.as_str().ok_or_else(|| "Characteristic not available")?;
    let char_uuid = Uuid::parse_str(char_str)
        .map_err(|e| format!("Invalid characteristic UUID '{}': {}", char_str, e))?;

    let reschr = res.discover_characteristics_with_uuid(char_uuid).await
        .map_err(|e| format!("discover_characteristics_with_uuid failed: {}", e))?;

    Ok(json!(reschr.get(0).ok_or_else(|| "Characteristic not available")?.write_without_response(write_val).await?))
}

async fn write_with_response(dev: &Device, service: &Value, characteristic: &Value, write_val: &[u8]) -> Result<Value, Box<dyn std::error::Error>> {
    let adapter = Adapter::default().await?;
    adapter.wait_available().await?;
    let service_uuid_str = service.as_str().ok_or_else(|| "Service string not available")?;
    let service_uuid = Uuid::parse_str(service_uuid_str)
        .map_err(|e| format!("Invalid service UUID '{}': {}", service_uuid_str, e))?;

    let services = dev.discover_services_with_uuid(service_uuid).await
        .map_err(|e| format!("discover_services_with_uuid failed: {}", e))?;
    let res = services.get(0).ok_or_else(|| "Service not available")?;

    let char_str = characteristic.as_str().ok_or_else(|| "Characteristic not available")?;
    let char_uuid = Uuid::parse_str(char_str)
        .map_err(|e| format!("Invalid characteristic UUID '{}': {}", char_str, e))?;

    let reschr = res.discover_characteristics_with_uuid(char_uuid).await
        .map_err(|e| format!("discover_characteristics_with_uuid failed: {}", e))?;

    Ok(json!(reschr.get(0).ok_or_else(|| "Characteristic not available")?.write(write_val).await?))
}


#[tokio::main]
async fn main() {
    let instance = SingleInstance::new("BLEServer").unwrap();
    assert!(instance.is_single(), "Only one instance of WebBT Server is allowed at a time.");

    // tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    unsafe {
        std::env::set_var("RUST_BACKTRACE", "1");
    }

    let active_scans = Arc::new(Mutex::new(HashMap::new()));
    let device_cache = Arc::new(Mutex::new(HashMap::new()));
    let active_subscriptions = Arc::new(Mutex::new(HashMap::new()));

    let mut msg = Map::new();
    msg.insert("_type".into(), "Start".into());
    // API version is required and will be incremented when breaking changes are made to the API
    msg.insert("apiVersion".into(), API_VERSION.into());
    // the following two values are not currently validated but may be used in the future to determine whether to offer users an update to BLEServer
    // third-party server implementations should change these values for their servers
    msg.insert("serverName".into(), "rust-server".into());
    msg.insert("serverVersion".into(), "0.6.0".into());
    msg.insert("features".into(), ["ServerMultiScanningInstance"].into());

    let _ = write_message(&msg);

    loop {
        match read_message::<Value>() {
            Ok(message) => {
                let _ = tokio::spawn(process_command(message, active_scans.clone(), device_cache.clone(), active_subscriptions.clone())).await;
            }
            Err(e) => {
                match e {
                    // we need to exit immediately on an IO error which most likely signals that we're supposed to close
                    // the browser will close us in 2 seconds but that is too slow for page reloads
                    webextension_native_messaging::MessagingError::Io(_) => {
                        break;
                    }
                    _ => {
                        let error_msg = json!({
                            "_type": "error",
                            "error": e.to_string()
                        });
                        let _ = write_message(&error_msg);
                    }
                }
            }
        }
    } 
}
