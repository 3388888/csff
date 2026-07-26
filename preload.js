const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (o) => ipcRenderer.invoke("settings:set", o),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickFile: (filters) => ipcRenderer.invoke("dialog:pickFile", filters),
  pickDemos: () => ipcRenderer.invoke("dialog:pickDemos"),
  listDemos: (dir) => ipcRenderer.invoke("demos:list", dir),
  parseDemo: (p, opts) => ipcRenderer.invoke("demo:parse", p, opts),
  writeVdm: (demPath, cool, opts) => ipcRenderer.invoke("vdm:write", demPath, cool, opts),
  showItem: (p) => ipcRenderer.invoke("shell:showItem", p),
  launchCsgo: (demPath) => ipcRenderer.invoke("csgo:launch", demPath),
  launchCss: (demPath) => ipcRenderer.invoke("css:launch", demPath),
  getRadar: (map) => ipcRenderer.invoke("maps:radar", map),
  getIcons: () => ipcRenderer.invoke("icons:get"),
  getDefaultWeights: () => ipcRenderer.invoke("weights:defaults"),
  getRatings: () => ipcRenderer.invoke("ratings:get"),
  setRating: (key, patch) => ipcRenderer.invoke("ratings:set", key, patch),
  exportFeedback: (text) => ipcRenderer.invoke("feedback:export", text),
  onParseProgress: (cb) => ipcRenderer.on("parse:progress", (e, d) => cb(d)),
});
