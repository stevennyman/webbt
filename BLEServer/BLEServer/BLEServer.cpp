// BLEServer.cpp : Firefox Windows 10 Web Bluetooth Polyfill Server
//
// Copyright (C) 2023, Steven Nyman. License: MIT.
// Original Copyright (C) 2017, Uri Shaked. License: MIT.

#include "stdafx.h"
#include <iostream>
#include <Windows.Foundation.h>
#include <Windows.Devices.Bluetooth.h>
#include <Windows.Devices.Enumeration.h>
#include <Windows.Devices.Bluetooth.Advertisement.h>
#include <Windows.Security.Credentials.h>
#include <Windows.Data.JSON.h>
#include <wrl/wrappers/corewrappers.h>
#include <wrl/event.h>
#include <collection.h>
#include <ppltasks.h>
#include <string>
#include <sstream> 
#include <iomanip>
#include <experimental/resumable>
#include <pplawait.h>
#include <codecvt>
#include <stdio.h>  
#include <fcntl.h>  
#include <io.h>

using namespace Platform;
using namespace Windows::Devices;
using namespace Windows::Data::Json;
using namespace Windows::Devices::Bluetooth;
using namespace Windows::Security::Credentials;

Bluetooth::Advertisement::BluetoothLEAdvertisementWatcher^ bleAdvertisementWatcher;
auto devices = ref new Collections::Map<String^, Bluetooth::BluetoothLEDevice^>();
auto characteristicsMap = ref new Collections::Map<String^, Bluetooth::GenericAttributeProfile::GattCharacteristic^>();
auto characteristicsListenerMap = ref new Collections::Map<String^, Windows::Foundation::EventRegistrationToken>();
auto characteristicsSubscriptionMap = ref new Collections::Map<String^, JsonValue^>();

auto pairingRequestWaiting = ref new Collections::Map<double, String^>();
auto pairingRequestUsername = ref new Collections::Map<double, String^>();
auto pairingRequestPasswordPIN = ref new Collections::Map<double, String^>();

auto bluetoothAddressGattIdMap = ref new Collections::Map<unsigned long long, String^>();
std::unordered_map<unsigned long long, concurrency::task_completion_event<String^>> bleInProgressLookups;

auto API_VERSION = 1; // increment this when there are breaking changes to the message format

std::wstring formatBluetoothAddress(unsigned long long BluetoothAddress) {
	std::wostringstream ret;
	ret << std::hex << std::setfill(L'0')
		<< std::setw(2) << ((BluetoothAddress >> (5 * 8)) & 0xff) << ":"
		<< std::setw(2) << ((BluetoothAddress >> (4 * 8)) & 0xff) << ":"
		<< std::setw(2) << ((BluetoothAddress >> (3 * 8)) & 0xff) << ":"
		<< std::setw(2) << ((BluetoothAddress >> (2 * 8)) & 0xff) << ":"
		<< std::setw(2) << ((BluetoothAddress >> (1 * 8)) & 0xff) << ":"
		<< std::setw(2) << ((BluetoothAddress >> (0 * 8)) & 0xff);
	return ret.str();
}

Guid parseUuid(String^ uuid) {
	if (uuid->Length() == 4) {
		unsigned int uuidShort = std::stoul(uuid->Data(), 0, 16);
		return Bluetooth::BluetoothUuidHelper::FromShortId(uuidShort);
	}
	GUID rawguid;
	if (SUCCEEDED(IIDFromString(uuid->Data(), &rawguid))) {
		return Guid(rawguid);
	}
	else {
		std::wstring msg = L"Invalid UUID: ";
		msg += uuid->Data();
		throw ref new InvalidArgumentException(ref new String(msg.c_str()));
	}
}

CRITICAL_SECTION OutputCriticalSection;
CRITICAL_SECTION BLELookupCriticalSection;

void writeObject(JsonObject^ jsonObject) {
	String^ jsonString = jsonObject->Stringify();

	std::wstring_convert<std::codecvt_utf8<wchar_t>> convert;
	std::string stringUtf8 = convert.to_bytes(jsonString->Data());

	auto len = stringUtf8.length();

	EnterCriticalSection(&OutputCriticalSection);
	std::cout << char(len >> 0)
		<< char(len >> 8)
		<< char(len >> 16)
		<< char(len >> 24);

	std::cout << stringUtf8 << std::flush;
	LeaveCriticalSection(&OutputCriticalSection);
}

concurrency::task<IJsonValue^> disconnectRequest(JsonObject^ command);

concurrency::task<IJsonValue^> connectRequest(JsonObject^ command) {
	String^ addressStr = command->GetNamedString("address", "");
	unsigned long long address = std::stoull(addressStr->Data(), 0, 16);
	auto device = co_await Bluetooth::BluetoothLEDevice::FromBluetoothAddressAsync(address);
	if (device == nullptr) {
		throw ref new FailureException(ref new String(L"Device not found (null)"));
	}

	devices->Insert(device->DeviceId, device);
	device->ConnectionStatusChanged += ref new Windows::Foundation::TypedEventHandler<Bluetooth::BluetoothLEDevice^, Platform::Object^>(
		[](Windows::Devices::Bluetooth::BluetoothLEDevice^ device, Platform::Object^ eventArgs) {
			if (device->ConnectionStatus == Bluetooth::BluetoothConnectionStatus::Disconnected) {
				JsonObject^ msg = ref new JsonObject();
				msg->Insert("_type", JsonValue::CreateStringValue("disconnectEvent"));
				msg->Insert("device", JsonValue::CreateStringValue(device->DeviceId));
				writeObject(msg);
				// clean up any subscriptions, etc.
				auto disconnectArgs = ref new JsonObject();
				disconnectArgs->Insert("device", JsonValue::CreateStringValue(device->DeviceId));
				auto disconnectOp{ disconnectRequest(disconnectArgs) };
				disconnectOp.wait();
			}
		});
	// Force a connection upon device selection
	// https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothledevice.frombluetoothaddressasync?view=winrt-19041#windows-devices-bluetooth-bluetoothledevice-frombluetoothaddressasync(system-uint64)
	int maxattempt = 3;
	for (int attemptcnt = 0; attemptcnt < maxattempt; attemptcnt++) {
		auto services = co_await device->GetGattServicesAsync(Bluetooth::BluetoothCacheMode::Uncached);
		if (services->Status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success) {
			// todo: more specific error message
			// https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.genericattributeprofile.gattcommunicationstatus?view=winrt-19041
			if (attemptcnt == maxattempt - 1) {
				throw ref new FailureException(services->Status.ToString());
			}
			co_await concurrency::create_task([] { Sleep(3000); });
		}
		else {
			break;
		}
	}

	EnterCriticalSection(&BLELookupCriticalSection);
	bluetoothAddressGattIdMap->Insert(address, device->DeviceId);
	LeaveCriticalSection(&BLELookupCriticalSection);

	co_return JsonValue::CreateStringValue(device->DeviceId);
}

concurrency::task<IJsonValue^> disconnectRequest(JsonObject^ command) {
	String^ deviceId = command->GetNamedString("device", "");
	if (!devices->HasKey(deviceId)) {
		throw ref new FailureException(ref new String(L"Device not found"));
	}
	Bluetooth::BluetoothLEDevice^ device = devices->Lookup(deviceId);

	// When disconnecting from a device, also remove all the characteristics from our cache.
	auto newCharacteristicsMap = ref new Collections::Map<String^, Bluetooth::GenericAttributeProfile::GattCharacteristic^>();
	for (auto pair : characteristicsMap)
	{
		bool removed = true;
		try {
			auto service = pair->Value->Service;
			if (service->Session->DeviceId->Equals(device->DeviceId)) {
				delete service->Session;
				delete service;
			}
			else {
				newCharacteristicsMap->Insert(pair->Key, pair->Value);
				removed = false;
			}
		}
		catch (...) {
			// Service is probably already closed, so we just skip it and it will be removed from the list
		}

		if (removed) {
			if (characteristicsListenerMap->HasKey(pair->Key)) {
				characteristicsListenerMap->Remove(pair->Key);
			}
			if (characteristicsSubscriptionMap->HasKey(pair->Key)) {
				characteristicsSubscriptionMap->Remove(pair->Key);
			}
		}
	}
	characteristicsMap = newCharacteristicsMap;
	devices->Remove(deviceId);

	return Concurrency::task_from_result<IJsonValue^>(JsonValue::CreateNullValue());
}

concurrency::task<Bluetooth::GenericAttributeProfile::GattDeviceServicesResult^> findServices(JsonObject^ command) {
	String^ deviceId = command->GetNamedString("device", "");
	if (!devices->HasKey(deviceId)) {
		throw ref new FailureException(ref new String(L"Device not found"));
	}
	Bluetooth::BluetoothLEDevice^ device = devices->Lookup(deviceId);
	if (command->HasKey("service")) {
		co_return co_await device->GetGattServicesForUuidAsync(parseUuid(command->GetNamedString("service")));
	}
	else {
		co_return co_await device->GetGattServicesAsync();
	}
}

String^ characteristicKey(String^ device, String^ service, String^ characteristic) {
	std::wstring result = device->Data();
	result += L"//";
	result += service->Data();
	result += L"//";
	result += characteristic->Data();
	return ref new String(result.c_str());
}

String^ characteristicKey(JsonObject^ command) {
	return characteristicKey(command->GetNamedString("device"), command->GetNamedString("service"), command->GetNamedString("characteristic"));
}

concurrency::task<Bluetooth::GenericAttributeProfile::GattCharacteristicsResult^> findCharacteristics(JsonObject^ command) {
	if (!command->HasKey("service")) {
		throw ref new InvalidArgumentException(ref new String(L"Service uuid must be provided"));
	}
	auto servicesResult = co_await findServices(command);
	auto services = servicesResult->Services;
	if (services->Size == 0) {
		throw ref new FailureException(ref new String(L"Requested service not found"));
	}
	auto service = services->GetAt(0);
	auto results = co_await service->GetCharacteristicsAsync();
	for (unsigned int i = 0; i < results->Characteristics->Size; i++) {
		auto characteristic = results->Characteristics->GetAt(i);
		auto key = characteristicKey(command->GetNamedString("device"), command->GetNamedString("service"), characteristic->Uuid.ToString());
		characteristicsMap->Insert(key, characteristic);
	}
	co_return results;
}

concurrency::task<Bluetooth::GenericAttributeProfile::GattCharacteristic^> getCharacteristic(JsonObject^ command) {
	if (!command->HasKey("characteristic")) {
		throw ref new InvalidArgumentException(ref new String(L"Characteristic uuid must be provided"));
	}

	auto key = characteristicKey(command);
	if (!characteristicsMap->HasKey(key)) {
		co_await findCharacteristics(command);
	}

	if (characteristicsMap->HasKey(key)) {
		co_return characteristicsMap->Lookup(key);
	}

	throw ref new FailureException(ref new String(L"Requested characteristic not found"));
}

concurrency::task<IJsonValue^> servicesRequest(JsonObject^ command) {
	auto servicesResult = co_await findServices(command);
	auto result = ref new JsonArray();
	for (unsigned int i = 0; i < servicesResult->Services->Size; i++) {
		result->Append(JsonValue::CreateStringValue(servicesResult->Services->GetAt(i)->Uuid.ToString()));
	}
	co_return result;
}

concurrency::task<IJsonValue^> charactersticsRequest(JsonObject^ command) {
	auto characteristicsResult = co_await findCharacteristics(command);
	auto result = ref new JsonArray();
	for (unsigned int i = 0; i < characteristicsResult->Characteristics->Size; i++) {
		auto characteristic = characteristicsResult->Characteristics->GetAt(i);
		auto characteristicJson = ref new JsonObject();
		auto properties = ref new JsonObject();
		auto props = (unsigned int)characteristic->CharacteristicProperties;
		properties->SetNamedValue("broadcast", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Broadcast));
		properties->SetNamedValue("read", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Read));
		properties->SetNamedValue("writeWithoutResponse", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::WriteWithoutResponse));
		properties->SetNamedValue("write", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Write));
		properties->SetNamedValue("notify", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Notify));
		properties->SetNamedValue("indicate", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Indicate));
		properties->SetNamedValue("authenticatedSignedWrites", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::AuthenticatedSignedWrites));
		properties->SetNamedValue("reliableWrite", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::ReliableWrites));
		properties->SetNamedValue("writableAuxiliaries", JsonValue::CreateBooleanValue(props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::WritableAuxiliaries));
		characteristicJson->SetNamedValue("uuid", JsonValue::CreateStringValue(characteristic->Uuid.ToString()));
		characteristicJson->SetNamedValue("properties", properties);
		result->Append(characteristicJson);
	}
	co_return result;
}

concurrency::task<IJsonValue^> acceptPairingRequest(JsonObject^ command) {
	pairingRequestWaiting->Insert(command->GetNamedNumber("origId"), "accept");

	JsonObject^ response = ref new JsonObject();
	response->Insert("_type", JsonValue::CreateStringValue("noop"));
	co_return response;
}

concurrency::task<IJsonValue^> acceptPairingRequestPin(JsonObject^ command) {
	pairingRequestWaiting->Insert(command->GetNamedNumber("origId"), "accept");
	pairingRequestPasswordPIN->Insert(command->GetNamedNumber("origId"), command->GetNamedString("pin"));

	JsonObject^ response = ref new JsonObject();
	response->Insert("_type", JsonValue::CreateStringValue("noop"));
	co_return response;
}

concurrency::task<IJsonValue^> acceptPairingRequestPasswordCredential(JsonObject^ command) {
	pairingRequestWaiting->Insert(command->GetNamedNumber("origId"), "accept");
	pairingRequestUsername->Insert(command->GetNamedNumber("origId"), command->GetNamedString("username"));
	pairingRequestPasswordPIN->Insert(command->GetNamedNumber("origId"), command->GetNamedString("password"));

	JsonObject^ response = ref new JsonObject();
	response->Insert("_type", JsonValue::CreateStringValue("noop"));
	co_return response;
}

concurrency::task<IJsonValue^> cancelPairingRequest(JsonObject^ command) {
	pairingRequestWaiting->Insert(command->GetNamedNumber("origId"), "cancel");

	JsonObject^ response = ref new JsonObject();
	response->Insert("_type", JsonValue::CreateStringValue("noop"));
	co_return response;
}

concurrency::task<IJsonValue^> pairRequest(JsonObject^ command) {
	Bluetooth::BluetoothLEDevice^ device = devices->Lookup(command->GetNamedString("device"));
	// Pair the device if needed
	if (device->DeviceInformation->Pairing->CanPair && !(device->DeviceInformation->Pairing->IsPaired)) {
		Enumeration::DevicePairingKinds supportedCeremonies = supportedCeremonies | Enumeration::DevicePairingKinds::ConfirmOnly;
		supportedCeremonies = supportedCeremonies | Enumeration::DevicePairingKinds::DisplayPin;
		supportedCeremonies = supportedCeremonies | Enumeration::DevicePairingKinds::ProvidePin;
		supportedCeremonies = supportedCeremonies | Enumeration::DevicePairingKinds::ConfirmOnly;
		supportedCeremonies = supportedCeremonies | Enumeration::DevicePairingKinds::ProvidePasswordCredential;
		auto commandId = command->GetNamedNumber("_id");
		device->DeviceInformation->Pairing->Custom->PairingRequested +=
			ref new Windows::Foundation::TypedEventHandler<Windows::Devices::Enumeration::DeviceInformationCustomPairing^,
			Windows::Devices::Enumeration::DevicePairingRequestedEventArgs^>(
				[commandId](Enumeration::DeviceInformationCustomPairing^ customPairing, Enumeration::DevicePairingRequestedEventArgs^ pairRequestArgs) {
					auto deferral = pairRequestArgs->GetDeferral();
					JsonObject^ msg = ref new JsonObject();
					msg->Insert("pairingType", JsonValue::CreateBooleanValue(true));
					msg->Insert("_id", JsonValue::CreateNumberValue(commandId));
					if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::None) {
						throw ref new FailureException("The device cannot be paired");
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ConfirmOnly) {
						// also tack on a copy of the command in background.js to enable reissuing
						msg->Insert("_type", JsonValue::CreateStringValue("pairing_confirmOnly"));
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ConfirmPinMatch) {
						msg->Insert("_type", JsonValue::CreateStringValue("pairing_confirmPinMatch"));
						msg->Insert("pin", JsonValue::CreateStringValue(pairRequestArgs->Pin));
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::DisplayPin) {
						msg->Insert("_type", JsonValue::CreateStringValue("pairing_displayPin"));
						msg->Insert("pin", JsonValue::CreateStringValue(pairRequestArgs->Pin));
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ProvidePin) {
						msg->Insert("_type", JsonValue::CreateStringValue("pairing_providePin"));
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ProvidePasswordCredential) {
						msg->Insert("_type", JsonValue::CreateStringValue("pairing_providePasswordCredential"));
					}
					pairingRequestWaiting->Insert(commandId, "waiting");
					writeObject(msg);
					// wait until accepted/cancelled
					while (pairingRequestWaiting->Lookup(commandId)->Equals("waiting")) {
						// wait
						Sleep(500);
					}
					boolean cancel = false;
					if (pairingRequestWaiting->Lookup(commandId)->Equals("cancel")) {
						// do nothing because there is no reject method
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ConfirmOnly ||
						pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ConfirmPinMatch ||
						pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::DisplayPin) {
						pairRequestArgs->Accept();
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ProvidePin) {
						pairRequestArgs->Accept(pairingRequestPasswordPIN->Lookup(commandId));
						pairingRequestPasswordPIN->Remove(commandId);
					}
					else if (pairRequestArgs->PairingKind == Enumeration::DevicePairingKinds::ProvidePasswordCredential) {
						auto credential = ref new PasswordCredential();
						credential->UserName = pairingRequestUsername->Lookup(commandId);
						credential->Password = pairingRequestPasswordPIN->Lookup(commandId);
						pairRequestArgs->AcceptWithPasswordCredential(credential);
						pairingRequestUsername->Remove(commandId);
						pairingRequestPasswordPIN->Remove(commandId);
					}
					pairingRequestWaiting->Remove(commandId);

					deferral->Complete();
				});
		auto pair_status = co_await device->DeviceInformation->Pairing->Custom->PairAsync(supportedCeremonies);
		// RejectedByHandler is raised in cases of cancellation
		if (pair_status->Status != Enumeration::DevicePairingResultStatus::Paired
			&& pair_status->Status != Enumeration::DevicePairingResultStatus::AlreadyPaired
			&& pair_status->Status != Enumeration::DevicePairingResultStatus::RejectedByHandler) {
			throw ref new FailureException(pair_status->Status.ToString());
		}
	}

	JsonObject^ response = ref new JsonObject();
	response->Insert("_type", JsonValue::CreateStringValue("noop"));

	co_return response;
}

concurrency::task<IJsonValue^> readRequest(JsonObject^ command, int skipPair = 0) {
	auto characteristic = co_await getCharacteristic(command);
	auto result = co_await characteristic->ReadValueAsync();
	if (result->Status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success && skipPair == 0) {
		co_await pairRequest(command);
		co_return co_await readRequest(command, 1);
	}
	else if (result->Status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException(result->Status.ToString());
	}
	auto reader = Windows::Storage::Streams::DataReader::FromBuffer(result->Value);
	auto valueArray = ref new JsonArray();
	for (unsigned int i = 0; i < result->Value->Length; i++) {
		valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
	}
	co_return valueArray;
}

concurrency::task<IJsonValue^> writeRequest(JsonObject^ command, int reqWriteType = 0, int skipPair = 0) {
	auto characteristic = co_await getCharacteristic(command);
	auto writer = ref new Windows::Storage::Streams::DataWriter();
	auto dataArray = command->GetNamedArray("value");
	for (unsigned int i = 0; i < dataArray->Size; i++) {
		writer->WriteByte((unsigned char)dataArray->GetNumberAt(i));
	}

	bool writeWithoutResponse = (unsigned int)characteristic->CharacteristicProperties & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::WriteWithoutResponse;
	auto writeType = writeWithoutResponse ? Bluetooth::GenericAttributeProfile::GattWriteOption::WriteWithoutResponse : Bluetooth::GenericAttributeProfile::GattWriteOption::WriteWithResponse;
	auto status = co_await characteristic->WriteValueAsync(writer->DetachBuffer(), writeType);

	// override if specified in request
	if (reqWriteType == 1) {
		writeType = Bluetooth::GenericAttributeProfile::GattWriteOption::WriteWithResponse;
	}
	else if (reqWriteType == 2) {
		writeType = Bluetooth::GenericAttributeProfile::GattWriteOption::WriteWithoutResponse;
	}

	if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success && skipPair == 0) {
		co_await pairRequest(command);
		co_return co_await writeRequest(command, reqWriteType, 1);
	}
	else if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException(status.ToString());
	}

	co_return JsonValue::CreateNullValue();
}

unsigned long nextSubscriptionId = 1;

concurrency::task<IJsonValue^> subscribeRequest(JsonObject^ command, int skipPair = 0) {
	auto characteristic = co_await getCharacteristic(command);

	auto props = (unsigned int)characteristic->CharacteristicProperties;

	if (props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Notify) {
		auto status = co_await characteristic->WriteClientCharacteristicConfigurationDescriptorAsync(Bluetooth::GenericAttributeProfile::GattClientCharacteristicConfigurationDescriptorValue::Notify);
		if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success && skipPair == 0) {
			co_await pairRequest(command);
			co_return co_await subscribeRequest(command, 1);
		}
		else if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success) {
			throw ref new FailureException(status.ToString());
		}
	}
	else if (props & (unsigned int)Bluetooth::GenericAttributeProfile::GattCharacteristicProperties::Indicate) {
		auto status = co_await characteristic->WriteClientCharacteristicConfigurationDescriptorAsync(Bluetooth::GenericAttributeProfile::GattClientCharacteristicConfigurationDescriptorValue::Indicate);
		if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success && skipPair == 0) {
			co_await pairRequest(command);
			co_return co_await subscribeRequest(command, 1);
		}
		else if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success) {
			throw ref new FailureException(status.ToString());
		}
	}
	else {
		throw ref new FailureException("Operation not supported.");
	}

	auto key = characteristicKey(command);
	if (characteristicsSubscriptionMap->HasKey(key)) {
		co_return characteristicsSubscriptionMap->Lookup(key);
	}

	auto subscriptionId = JsonValue::CreateNumberValue(nextSubscriptionId++);

	Windows::Foundation::EventRegistrationToken cookie =
		characteristic->ValueChanged += ref new Windows::Foundation::TypedEventHandler<Bluetooth::GenericAttributeProfile::GattCharacteristic^, Bluetooth::GenericAttributeProfile::GattValueChangedEventArgs^>(
			[subscriptionId](Bluetooth::GenericAttributeProfile::GattCharacteristic^ characteristic, Bluetooth::GenericAttributeProfile::GattValueChangedEventArgs^ eventArgs) {
				JsonObject^ msg = ref new JsonObject();
				msg->Insert("_type", JsonValue::CreateStringValue("valueChangedNotification"));
				msg->Insert("subscriptionId", subscriptionId);
				auto reader = Windows::Storage::Streams::DataReader::FromBuffer(eventArgs->CharacteristicValue);
				auto valueArray = ref new JsonArray();
				for (unsigned int i = 0; i < eventArgs->CharacteristicValue->Length; i++) {
					valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
				}
				msg->Insert("value", valueArray);
				writeObject(msg);
			});

	characteristicsListenerMap->Insert(key, cookie);
	characteristicsSubscriptionMap->Insert(key, subscriptionId);

	co_return subscriptionId;
}

concurrency::task<IJsonValue^> unsubscribeRequest(JsonObject^ command, int skipPair = 0) {
	auto characteristic = co_await getCharacteristic(command);

	auto status = co_await characteristic->WriteClientCharacteristicConfigurationDescriptorAsync(Bluetooth::GenericAttributeProfile::GattClientCharacteristicConfigurationDescriptorValue::None);
	if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success && skipPair == 0) {
		co_await pairRequest(command);
		co_return co_await unsubscribeRequest(command, 1);
	}
	else if (status != Bluetooth::GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException(status.ToString());
	}

	auto key = characteristicKey(command);

	if (characteristicsListenerMap->HasKey(key)) {
		characteristic->ValueChanged -= characteristicsListenerMap->Lookup(key);
	}

	auto subscriptionId = characteristicsSubscriptionMap->Lookup(key);

	characteristicsListenerMap->Remove(key);
	characteristicsSubscriptionMap->Remove(key);

	co_return subscriptionId;
}

concurrency::task<IJsonValue^> checkAvailability(JsonObject^ command) {
	auto adapter = co_await BluetoothAdapter::GetDefaultAsync();
	if (adapter != nullptr) {
		co_return JsonValue::CreateBooleanValue(true);
	}
	co_return JsonValue::CreateBooleanValue(false);
}

concurrency::task<IJsonValue^> getDescriptorUuidAndValueAsJson(GenericAttributeProfile::GattDescriptor^ descriptor, BluetoothCacheMode cacheMode = BluetoothCacheMode::Uncached) {
	auto result = ref new JsonObject();

	result->Insert("uuid", JsonValue::CreateStringValue(descriptor->Uuid.ToString()));

	GenericAttributeProfile::GattReadResult^ descValue;

	descValue = co_await descriptor->ReadValueAsync(cacheMode);

	if (descValue->Status != GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException("Unable to read descriptor value: " + descValue->Status.ToString());
	}

	auto reader = Windows::Storage::Streams::DataReader::FromBuffer(descValue->Value);
	auto valueArray = ref new JsonArray();
	for (unsigned int i = 0; i < descValue->Value->Length; i++) {
		valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
	}

	result->Insert("value", valueArray);

	co_return result;
}

concurrency::task<GenericAttributeProfile::GattDescriptor^> retrieveFirstDescriptor(JsonObject^ command) {
	auto characteristic = co_await getCharacteristic(command);
	auto descriptorUuid = parseUuid(command->GetNamedString("descriptor"));
	auto descriptors = co_await characteristic->GetDescriptorsForUuidAsync(descriptorUuid, BluetoothCacheMode::Uncached);
	if (descriptors->Status != GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException("Unable to retrieve descriptors");
	}

	auto firstDesc = descriptors->Descriptors->First()->Current;

	co_return firstDesc;
}

concurrency::task<IJsonValue^> getDescriptor(JsonObject^ command, BluetoothCacheMode cacheMode = BluetoothCacheMode::Uncached) {
	auto firstDesc = co_await retrieveFirstDescriptor(command);

	auto result = co_await getDescriptorUuidAndValueAsJson(firstDesc, cacheMode);

	co_return result;
}

concurrency::task<IJsonValue^> getDescriptors(JsonObject^ command) {
	auto result = ref new JsonObject();
	auto resultlist = ref new JsonArray();

	auto characteristic = co_await getCharacteristic(command);

	GenericAttributeProfile::GattDescriptorsResult^ descriptors;

	if (command->HasKey("descriptor")) {
		auto descriptorUuid = parseUuid(command->GetNamedString("descriptor"));
		descriptors = co_await characteristic->GetDescriptorsForUuidAsync(descriptorUuid, BluetoothCacheMode::Uncached);
	}
	else {
		descriptors = co_await characteristic->GetDescriptorsAsync(BluetoothCacheMode::Uncached);
	}

	if (descriptors->Status != GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException("Unable to retrieve descriptors");
	}

	int descSize = descriptors->Descriptors->Size;

	for (int i = 0; i < descSize; i++) {
		auto desDesc = descriptors->Descriptors->GetAt(i);
		auto resultInner = co_await getDescriptorUuidAndValueAsJson(desDesc, BluetoothCacheMode::Cached);
		resultlist->Append(resultInner);
	}


	result->Insert("list", resultlist);
	co_return result;
}

concurrency::task<IJsonValue^> writeDescriptorValue(JsonObject^ command) {
	auto firstDesc = co_await retrieveFirstDescriptor(command);

	auto writer = ref new Windows::Storage::Streams::DataWriter();
	auto dataArray = command->GetNamedArray("value");
	for (unsigned int i = 0; i < dataArray->Size; i++) {
		writer->WriteByte((unsigned char)dataArray->GetNumberAt(i));
	}

	auto writeStatus = co_await firstDesc->WriteValueAsync(writer->DetachBuffer());

	if (writeStatus != GenericAttributeProfile::GattCommunicationStatus::Success) {
		throw ref new FailureException("Unable to write descriptor value: " + writeStatus.ToString());
	}

	auto result = co_await getDescriptorUuidAndValueAsJson(firstDesc, BluetoothCacheMode::Uncached);

	co_return result;
}

concurrency::task<void> processCommand(JsonObject^ command) {
	String^ cmd = command->GetNamedString("cmd", "");
	JsonObject^ response = ref new JsonObject();
	IJsonValue^ result = nullptr;
	response->Insert("_type", JsonValue::CreateStringValue("response"));
	response->Insert("_id", command->GetNamedValue("_id", JsonValue::CreateNullValue()));

	try {
		if (cmd->Equals("ping")) {
			result = JsonValue::CreateStringValue("pong");
		}

		if (cmd->Equals("scan")) {
			bleAdvertisementWatcher->Start();
			result = JsonValue::CreateNullValue();
		}

		if (cmd->Equals("stopScan")) {
			bleAdvertisementWatcher->Stop();
			result = JsonValue::CreateNullValue();
		}

		if (cmd->Equals("connect")) {
			result = co_await connectRequest(command);
		}

		if (cmd->Equals("disconnect")) {
			result = co_await disconnectRequest(command);
		}

		if (cmd->Equals("services")) {
			result = co_await servicesRequest(command);
		}

		if (cmd->Equals("characteristics")) {
			result = co_await charactersticsRequest(command);
		}

		if (cmd->Equals("read")) {
			result = co_await readRequest(command);
		}

		if (cmd->Equals("write")) {
			result = co_await writeRequest(command);
		}

		if (cmd->Equals("writeWithResponse")) {
			result = co_await writeRequest(command, 1);
		}

		if (cmd->Equals("writeWithoutResponse")) {
			result = co_await writeRequest(command, 2);
		}

		if (cmd->Equals("subscribe")) {
			result = co_await subscribeRequest(command);
		}

		if (cmd->Equals("unsubscribe")) {
			result = co_await unsubscribeRequest(command);
		}

		if (cmd->Equals("accept")) {
			result = co_await acceptPairingRequest(command);
		}

		if (cmd->Equals("acceptPasswordCredential")) {
			result = co_await acceptPairingRequestPasswordCredential(command);
		}

		if (cmd->Equals("acceptPin")) {
			result = co_await acceptPairingRequestPin(command);
		}

		if (cmd->Equals("cancel")) {
			result = co_await cancelPairingRequest(command);
		}

		if (cmd->Equals("availability")) {
			result = co_await checkAvailability(command);
		}

		if (cmd->Equals("getDescriptor")) {
			result = co_await getDescriptor(command, BluetoothCacheMode::Cached);
		}

		if (cmd->Equals("getDescriptors")) {
			result = co_await getDescriptors(command);
		}

		if (cmd->Equals("readDescriptorValue")) {
			result = co_await getDescriptor(command, BluetoothCacheMode::Uncached);
		}

		if (cmd->Equals("writeDescriptorValue")) {
			result = co_await writeDescriptorValue(command);
		}

		if (result != nullptr) {
			response->Insert("result", result);
		}
		else {
			response->Insert("error", JsonValue::CreateStringValue("Unknown command"));
		}
		writeObject(response);
	}
	catch (Exception^ e) {
		response->Insert("error", JsonValue::CreateStringValue(e->ToString()));
		writeObject(response);
	}
	catch (...) {
		response->Insert("error", JsonValue::CreateStringValue("Unknown error"));
		writeObject(response);
	}
}

int main(Array<String^>^ args) {
	CreateMutex(NULL, FALSE, L"BLEServer");

	Microsoft::WRL::Wrappers::RoInitializeWrapper initialize(RO_INIT_MULTITHREADED);

	CoInitializeSecurity(
		nullptr, // TODO: "O:BAG:BAD:(A;;0x7;;;PS)(A;;0x3;;;SY)(A;;0x7;;;BA)(A;;0x3;;;AC)(A;;0x3;;;LS)(A;;0x3;;;NS)"
		-1,
		nullptr,
		nullptr,
		RPC_C_AUTHN_LEVEL_DEFAULT,
		RPC_C_IMP_LEVEL_IDENTIFY,
		NULL,
		EOAC_NONE,
		nullptr);

	if (!InitializeCriticalSectionAndSpinCount(&OutputCriticalSection, 0x00000400)) {
		return -1;
	}

	if (!InitializeCriticalSectionAndSpinCount(&BLELookupCriticalSection, 0x00000400)) {
		return -1;
	}

	bleAdvertisementWatcher = ref new Bluetooth::Advertisement::BluetoothLEAdvertisementWatcher();
	bleAdvertisementWatcher->ScanningMode = Bluetooth::Advertisement::BluetoothLEScanningMode::Active;
	bleAdvertisementWatcher->Received += ref new Windows::Foundation::TypedEventHandler<Bluetooth::Advertisement::BluetoothLEAdvertisementWatcher^, Windows::Devices::Bluetooth::Advertisement::BluetoothLEAdvertisementReceivedEventArgs^>(
		[](Bluetooth::Advertisement::BluetoothLEAdvertisementWatcher^ watcher, Bluetooth::Advertisement::BluetoothLEAdvertisementReceivedEventArgs^ eventArgs) {
			unsigned int index = -1;

			JsonObject^ msg = ref new JsonObject();
			msg->Insert("_type", JsonValue::CreateStringValue("scanResult"));
			msg->Insert("bluetoothAddress", JsonValue::CreateStringValue(ref new String(formatBluetoothAddress(eventArgs->BluetoothAddress).c_str())));
			msg->Insert("rssi", JsonValue::CreateNumberValue(eventArgs->RawSignalStrengthInDBm));
			// TODO fix timestamp calculation
			msg->Insert("timestamp", JsonValue::CreateNumberValue((double)eventArgs->Timestamp.UniversalTime / 10000.0 + 11644480800000));
			msg->Insert("advType", JsonValue::CreateStringValue(eventArgs->AdvertisementType.ToString()));
			msg->Insert("localName", JsonValue::CreateStringValue(eventArgs->Advertisement->LocalName));
			
			// appearance
			auto appearanceData = eventArgs->Advertisement->GetSectionsByType(0x19);
			if (appearanceData->Size > 0) {
				auto appearanceSection = appearanceData->GetAt(0);
				auto reader = Windows::Storage::Streams::DataReader::FromBuffer(appearanceSection->Data);
				unsigned short appearanceValue = reader->ReadUInt16();
				msg->Insert("appearance", JsonValue::CreateNumberValue(appearanceValue));
			}
			else {
				msg->Insert("appearance", JsonValue::CreateNullValue());
			}

			// txPower requires Windows 10 version 2004
			if (Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
				"Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs",
				"TransmitPowerLevelInDBm")) {
				if (eventArgs->TransmitPowerLevelInDBm != nullptr) {
					msg->Insert("txPower", JsonValue::CreateNumberValue(eventArgs->TransmitPowerLevelInDBm->Value));
				}
				else {
					msg->Insert("txPower", JsonValue::CreateNullValue());
				}
			}
			else {
				msg->Insert("txPower", JsonValue::CreateNullValue());
			}

			JsonArray^ serviceUuids = ref new JsonArray();
			for (unsigned int i = 0; i < eventArgs->Advertisement->ServiceUuids->Size; i++) {
				serviceUuids->Append(JsonValue::CreateStringValue(eventArgs->Advertisement->ServiceUuids->GetAt(i).ToString()));
			}
			msg->Insert("serviceUuids", serviceUuids);

			auto manufacturerData = eventArgs->Advertisement->ManufacturerData;

			auto manufacturerDataJson = ref new JsonArray();

			for (unsigned int i = 0; i < manufacturerData->Size; i++) {
				auto desiredItem = manufacturerData->GetAt(i);
				auto manufacturerItem = ref new JsonObject();

				manufacturerItem->Insert("companyIdentifier", JsonValue::CreateNumberValue(desiredItem->CompanyId));

				auto reader = Windows::Storage::Streams::DataReader::FromBuffer(desiredItem->Data);
				auto valueArray = ref new JsonArray();
				for (unsigned int i = 0; i < desiredItem->Data->Length; i++) {
					valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
				}
				manufacturerItem->Insert("data", valueArray);

				manufacturerDataJson->Append(manufacturerItem);
			}

			msg->Insert("manufacturerData", manufacturerDataJson);


			auto serviceDataJson = ref new JsonArray();

			auto SERVICE_DATA_TYPES = {
				0x16, // Service Data - 16-bit UUID
				0x20, // Service Data - 32-bit UUID
				0x21, // Service Data - 128-bit UUID
			};

			for (auto type : SERVICE_DATA_TYPES) {
				auto serviceData = eventArgs->Advertisement->GetSectionsByType(type);
				for (auto serviceDataSection : serviceData) {
					auto reader = Windows::Storage::Streams::DataReader::FromBuffer(serviceDataSection->Data);

					auto serviceDataInner = ref new JsonObject();

					switch (type)
					{
						case 0x16:
						{
							unsigned short uuid16 = reader->ReadUInt16();
							auto valueArray = ref new JsonArray();
							while (reader->UnconsumedBufferLength > 0) {
								valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
							}
							serviceDataInner->Insert("service", JsonValue::CreateNumberValue(uuid16));
							serviceDataInner->Insert("data", valueArray);
							break;
						}
						case 0x20:
						{
							unsigned int uuid32 = reader->ReadUInt32();
							auto valueArray = ref new JsonArray();
							while (reader->UnconsumedBufferLength > 0) {
								valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
							}
							serviceDataInner->Insert("service", JsonValue::CreateNumberValue(uuid32));
							serviceDataInner->Insert("data", valueArray);
							break;
						}
						case 0x21:
						{
							auto uuid128 = reader->ReadGuid();
							auto valueArray = ref new JsonArray();
							while (reader->UnconsumedBufferLength > 0) {
								valueArray->Append(JsonValue::CreateNumberValue(reader->ReadByte()));
							}
							serviceDataInner->Insert("service", JsonValue::CreateStringValue(uuid128.ToString()));
							serviceDataInner->Insert("data", valueArray);
							break;
						}
						default:
						{
							break;
						}
					}

					serviceDataJson->Append(serviceDataInner);
				}
			}

			msg->Insert("serviceData", serviceDataJson);

			// TODO flags / data sections ?

			auto bluetoothAddress = eventArgs->BluetoothAddress;

			EnterCriticalSection(&BLELookupCriticalSection);
			if (bluetoothAddressGattIdMap->HasKey(bluetoothAddress) && !(bluetoothAddressGattIdMap->Lookup(bluetoothAddress)->Equals(""))) {
				auto gattId = bluetoothAddressGattIdMap->Lookup(bluetoothAddress);
				LeaveCriticalSection(&BLELookupCriticalSection);
				msg->Insert("gattId", !(gattId->Equals("")) ? JsonValue::CreateStringValue(gattId) : JsonValue::CreateNullValue());
				writeObject(msg);
				return;
			}
			else {
				if (bleInProgressLookups.find(bluetoothAddress) == bleInProgressLookups.end()) {
					// TODO: possible memory leak, consider adding expiration
					bleInProgressLookups.emplace(bluetoothAddress, concurrency::task_completion_event<String^>());
					LeaveCriticalSection(&BLELookupCriticalSection);
					concurrency::create_task([bluetoothAddress]()->concurrency::task<void> {
						EnterCriticalSection(&BLELookupCriticalSection);
						auto tce = bleInProgressLookups.at(bluetoothAddress);
						LeaveCriticalSection(&BLELookupCriticalSection);
						auto bleDevice = co_await Bluetooth::BluetoothLEDevice::FromBluetoothAddressAsync(bluetoothAddress);
						if (bleDevice != nullptr) {
							EnterCriticalSection(&BLELookupCriticalSection);
							bluetoothAddressGattIdMap->Insert(bluetoothAddress, bleDevice->DeviceId);
							LeaveCriticalSection(&BLELookupCriticalSection);
							tce.set(bleDevice->DeviceId);
						}
						else {
							EnterCriticalSection(&BLELookupCriticalSection);
							bluetoothAddressGattIdMap->Insert(bluetoothAddress, ref new String(L""));
							LeaveCriticalSection(&BLELookupCriticalSection);
							tce.set(ref new String(L""));
						}
					});
				}
				else {
					LeaveCriticalSection(&BLELookupCriticalSection);
				}

				auto msgStr = msg->Stringify();
				concurrency::create_task([bluetoothAddress, msgStr]()->concurrency::task<void> {
					JsonObject^ msg = JsonObject::Parse(msgStr);

					EnterCriticalSection(&BLELookupCriticalSection);
					auto tce = bleInProgressLookups.at(bluetoothAddress);
					LeaveCriticalSection(&BLELookupCriticalSection);
					auto gattIdFromTce = co_await concurrency::task<String^>(tce);
					
					String^ gattId;
					EnterCriticalSection(&BLELookupCriticalSection);
					if (bluetoothAddressGattIdMap->HasKey(bluetoothAddress)) {
						gattId = bluetoothAddressGattIdMap->Lookup(bluetoothAddress);
					}
					else {
						gattId = gattIdFromTce;
						//bluetoothAddressGattIdMap->Insert(bluetoothAddress, gattId);
					}
					LeaveCriticalSection(&BLELookupCriticalSection);

					msg->Insert("gattId", !(gattId->Equals("")) ? JsonValue::CreateStringValue(gattId) : JsonValue::CreateNullValue());
					writeObject(msg);
				});
			}
		}
	);

	JsonObject^ msg = ref new JsonObject();
	msg->Insert("_type", JsonValue::CreateStringValue("Start"));
	// API version is required and will be incremented when breaking changes are made to the API
	msg->Insert("apiVersion", JsonValue::CreateNumberValue(API_VERSION));
	// the following two values are not currently validated but may be used in the future to determine whether to offer users an update to BLEServer
	// third-party server implementations should change these values for their servers
	msg->Insert("serverName", JsonValue::CreateStringValue("bleserver-win-cppcx"));
	msg->Insert("serverVersion", JsonValue::CreateStringValue("0.5.0"));
	writeObject(msg);

	// Set STDIN / STDOUT to binary mode
	if ((_setmode(0, _O_BINARY) == -1) || (_setmode(1, _O_BINARY) == -1)) {
		return -1;
	}

	std::wstring_convert<std::codecvt_utf8<wchar_t>> convert;
	try {
		while (!std::cin.eof()) {
			unsigned int len = 0;
			std::cin.read(reinterpret_cast<char*>(&len), 4);

			if (len > 0) {
				char* msgBuf = new char[len];
				std::cin.read(msgBuf, len);
				String^ jsonStr = ref new String(convert.from_bytes(msgBuf, msgBuf + len).c_str());
				delete[] msgBuf;
				JsonObject^ json = JsonObject::Parse(jsonStr);
				processCommand(json);
			}
		}
	}
	catch (std::exception& e) {
		JsonObject^ msg = ref new JsonObject();
		msg->Insert("_type", JsonValue::CreateStringValue("error"));
		std::string eReason = std::string(e.what());
		std::wstring wReason = std::wstring(eReason.begin(), eReason.end());
		msg->Insert("error", JsonValue::CreateStringValue(ref new String(wReason.c_str())));
		writeObject(msg);
	}

	DeleteCriticalSection(&OutputCriticalSection);

	return 0;
}
