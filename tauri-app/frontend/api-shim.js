// Bridges the existing renderer (which expects Electron's `window.api`) to the Tauri
// backend. Load this BEFORE app.js in index.html. Core methods invoke real Rust commands;
// the rest are safe stubs so the UI loads while the port is completed.
(function () {
  const T = window.__TAURI__;
  const invoke = T && T.core ? T.core.invoke : async () => null;
  const listen = T && T.event ? T.event.listen : async () => () => {};

  const noop = async () => null;
  const emptyObj = async () => ({});

  window.api = {
    // --- implemented (real Rust commands) ---
    getSettings: () => invoke("settings_get"),
    setSettings: (o) => invoke("settings_set", { value: o }),
    pickFolder: () => invoke("pick_folder"),
    pickFile: () => invoke("pick_file"),
    pickDemos: () => invoke("pick_file"),
    listDemos: (dir) => invoke("list_demos", { dir }),
    // Decode AND classify in Rust, one call. classify.js is no longer in the data path.
    // CS:S/TF2 come back as their own frag result, detected backend-side.
    parseDemo: async (p) => {
      const r = await invoke("classify_demo", { path: p });
      if (r) r.demPath = p;
      return r;
    },
    getFrames: (demPath, watchTick, endTick) =>
      invoke("get_frames", { demPath, watchTick, endTick }),
    launchCsgo: (demPath) => invoke("launch_csgo", { demPath }),
    getFavorites: () => invoke("get_favorites"),
    setFavorite: (key, entry) => invoke("set_favorite", { key, entry }),
    getRatings: () => invoke("get_ratings"),
    setRating: (key, patch) => invoke("set_rating", { key, patch }),
    loadAggregate: () => invoke("load_aggregate"),
    saveAggregate: (data) => invoke("save_aggregate", { data }),
    clearAggregate: () => invoke("clear_aggregate"),
    getRadar: (map) => invoke("maps_radar", { map }),
    getMapGeo: async (map) => {
      const r = await invoke("maps_geo", { map });
      if (r && r.ok && typeof r.data === "string") {
        const bin = atob(r.data);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return { ...r, data: arr.buffer };
      }
      return r;
    },
    hasMapGeo: (map) => invoke("maps_geo_available", { map }),
    getDefaultWeights: () => invoke("get_default_weights"),
    onParseProgress: (cb) => listen("parse:progress", (e) => cb(e.payload)),

    launchCss: (demPath) => invoke("launch_css", { demPath }),
    gotoTick: (tick, spec, css, pause) => invoke("goto_tick", { tick, spec, css, pause }),
    extractBatch: (paths) => invoke("extract_batch", { paths }),
    writeVdm: (demPath, cool, opts) =>
      invoke("write_vdm", { demPath, highlights: cool || [], pause: !!(opts && opts.pause) }),

    showItem: (p) => invoke("show_item", { path: p }),
    getIcons: () => invoke("get_icons"),
    cpuSample: () => invoke("cpu_sample"),
    pixelsurfPending: (paths) => invoke("pixelsurf_pending", { paths: paths || [] }),

    // --- intentionally unported (not needed in the Rust path) ---
    // the .ini IS the rulebook (classify reads it) — return it structured so Settings can
    // show the live values and the scan signature notices when you edit it
    getCssffConfig: () => invoke("cssff_config"),
    revealCssff: () => invoke("reveal_cssff"),
    exportFeedback: noop,
    exportGltf: (opts) => invoke("export_gltf", opts || {}),
    openGltfDir: () => invoke("open_gltf_dir"),
    exportDemopack: (favs, compress) => invoke("export_demopack", { favs: favs || [], compress: compress || "demo" }),
  };
})();
