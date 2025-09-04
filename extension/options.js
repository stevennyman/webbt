let port;

async function removeLinkClick(e) {
    if (!port) {
        port = chrome.runtime.connect();
        // port.onMessage.addListener(portMsg);
    }
    // todo: fix reliability when gattId is not available
    // args: address, gattId, origin
    port.postMessage({command: "forgetDevice",
        args: [e.target.id.split("_")[1], e.target.id.split("_")[2], e.target.id.split("_")[3]]});

    // e.target.parent.remove(); // probably not valid
    // TODO remove site category if empty
    return false;
}

async function main() {
    let devicelistelem = document.getElementById("devicelist");

    let allKeys = await browser.storage.local.get();

    for (const elem of Object.entries(allKeys)) {
        if (elem[0].startsWith("originDevices_")) {
            let siteName = elem[0].split("originDevices_", 2)[1];
            let deviceList = elem[1];

            let siteEntry = document.createElement("li");
            siteEntry.innerText = siteName;
            let siteDevices = document.createElement("ul");
            for (const elementr of deviceList) {
                let devSiteEntr = document.createElement("li");
                let devSiteEntrSpan = document.createElement("span");
                devSiteEntrSpan.textContent = elementr.name + " ";
                devSiteEntr.appendChild(devSiteEntrSpan);
                let devSiteEntrLink = document.createElement("a");
                devSiteEntrLink.textContent = "(remove)";
                devSiteEntrLink.id = "remove_"+elementr.address+"_"+elementr.gattId+"_"+siteName;
                devSiteEntrLink.href = "#";
                devSiteEntrLink.onclick = removeLinkClick;
                devSiteEntr.appendChild(devSiteEntrLink);
                siteDevices.appendChild(devSiteEntr);
            }
            siteEntry.appendChild(siteDevices);
            devicelistelem.appendChild(siteEntry);
        }
    }
}

main();