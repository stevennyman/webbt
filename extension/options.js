document.getElementById("versionnumber").textContent = browser.runtime.getManifest().version;

let port = chrome.runtime.connect();

// todo: don't redraw entire DOM when options changed since this doesn't scale
chrome.storage.onChanged.addListener(main);

async function removeLinkClick(e) {
    port.postMessage({command: "forgetDevice",
        args: [null, e.target.id.split("_")[1], e.target.id.split("_")[2]] });
    return false;
}

async function main() {
    let devicelistelem = document.getElementById("devicelist");

    let allKeys = await browser.storage.local.get();

    devicelistelem.innerHTML = "";

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
                devSiteEntrLink.id = "remove_"+elementr.webId+"_"+siteName;
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