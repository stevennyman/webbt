async function main() {
    if ((await browser.storage.local.get('hideInstallation')).hideInstallation) {
        document.getElementById('hideinstallation').checked = true;
        document.getElementById('shownonce')?.removeAttribute('hidden');
    }

    document.getElementById('hideinstallation').addEventListener('click', (e) => {
        if (document.getElementById('hideinstallation').checked) {
            const userConfirm = confirm('The WebBT extension requires WebBT Server to be installed in order to function.\n\nThe information on this page is also available on the WebBT extension options page, accessible by clicking the WebBT icon.\n\nAre you sure you don\'t want to show this page again?');
            if (!userConfirm) {
                e.preventDefault();
            } else {
                browser.storage.local.set({ ['hideInstallation']: true });
            }
        } else {
            browser.storage.local.set({ ['hideInstallation']: false });
        }

    });
}

main();
