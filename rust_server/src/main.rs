// WebBT Server
// Copyright (C) 2026, Steven Nyman. License: MIT.

use anyhow::{Context, Result};
use btleplug::api::{
    Central, CentralEvent, CentralState, CharPropFlags, Manager, PairingEvent, PairingRequestKind,
    PairingResponse, Peripheral, ScanFilter, WriteType,
};
use btleplug::platform::Adapter;
use futures_lite::Stream;
use futures_lite::stream::StreamExt;
use serde_json::{Map, Value, json};
use single_instance::SingleInstance;
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{Semaphore, mpsc};
use uuid::Uuid;
use webextension_native_messaging::{read_message, write_message};

const API_VERSION: i32 = 2;

fn device_semaphores() -> &'static Mutex<HashMap<String, Arc<Semaphore>>> {
    static SEMAPHORES: OnceLock<Mutex<HashMap<String, Arc<Semaphore>>>> = OnceLock::new();
    SEMAPHORES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_device_semaphore(device_id: &str) -> Arc<Semaphore> {
    let mut sems = device_semaphores().lock().unwrap();
    sems.entry(device_id.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(1)))
        .clone()
}

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
        "appearance": properties.appearance.unwrap_or(0),
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

    let device_id = command
        .get("device")
        .or_else(|| command.get("address"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let cmd_str = command.get("cmd").and_then(|v| v.as_str());
    let is_pairing_response = cmd_str == Some("accept") || cmd_str == Some("cancel");

    let result = if let Some(ref id) = device_id {
        if !is_pairing_response {
            let semaphore = get_device_semaphore(id);
            let _permit = semaphore.acquire().await.unwrap();
            execute_command(&command, central).await
        } else {
            execute_command(&command, central).await
        }
    } else {
        execute_command(&command, central).await
    };

    match result {
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
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
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
                for p in central.peripherals().await? {
                    if p.id().to_string() == device_id {
                        start_pairing_notification_thread(p.clone());
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
                    if res.is_empty() {
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
                                "reliableWrite": v.properties.contains(CharPropFlags::RELIABLE_WRITE),
                                "writableAuxiliaries": v.properties.contains(CharPropFlags::WRITABLE_AUXILIARIES),
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
                p.write(&characteristic, &write_val, write_type).await?;
                return Ok(Value::Null);
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
                    if descriptor_uuid.is_none_or(|uuid| uuid == d.uuid) {
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
                p.write_descriptor(&d, &write_val).await?;
                return Ok(json!({"uuid": d.uuid, "value": Value::Null}));
            }
            "accept" | "acceptPin" => {
                let pair_id = command["origId"].clone();
                // accept/cancel are looked up by pairing id, not device address: the
                // extension's accept/cancel messages never include a `device` field, since
                // from its perspective a pairing request is identified solely by its pairing id.
                let p = peripheral_from_pairing_id(&pair_id, central).await?;
                let pair_response = match command["pin"].as_str() {
                    Some(pin) => PairingResponse::Pin(pin.to_string()),
                    None => PairingResponse::Accept,
                };
                p.respond_to_pairing_request(serde_json::from_value(pair_id)?, pair_response)
                    .await?;
                // Do not close the pairing dialog here: respond_to_pairing_request succeeding
                // only means this step of the ceremony was acknowledged, not that pairing is
                // done. The authoritative close signal is PairingEvent::Outcome, reported by
                // pairing_notification_thread once PairAsync itself resolves -- the ceremony can
                // still fail or time out after this point (multi-step ceremonies, or the OS
                // abandoning the deferral at roughly the same time as this response).
                return Ok(Value::Null);
            }
            "cancel" => {
                let pair_id = command["origId"].clone();
                let p = peripheral_from_pairing_id(&pair_id, central).await?;
                p.respond_to_pairing_request(
                    serde_json::from_value(pair_id)?,
                    PairingResponse::Reject,
                )
                .await?;
                // See the comment in "accept" above: closing happens via PairingEvent::Outcome,
                // not here.
                return Ok(Value::Null);
            }
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

fn pairing_notification_threads() -> &'static Mutex<HashSet<String>> {
    static PAIRING_NOTIFICATION_THREADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PAIRING_NOTIFICATION_THREADS.get_or_init(|| Mutex::new(HashSet::new()))
}

// Tracks which peripheral owns each in-flight pairing request, keyed by the
// pairing request's own id (the value also sent to the extension as
// `pairingId`/`origId`). This lets "accept"/"cancel" find the right
// peripheral without needing a `device` field -- the extension's accept/cancel
// messages never include one, since from the extension's perspective a
// pairing request is identified solely by its pairing id.
fn pairing_peripherals() -> &'static Mutex<HashMap<String, btleplug::platform::Peripheral>> {
    static PAIRING_PERIPHERALS: OnceLock<Mutex<HashMap<String, btleplug::platform::Peripheral>>> =
        OnceLock::new();
    PAIRING_PERIPHERALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn write_disconnect_event(device_id: &str) {
    let _ = write_message(&json!({
        "_type": "disconnectEvent",
        "device": device_id,
    }));
}

fn mark_device_connected(connected_devices: &Mutex<HashSet<String>>, device_id: &str) {
    connected_devices
        .lock()
        .unwrap()
        .insert(device_id.to_string());
}

fn remember_device(known_devices: &Mutex<HashSet<String>>, device_id: &str) {
    known_devices.lock().unwrap().insert(device_id.to_string());
}

fn mark_device_disconnected(connected_devices: &Mutex<HashSet<String>>, device_id: &str) -> bool {
    connected_devices.lock().unwrap().remove(device_id)
}

fn handle_device_disconnected(connected_devices: &Mutex<HashSet<String>>, device_id: &str) {
    if mark_device_disconnected(connected_devices, device_id) {
        write_disconnect_event(device_id);
    }

    // Allow a fresh notification thread to be started on reconnect.
    notification_threads().lock().unwrap().remove(device_id);
    close_pairings_for_peripheral(device_id);
}

async fn poll_connected_devices(
    central: &Adapter,
    connected_devices: &Mutex<HashSet<String>>,
    known_devices: &Mutex<HashSet<String>>,
) {
    let Ok(peripherals) = central.peripherals().await else {
        return;
    };

    let known_devices = known_devices.lock().unwrap().clone();
    for peripheral in peripherals {
        let device_id = peripheral.id().to_string();
        if !known_devices.contains(&device_id) {
            continue;
        }

        match peripheral.is_connected().await {
            Ok(true) => mark_device_connected(connected_devices, &device_id),
            Ok(false) => handle_device_disconnected(connected_devices, &device_id),
            Err(_) => {}
        }
    }
}

// pair_id is the raw `origId` JSON value sent back by the extension; it round-trips
// the same value originally sent out as `pairingId`, so we key the lookup table
// with its string form to avoid relying on a specific JSON number/string representation.
async fn peripheral_from_pairing_id(
    pair_id: &Value,
    _central: &Adapter,
) -> Result<btleplug::platform::Peripheral> {
    let key = pair_id.to_string();
    let cached = pairing_peripherals().lock().unwrap().get(&key).cloned();
    cached.ok_or_else(|| anyhow::anyhow!("No peripheral found for pairing request"))
}

// Removes a pending pairing request from tracking and tells the extension to
// stop showing/waiting on its dialog, if it's currently displaying one. Used
// once a pairing request is resolved (PairingEvent::Outcome) or becomes moot
// (the peripheral disconnected). No-ops harmlessly if the key isn't tracked
// (e.g. close_pairing was already called for this id).
fn close_pairing(key: &str) {
    let removed = pairing_peripherals().lock().unwrap().remove(key).is_some();
    if !removed {
        return;
    }
    // `_id` matches what content.js's pairing_hideDialog handler reads;
    // it carries the same value originally sent out as `pairingId`.
    let msg = json!({
        "_type": "pairing_hideDialog",
        "pairingId": serde_json::from_str::<Value>(key).unwrap_or(Value::Null),
    });
    let _ = write_message(&msg);
}

// Closes every pending pairing request that belongs to the given peripheral.
// A peripheral disconnecting mid-pairing means whatever dialog the extension
// is showing (or queuing) for it is no longer answerable.
fn close_pairings_for_peripheral(peripheral_id: &str) {
    let keys: Vec<String> = {
        let map = pairing_peripherals().lock().unwrap();
        map.iter()
            .filter(|(_, p)| p.id().to_string() == peripheral_id)
            .map(|(k, _)| k.clone())
            .collect()
    };
    for key in keys {
        close_pairing(&key);
    }
}

struct ThreadGuard {
    peripheral_id: String,
    active_threads: &'static Mutex<HashSet<String>>,
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        if let Ok(mut active_threads) = self.active_threads.lock() {
            active_threads.remove(&self.peripheral_id);
        }
    }
}

// only has a purpose on Windows
fn start_pairing_notification_thread(peripheral: btleplug::platform::Peripheral) {
    let peripheral_id = peripheral.id().to_string();
    {
        let mut active_threads = pairing_notification_threads().lock().unwrap();
        if !active_threads.insert(peripheral_id.clone()) {
            return;
        }
    }

    tokio::spawn(async move {
        let _guard = ThreadGuard {
            peripheral_id: peripheral_id.clone(),
            active_threads: pairing_notification_threads(),
        };
        if let Err(e) = pairing_notification_thread(peripheral).await {
            eprintln!(
                "Pairing notification thread error for {}: {:?}",
                peripheral_id, e
            );
        }
    });
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
        let _guard = ThreadGuard {
            peripheral_id: peripheral_id.clone(),
            active_threads: notification_threads(),
        };
        if let Err(e) = notification_thread(peripheral).await {
            eprintln!("Notification thread error for {}: {:?}", peripheral_id, e);
        }
    });
}

async fn peripheral_from_command_device_string(
    command: &Value,
    central: &Adapter,
) -> Result<btleplug::platform::Peripheral> {
    let device_id = command["device"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("No address for connect command"))?;
    for p in central.peripherals().await? {
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
        characteristic_from_command_string(command, central, Some(peripheral)).await?;
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

async fn notification_thread(peripheral: btleplug::platform::Peripheral) -> Result<()> {
    let mut notifications = peripheral.notifications().await?;

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
    Ok(())
}

async fn pairing_notification_thread(peripheral: btleplug::platform::Peripheral) -> Result<()> {
    let mut pairing_notifications = peripheral.pairing_requests().await?;

    while let Some(event) = pairing_notifications.next().await {
        match event {
            PairingEvent::Request(request) => {
                let (pairing_kind, pin) = match request.kind {
                    PairingRequestKind::ConfirmOnly => ("pairing_confirmOnly", None),
                    PairingRequestKind::ProvidePin => ("pairing_providePin", None),
                    PairingRequestKind::ConfirmPinMatch(pin_arg) => {
                        ("pairing_confirmPinMatch", Some(pin_arg))
                    }
                    PairingRequestKind::DisplayPin(pin_arg) => {
                        ("pairing_displayPin", Some(pin_arg))
                    }
                };

                let pairing_id_value = serde_json::to_value(request.id)?;
                // Remember which peripheral this pairing request belongs to so that a
                // later "accept"/"cancel" (which carries only the pairing id, not a
                // device address) can find the right peripheral to respond on.
                pairing_peripherals()
                    .lock()
                    .unwrap()
                    .insert(pairing_id_value.to_string(), peripheral.clone());

                // Add timeout/handle multiple concurrent pair requests
                let res = json!({
                    "pairingType": true,
                    "pairingId": pairing_id_value,  // command ID might be different here than in C++
                    "_type": pairing_kind,
                    "pin": pin, // null in some cases unlike C++ but should be fine
                });

                let _ = write_message(&res);
            }
            // The ceremony has concluded one way or another (paired, rejected, canceled,
            // or timed out). This is the authoritative close signal for the dialog the
            // extension is showing/queuing.
            PairingEvent::Outcome { id, status } => {
                let key = serde_json::to_value(id)?.to_string();
                eprintln!("Pairing outcome for {}: {:?}", key, status);
                close_pairing(&key);
            }
        }
    }
    Ok(())
}

async fn event_thread(
    mut events: Pin<Box<dyn Stream<Item = CentralEvent> + Send>>,
    central: Adapter,
    connected_devices: Arc<Mutex<HashSet<String>>>,
    known_devices: Arc<Mutex<HashSet<String>>>,
) -> anyhow::Result<()> {
    let mut poll_timer = tokio::time::interval(std::time::Duration::from_secs(30));

    loop {
        tokio::select! {
            event = events.next() => {
                let Some(event) = event else {
                    return Ok(());
                };

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
                    CentralEvent::DeviceConnected(id) => {
                        let device_id = id.to_string();
                        remember_device(&known_devices, &device_id);
                        mark_device_connected(&connected_devices, &device_id);
                    }
                    CentralEvent::DeviceDisconnected(id) => {
                        handle_device_disconnected(&connected_devices, &id.to_string());
                    }
                    // nothing to do here really
                    CentralEvent::StateUpdate(_state) => {}
                }
            }
            _ = poll_timer.tick() => {
                poll_connected_devices(&central, &connected_devices, &known_devices).await;
            }
        }
    }
}

// event thread for CentralEvents
async fn get_central(manager: &btleplug::platform::Manager) -> Option<Adapter> {
    let adapters = manager.adapters().await.ok()?;
    adapters.into_iter().next()
}

// Native-messaging reads are synchronous. Keep them off Tokio's worker threads;
// otherwise a blocked stdin read can starve the BlueZ event task (especially on
// single-core Linux systems).
fn start_message_reader()
-> mpsc::UnboundedReceiver<Result<Value, webextension_native_messaging::MessagingError>> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        loop {
            match read_message::<Value>() {
                Ok(message) => {
                    if sender.send(Ok(message)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });
    receiver
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
    let central = Arc::new(Mutex::new(get_central(&manager).await));

    // Keep looking for an adapter if none was present at startup. This also
    // recreates the event stream after a BlueZ/D-Bus restart.
    let central_for_events = central.clone();
    tokio::spawn(async move {
        let connected_devices = Arc::new(Mutex::new(HashSet::new()));
        let known_devices = Arc::new(Mutex::new(HashSet::new()));

        loop {
            let current_adapter = { central_for_events.lock().unwrap().clone() };
            let adapter = match current_adapter {
                Some(adapter) => adapter,
                None => match get_central(&manager).await {
                    Some(adapter) => {
                        *central_for_events.lock().unwrap() = Some(adapter.clone());
                        adapter
                    }
                    None => {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                },
            };

            match adapter.events().await {
                Ok(events) => {
                    if let Err(error) = event_thread(
                        events,
                        adapter.clone(),
                        connected_devices.clone(),
                        known_devices.clone(),
                    )
                    .await
                    {
                        eprintln!("Bluetooth event thread error: {:?}", error);
                    }
                }
                Err(error) => {
                    eprintln!("Unable to subscribe to Bluetooth events: {:?}", error);
                }
            }

            *central_for_events.lock().unwrap() = None;
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });

    let msg = json!({"_type": "Start", "apiVersion": API_VERSION, "serverName": "rust-server", "serverVersion": env!("CARGO_PKG_VERSION")});

    let _ = write_message(&msg);

    let mut messages = start_message_reader();
    while let Some(message_result) = messages.recv().await {
        match message_result {
            Ok(message) => {
                // respond to availability without requiring an Adapter
                if message.get("cmd").and_then(|v| v.as_str()) == Some("availability") {
                    let avail = central.lock().unwrap().is_some();
                    let mut response = Map::new();
                    response.insert("_type".into(), "response".into());
                    let cmd_id = message.get("_id").and_then(|v| v.as_i64()).unwrap_or(-1);
                    response.insert("_id".into(), cmd_id.into());
                    response.insert("result".into(), json!(avail));
                    let _ = write_message(&response);
                    continue;
                }

                // for other commands, require an adapter
                let current_adapter = { central.lock().unwrap().clone() };
                if let Some(c) = current_adapter {
                    if matches!(c.adapter_state().await, Ok(state) if state != CentralState::PoweredOff)
                    {
                        tokio::spawn(async move {
                            process_command(message, &c).await;
                        });
                    } else {
                        let mut response = Map::new();
                        response.insert("_type".into(), "response".into());
                        let cmd_id = message.get("_id").and_then(|v| v.as_i64()).unwrap_or(-1);
                        response.insert("_id".into(), cmd_id.into());
                        response.insert("result".into(), Value::Null);
                        response.insert(
                            "error".into(),
                            Value::String("No Bluetooth adapter available or Bluetooth is turned off in your system settings.".into()),
                        );
                        let _ = write_message(&response);
                    }
                } else {
                    let mut response = Map::new();
                    response.insert("_type".into(), "response".into());
                    let cmd_id = message.get("_id").and_then(|v| v.as_i64()).unwrap_or(-1);
                    response.insert("_id".into(), cmd_id.into());
                    response.insert("result".into(), Value::Null);
                    response.insert(
                        "error".into(),
                        Value::String("No Bluetooth adapter available or Bluetooth is turned off in your system settings.".into()),
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
