// Real CS weapon + modifier killfeed icons (SVGs from the game files, sourced
// from github.com/Juknum/counter-strike-icons, bundled in assets/).
// Rendered as <img> data-URIs so each SVG's internal <style> stays isolated
// (inlining them collided on shared class names like ".st0").
// window.ICONS is filled by app.js at boot via api.getIcons().
(function () {
  window.ICONS = { weapons: {}, modifiers: {} };
  const KNIFE_RE = /knife|bayonet|karambit|daggers|bowie|butterfly|falchion|huntsman|shadow|ursus|navaja|stiletto|talon|skeleton|gut|flip|push|classic|nomad|paracord|cord|widowmaker|kukri|twinblade|canis|gypsy/i;
  const ALIAS = { m4a4: "m4a1", mp5navy: "mp5sd", usp: "usp_silencer", inc: "incgrenade" };
  const uriCache = {};

  function dataUri(svg) {
    if (uriCache[svg]) return uriCache[svg];
    const u = "data:image/svg+xml," + encodeURIComponent(svg);
    uriCache[svg] = u; return u;
  }
  function resolveWeapon(weapon) {
    let w = (weapon || "").toLowerCase().replace(/^weapon_/, "");
    if (ICONS.weapons[w]) return w;
    if (ALIAS[w] && ICONS.weapons[ALIAS[w]]) return ALIAS[w];
    if (KNIFE_RE.test(w) && ICONS.weapons.knife) return "knife";
    if (ICONS.weapons.world) return "world";
    return null;
  }

  window.weaponIcon = function (weapon) {
    const key = resolveWeapon(weapon);
    if (!key) return `<span class="wname">${String(weapon || "").replace(/[<>&]/g, "")}</span>`;
    return `<img class="wicon" src="${dataUri(ICONS.weapons[key])}" title="${weapon}" alt="${weapon}">`;
  };

  function mod(name, title) {
    return ICONS.modifiers[name] ? `<img class="micon" src="${dataUri(ICONS.modifiers[name])}" title="${title}" alt="${title}">` : "";
  }
  // modifier icons for a kill, in CS killfeed order (before the weapon)
  window.modifierIcons = function (k) {
    let out = "";
    if (k.telemetry && k.telemetry.airborneAtKill) out += mod("inairkill", "in air");
    if (k.noscope) out += mod("noscope", "no scope");
    if (k.penetrated > 0) out += mod("penetrate", "wallbang");
    if (k.smoke) out += mod("smoke_kill", "through smoke");
    if (k.blind) out += mod("blind_kill", "blind");
    return out;
  };
  window.headshotIcon = function () { return mod("icon_headshot", "headshot"); };
})();
