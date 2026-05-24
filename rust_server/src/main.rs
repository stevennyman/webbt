// WebBT Server
// Copyright (C) 2026, Steven Nyman. License: MIT.

use anyhow::{Context, Result};
use btleplug::api::{
    Central, CentralEvent, CharPropFlags, Manager, Peripheral, ScanFilter, WriteType,
};
use btleplug::platform::Adapter;
use futures_lite::Stream;
use futures_lite::stream::StreamExt;
use serde_json::{Map, Value, json};
use single_instance::SingleInstance;
use std::collections::HashSet;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use tokio::time::sleep;
use uuid::Uuid;
use webextension_native_messaging::{read_message, write_message};

const API_VERSION: i32 = 2;

async fn write_peripheral_info(peripheral: &btleplug::platform::Peripheral) -> anyhow::Result<()> {
    let properties = peripheral
        .properties()
        .await?
        .context("No peripheral properties")?;
    let msg = json!({
        "_type": "scanResult",
        "bluetoothAddress": peripheral.id().to_string(),
        "rssi": properties.rssi.map(|r| json!(r)).unwrap_or(Value::Null),
        "localName": properties.local_name.unwrap_or_else(|| peripheral.id().to_string()),
        // no appearance
        "txPower": properties.tx_power_level.map(|p| json!(p)).unwrap_or(Value::Null),
        "serviceUuids": properties.services,
        "manufacturerData": properties.manufacturer_data
            .iter()
            .map(|(company_id, data)| json!({"companyIdentifier": company_id, "data": data}))
            .collect::<Vec<_>>(),
        "serviceData": properties.service_data
            .iter()
            .map(|(uuid, data)| json!({"service": uuid, "data": data}))
            .collect::<Vec<_>>(),
        "gattId": peripheral.id().to_string(),
        // not used: class (class of device), advertisement_name, address_type
    });
    let _ = write_message(&msg);
    Ok(())
}

async fn process_command(command: Value, central: &Adapter) {
    let mut response = Map::new();
    response.insert("_type".into(), "response".into());
    let cmd_id = command.get("_id").and_then(|v| v.as_i64()).unwrap_or(-1);
    response.insert("_id".into(), cmd_id.into());

    match execute_command(&command, &central).await {
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

async fn execute_command(
    command: &Value,
    central: &Adapter,
) -> Result<Value, Box<dyn std::error::Error>> {
    match command.get("cmd") {
        Some(Value::String(t)) => match t.as_str() {
            "ping" => {
                return Ok(Value::String("pong".into()));
            }
            "scan" => {
                // TODO possibly clear peripheral list if no active connections?
                // let service_list: Vec<Uuid> = command.get("serviceList")
                //     .and_then(|v| v.as_array())
                //     .map(|arr| {
                //         arr.iter()
                //             .filter_map(|v| v.as_str())
                //             .filter_map(|s| Uuid::parse_str(s).ok())
                //             .collect()
                //     })
                //     .unwrap_or_default();

                // we'll ignore the filter for now since the client filters itself
                // and we don't want to miss peripherals in future cached rounds
                // also multiple webpages can be using this scan
                // let scan_filter = ScanFilter { services: service_list };

                // iterate current peripherals
                // for p in central.peripherals().await.unwrap() {
                //     let _ = write_peripheral_info(&p).await;
                // }

                // central.start_scan(scan_filter).await?;
                central.start_scan(ScanFilter::default()).await?;
                return Ok(Value::Null);
            }
            "stopScan" => {
                central.stop_scan().await?;
                return Ok(Value::Null);
            }
            "connect" => {
                let device_id = command["address"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("No address for connect command"))?;
                for p in central.peripherals().await.unwrap() {
                    if p.id().to_string() == device_id {
                        if !p.is_connected().await? {
                            p.connect().await?;
                        }
                        return Ok(Value::String(p.id().to_string()));
                    }
                }
                return Err("Peripheral not found".into());
            }
            "disconnect" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                if p.is_connected().await? {
                    p.disconnect().await?;
                }
                // TODO terminate any notification streams?
                return Ok(Value::Null);
            }
            "services" => {
                let p = peripheral_from_command_device_string(command, central).await?;

                let service_uuid_opt = command
                    .get("service")
                    .and_then(|v| v.as_str())
                    .and_then(|v| Uuid::parse_str(v).ok());

                p.discover_services().await?;

                if let Some(service_uuid) = service_uuid_opt {
                    let res = p
                        .services()
                        .into_iter()
                        .map(|v| v.uuid)
                        .filter(|v| v == &service_uuid)
                        .collect::<Vec<Uuid>>();
                    if res.len() == 0 {
                        return Err("Service not found".into());
                    }
                    return Ok(json!(res));
                } else {
                    let res = p
                        .services()
                        .into_iter()
                        .map(|v| v.uuid)
                        .collect::<Vec<Uuid>>();
                    return Ok(json!(res));
                }
            }
            "characteristics" => {
                let service = service_from_command_string(command, central, None).await?;

                let res = service.characteristics
                    .iter()
                    .map(|v| json!(
                        {
                            "uuid": v.uuid,
                            "properties": {
                                "broadcast": v.properties.contains(CharPropFlags::BROADCAST),
                                "read": v.properties.contains(CharPropFlags::READ),
                                "writeWithoutResponse": v.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE),
                                "write": v.properties.contains(CharPropFlags::WRITE),
                                "notify": v.properties.contains(CharPropFlags::NOTIFY),
                                "indicate": v.properties.contains(CharPropFlags::INDICATE),
                                "authenticatedSignedWrites": v.properties.contains(CharPropFlags::AUTHENTICATED_SIGNED_WRITES),
                                "reliableWrite": false, // TODO requires EXTENDED
                                "writableAuxiliaries": false, // TODO requires EXTENDED
                            }
                        }
                    ))
                    .collect::<Vec<_>>();
                return Ok(json!(res));
            }
            "read" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let characteristic =
                    characteristic_from_command_string(command, central, Some(&p)).await?;
                let res = p.read(&characteristic).await?;
                return Ok(json!(res));
            }
            "write" | "writeWithoutResponse" | "writeWithResponse" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let characteristic =
                    characteristic_from_command_string(command, central, Some(&p)).await?;
                let write_val = command["value"]
                    .as_array()
                    .ok_or("Value must be an array")?
                    .iter()
                    .map(|v| {
                        let n = v.as_u64().ok_or("Values must be numbers")?;
                        u8::try_from(n).map_err(|_| "Value items must be in range 0-255")
                    })
                    .collect::<Result<Vec<u8>, _>>()?;
                let mut write_type = WriteType::WithoutResponse;
                if command["cmd"] == "writeWithResponse" {
                    write_type = WriteType::WithResponse;
                }
                let res = p.write(&characteristic, &write_val, write_type).await?;
                return Ok(json!(res));
            }
            "subscribe" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let characteristic =
                    characteristic_from_command_string(command, central, Some(&p)).await?;
                start_notification_thread(p.clone());
                p.subscribe(&characteristic).await?;
                return Ok(json!(subscription_id_from_characteristic(
                    characteristic,
                    &p
                )));
            }
            "unsubscribe" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let characteristic =
                    characteristic_from_command_string(command, central, Some(&p)).await?;
                p.unsubscribe(&characteristic).await?;
                return Ok(json!(subscription_id_from_characteristic(
                    characteristic,
                    &p
                )));
            }
            // the distinction that we lost here is that in the cpp codebase getDescriptor was cached, readDescriptorValue was uncached
            // btleplug appears not to support setting cached vs uncached descriptor reads
            "getDescriptor" | "readDescriptorValue" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let d = descriptor_from_command_string(command, central, &p).await?;
                let val = p.read_descriptor(&d).await?;
                return Ok(json!({"uuid": d.uuid, "value": val}));
            }
            "getDescriptors" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let characteristic =
                    characteristic_from_command_string(command, central, Some(&p)).await?;
                let mut res = Vec::new();
                let mut descriptor_uuid: Option<Uuid> = None;
                if let Some(descriptor) = command.get("descriptor") {
                    descriptor_uuid = Some(
                        descriptor
                            .as_str()
                            .and_then(|v| Uuid::parse_str(v).ok())
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "Missing descriptor uuid for descriptor-requiring command"
                                )
                            })?,
                    );
                }
                for d in characteristic.descriptors {
                    let val = p.read_descriptor(&d).await?;
                    if descriptor_uuid.map_or(true, |uuid| uuid == d.uuid) {
                        res.push(json!({"uuid": d.uuid, "value": val}));
                    }
                }
                return Ok(json!({"list": res}));
            }
            "writeDescriptorValue" => {
                let p = peripheral_from_command_device_string(command, central).await?;
                let d = descriptor_from_command_string(command, central, &p).await?;
                let write_val = command["value"]
                    .as_array()
                    .ok_or("Value must be an array")?
                    .iter()
                    .map(|v| {
                        let n = v.as_u64().ok_or("Values must be numbers")?;
                        u8::try_from(n).map_err(|_| "Value items must be in range 0-255")
                    })
                    .collect::<Result<Vec<u8>, _>>()?;
                let val = p.write_descriptor(&d, &write_val).await?;
                return Ok(json!({"uuid": d.uuid, "value": val}));
            }
            // omitted pairing related functions since btleplug doesn't handle pairing
            _ => {}
        },
        Some(_) => {
            // doing nothing, handled externally
        }
        None => {
            // doing nothing, handled externally
        }
    }

    Err("Command not found".into())
}

fn subscription_id_from_characteristic_uuids(
    characteristic_uuid: Uuid,
    service_uuid: Uuid,
    peripheral: &btleplug::platform::Peripheral,
) -> String {
    format!(
        "subscription_{}_{}_{}",
        peripheral.id(),
        service_uuid,
        characteristic_uuid
    )
}

fn subscription_id_from_characteristic(
    characteristic: btleplug::api::Characteristic,
    peripheral: &btleplug::platform::Peripheral,
) -> String {
    subscription_id_from_characteristic_uuids(
        characteristic.uuid,
        characteristic.service_uuid,
        peripheral,
    )
}

fn notification_threads() -> &'static Mutex<HashSet<String>> {
    static NOTIFICATION_THREADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    NOTIFICATION_THREADS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn start_notification_thread(peripheral: btleplug::platform::Peripheral) {
    let peripheral_id = peripheral.id().to_string();
    {
        let mut active_threads = notification_threads().lock().unwrap();
        if !active_threads.insert(peripheral_id.clone()) {
            return;
        }
    }

    tokio::spawn(async move {
        let mut retry_count = 0;
        loop {
            notification_thread(peripheral.clone()).await;
            retry_count += 1;
            if retry_count >= 3 {
                break;
            }
            sleep(std::time::Duration::from_millis(100)).await;
        }
        let mut active_threads = notification_threads().lock().unwrap();
        active_threads.remove(&peripheral_id);
    });
}

async fn peripheral_from_command_device_string(
    command: &Value,
    central: &Adapter,
) -> Result<btleplug::platform::Peripheral> {
    let device_id = command["device"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("No address for connect command"))?;
    for p in central.peripherals().await.unwrap() {
        if p.id().to_string() == device_id {
            return Ok(p);
        }
    }
    Err(anyhow::anyhow!("Peripheral not found"))
}

async fn service_from_command_string(
    command: &Value,
    central: &Adapter,
    peripheral: Option<&btleplug::platform::Peripheral>,
) -> Result<btleplug::api::Service> {
    let p_owned = match peripheral {
        Some(p) => p.clone(),
        None => peripheral_from_command_device_string(command, central).await?,
    };
    let service_uuid = command["service"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| anyhow::anyhow!("Missing service uuid for service-requiring command"))?;
    p_owned.discover_services().await?;
    let services = p_owned.services();
    let service = services
        .into_iter()
        .find(|s| s.uuid == service_uuid)
        .ok_or_else(|| anyhow::anyhow!("Unable to find service with this uuid"))?;
    Ok(service)
}

async fn characteristic_from_command_string(
    command: &Value,
    central: &Adapter,
    peripheral: Option<&btleplug::platform::Peripheral>,
) -> Result<btleplug::api::Characteristic> {
    let service = service_from_command_string(command, central, peripheral).await?;
    let characteristic_uuid = command["characteristic"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| {
            anyhow::anyhow!("Missing service uuid for characteristic-requiring command")
        })?;
    let characteristic = service
        .characteristics
        .into_iter()
        .find(|v| v.uuid == characteristic_uuid)
        .ok_or_else(|| anyhow::anyhow!("Unable to find characteristic with this uuid"))?;
    Ok(characteristic)
}

async fn descriptor_from_command_string(
    command: &Value,
    central: &Adapter,
    peripheral: &btleplug::platform::Peripheral,
) -> Result<btleplug::api::Descriptor> {
    let characteristic =
        characteristic_from_command_string(command, central, Some(&peripheral)).await?;
    let descriptor_uuid = command["descriptor"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| {
            anyhow::anyhow!("Missing descriptor uuid for descriptor-requiring command")
        })?;
    let descriptor = characteristic
        .descriptors
        .into_iter()
        .find(|v| v.uuid == descriptor_uuid)
        .ok_or_else(|| anyhow::anyhow!("Unable to find descriptor with this uuid"))?;
    Ok(descriptor)
}

async fn notification_thread(peripheral: btleplug::platform::Peripheral) {
    let mut notifications = peripheral.notifications().await.unwrap();

    while let Some(event) = notifications.next().await {
        let res = json!({
            "_type": "valueChangedNotification",
            "subscriptionId": subscription_id_from_characteristic_uuids(
                event.uuid,
                event.service_uuid,
                &peripheral
            ),
            "value": event.value
        });

        let _ = write_message(&res);
    }
}

async fn event_thread(
    mut events: Pin<Box<dyn Stream<Item = CentralEvent> + Send>>,
    central: Adapter,
) -> anyhow::Result<()> {
    while let Some(event) = events.next().await {
        match event {
            CentralEvent::DeviceDiscovered(id)
            | CentralEvent::DeviceUpdated(id)
            | CentralEvent::DeviceServicesModified(id)
            | CentralEvent::ManufacturerDataAdvertisement { id, .. }
            | CentralEvent::ServiceDataAdvertisement { id, .. }
            | CentralEvent::ServicesAdvertisement { id, .. }
            | CentralEvent::RssiUpdate { id, .. } => {
                let Ok(peripheral) = central.peripheral(&id).await else {
                    continue;
                };
                let _ = write_peripheral_info(&peripheral).await;
            }
            // TODO do we need to register/track this at other locations, such as for devices connected before startup?
            CentralEvent::DeviceConnected(id) => {
                for p in central.peripherals().await.unwrap() {
                    if p.id() == id {
                        start_notification_thread(p);
                    }
                }
            }
            // no need to drop the device notification stream, it is supported across connections
            CentralEvent::DeviceDisconnected(id) => {
                let _ =
                    write_message(&json!({"_type": "disconnectEvent", "device": id.to_string()}));
            }
            // nothing to do here really
            CentralEvent::StateUpdate(_state) => {}
        }
    }
    Ok(())
}

// event thread for CentralEvents
async fn get_central(manager: &btleplug::platform::Manager) -> Option<Adapter> {
    let adapters = manager.adapters().await.ok()?;
    adapters.into_iter().next()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let instance = SingleInstance::new("BLEServer").unwrap();
    assert!(
        instance.is_single(),
        "Only one instance of WebBT Server is allowed at a time."
    );

    // tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let manager = btleplug::platform::Manager::new().await?;
    // currently this just uses the first adapter, a possible future expansion would be to allow selecting an adapter in the UI
    // the Web Bluetooth spec doesn't seem to handle multiple adapters, and btleplug only supports multiple adapters on Linux
    let central = get_central(&manager).await;

    // only start the events thread if we have an adapter
    // just one thread for device/advertisement events
    if let Some(ref c) = central {
        let events = c.events().await?;
        let central_clone = c.clone();
        tokio::spawn(async move {
            let _ = event_thread(events, central_clone).await;
        });
    }

    let msg = json!({"_type": "Start", "apiVersion": API_VERSION, "serverName": "rust-server", "serverVersion": "0.6.0"});

    let _ = write_message(&msg);

    loop {
        match read_message::<Value>() {
            Ok(message) => {
                // respond to availability without requiring an Adapter
                if message.get("cmd").and_then(|v| v.as_str()) == Some("availability") {
                    let avail = central.is_some();
                    let mut response = Map::new();
                    response.insert("_type".into(), "response".into());
                    let cmd_id = message.get("_id").and_then(|v| v.as_i64()).unwrap_or(-1);
                    response.insert("_id".into(), cmd_id.into());
                    response.insert("result".into(), json!(avail));
                    let _ = write_message(&response);
                    continue;
                }

                // for other commands, require an adapter
                if let Some(ref c) = central {
                    let central_for_task = c.clone();
                    tokio::spawn(async move {
                        process_command(message, &central_for_task).await;
                    });
                } else {
                    let mut response = Map::new();
                    response.insert("_type".into(), "response".into());
                    let cmd_id = message.get("_id").and_then(|v| v.as_i64()).unwrap_or(-1);
                    response.insert("_id".into(), cmd_id.into());
                    response.insert("result".into(), Value::Null);
                    response.insert(
                        "error".into(),
                        Value::String("No Bluetooth adapter available".into()),
                    );
                    let _ = write_message(&response);
                }
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

    Ok(())
}
