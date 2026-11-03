var chromeHandle;
var pluginScope;
function install() {}
function uninstall() {}
async function startup({ id, version, rootURI, resourceURI }) {
  await Zotero.initializationPromise;
  rootURI ||= resourceURI.spec;
  Components.utils.importGlobalProperties(['IOUtils', 'PathUtils']);
  chromeHandle = Components.classes['@mozilla.org/addons/addon-manager-startup;1']
    .getService(Components.interfaces.amIAddonManagerStartup)
    .registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
      ['content', 'codex-for-zotero', rootURI + 'content/'],
      ['locale', 'codex-for-zotero', 'en-US', rootURI + 'locale/en-US/'],
    ]);
  pluginScope = {
    Zotero,
    Services,
    ChromeUtils,
    IOUtils,
    PathUtils,
    Cc: Components.classes,
    Ci: Components.interfaces,
    rootURI,
    pluginID: id,
    pluginVersion: version,
  };
  Services.scriptloader.loadSubScript(rootURI + 'content/plugin.js', pluginScope);
  await pluginScope.CFZ.startup();
}
function onMainWindowLoad({ window }) {
  pluginScope?.CFZ?.windowLoad(window);
}
function onMainWindowUnload({ window }) {
  pluginScope?.CFZ?.windowUnload(window);
}
async function shutdown() {
  await pluginScope?.CFZ?.shutdown();
  chromeHandle?.destruct();
  chromeHandle = null;
  pluginScope = null;
}
