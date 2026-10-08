export function parseExtension(filePath, fileContent, repository) {
    const components = [];
    const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() || '';
    if (fileName === 'manifest.json') {
        components.push({
            componentName: 'Manifest',
            type: 'Manifest',
            filePath,
            repository
        });
    }
    else if (fileContent.includes('chrome.runtime.onInstalled') || fileContent.includes('chrome.runtime.onMessage') || fileContent.includes('browser.runtime')) {
        if (fileName.includes('background')) {
            components.push({
                componentName: 'BackgroundScript',
                type: 'BackgroundScript',
                filePath,
                repository
            });
        }
        else if (fileName.includes('content')) {
            components.push({
                componentName: 'ContentScript',
                type: 'ContentScript',
                filePath,
                repository
            });
        }
        else {
            components.push({
                componentName: fileName,
                type: 'ExtensionScript',
                filePath,
                repository
            });
        }
    }
    return components;
}
