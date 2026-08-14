// cssff.rs — read cssff_settings.ini and turn it into the classify rulebook, exactly like
// the JS cssffcfg.js. The .ini is the law: [General] holds defaults, each weapon-category
// section (Rifles, Snipers, Deagle, Knife, Pistols, Smgs, Shotguns, AutoSnipers, Scout,
// Glock, Deagle…) overrides them. Lookup order: category → [General] → built-in fallback.

use std::collections::HashMap;

#[derive(Clone)]
enum Val {
    Bool(bool),
    Num(f32),
    #[allow(dead_code)]
    Str(String),
}

pub struct Cfg {
    general: HashMap<String, Val>,
    sections: HashMap<String, HashMap<String, Val>>,
}

fn parse_val(s: &str) -> Val {
    let t = s.trim();
    let lt = t.to_lowercase();
    if lt == "true" || lt == "yes" {
        return Val::Bool(true);
    }
    if lt == "false" || lt == "no" {
        return Val::Bool(false);
    }
    if let Ok(n) = t.parse::<f32>() {
        return Val::Num(n);
    }
    Val::Str(t.to_string())
}

impl Cfg {
    pub fn load(path: &str) -> Option<Cfg> {
        let text = std::fs::read_to_string(path).ok()?;
        Some(Cfg::parse(&text))
    }
    pub fn parse(text: &str) -> Cfg {
        let mut general = HashMap::new();
        let mut sections: HashMap<String, HashMap<String, Val>> = HashMap::new();
        let mut cur: Option<String> = None; // None = [General]
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if let Some(sec) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                let name = sec.trim();
                cur = if name.eq_ignore_ascii_case("general") {
                    None
                } else {
                    sections.entry(name.to_string()).or_default();
                    Some(name.to_string())
                };
                continue;
            }
            if let Some(eq) = line.find('=') {
                if eq >= 1 {
                    let k = line[..eq].trim().to_string();
                    let v = parse_val(&line[eq + 1..]);
                    match &cur {
                        None => {
                            general.insert(k, v);
                        }
                        Some(s) => {
                            sections.get_mut(s).unwrap().insert(k, v);
                        }
                    }
                }
            }
        }
        Cfg { general, sections }
    }

    fn get<'a>(&'a self, key: &str, cat: Option<&str>) -> Option<&'a Val> {
        if let Some(c) = cat {
            if let Some(sec) = self.sections.get(c) {
                if let Some(v) = sec.get(key) {
                    return Some(v);
                }
            }
        }
        self.general.get(key)
    }
    fn num(&self, key: &str, cat: Option<&str>, fb: f32) -> f32 {
        match self.get(key, cat) {
            Some(Val::Num(n)) => *n,
            _ => fb,
        }
    }
    fn boolean(&self, key: &str, cat: Option<&str>, fb: bool) -> bool {
        match self.get(key, cat) {
            Some(Val::Bool(b)) => *b,
            Some(Val::Num(n)) => *n != 0.0,
            _ => fb,
        }
    }
}

// Resolved rules for one weapon category. Index [0]=3k,[1]=4k,[2]=5k; collat [0]=2..[3]=5.
#[allow(dead_code)]
pub struct Rules {
    pub max_time: [f32; 3],
    pub extra_per_special: [f32; 3],
    pub min_hs: [i32; 3],
    pub must_special: [bool; 3],
    pub tick: [bool; 3],
    pub slow: [f32; 3],
    pub collat_tick: [bool; 4],
    pub collat_min_hs: [i32; 4],
    pub collat_special_ignores: [bool; 4],
    pub noscope_dist: f32,
    pub noscope_hs_mod: f32,
    pub noscope_wb_mod: f32,
    pub noscope_tick: bool,
    pub jump_dist: f32,
    pub jump_hs_mod: f32,
    pub jump_wb_mod: f32,
    pub jump_tick: bool,
    pub flick_dist: f32,
    pub flick_angle_mod: f32,
    pub flick_hs_only: bool,
    pub flick_tick: bool,
    pub wallbang_tick: bool,
    pub wallbang_hs_only: bool,
    pub wallbang_require_two: bool,
    pub wallbang_pair_window: f32,
    pub util_kills: bool,
    pub vs_bots: bool,
    pub by_bots: bool,
}

pub fn rules(cfg: Option<&Cfg>, cat: Option<&str>) -> Rules {
    // when there's no cfg, use the same defaults the JS rules() falls back to
    let num = |k: &str, fb: f32| cfg.map(|c| c.num(k, cat, fb)).unwrap_or(fb);
    let boolean = |k: &str, fb: bool| cfg.map(|c| c.boolean(k, cat, fb)).unwrap_or(fb);
    Rules {
        max_time: [num("3k_max_time", 2.0), num("4k_max_time", 6.5), num("5k_max_time", 13.0)],
        extra_per_special: [
            num("3k_special_kill_extra_max_time", 0.0),
            num("4k_special_kill_extra_max_time", 0.0),
            num("5k_special_kill_extra_max_time", 0.0),
        ],
        min_hs: [
            num("3k_min_headshots", 0.0) as i32,
            num("4k_min_headshots", 0.0) as i32,
            num("5k_min_headshots", 0.0) as i32,
        ],
        must_special: [
            boolean("3k_must_include_special_kill", false),
            boolean("4k_must_include_special_kill", false),
            boolean("5k_must_include_special_kill", false),
        ],
        tick: [
            boolean("tick_3ks", true),
            boolean("tick_4ks", true),
            boolean("tick_5ks", true),
        ],
        slow: [
            if boolean("tick_slow_stationary_3ks", false) { num("slow_3k_max_range", 0.0) } else { 0.0 },
            if boolean("tick_slow_stationary_4ks", false) { num("slow_4k_max_range", 0.0) } else { 0.0 },
            if boolean("tick_slow_stationary_5ks", false) { num("slow_5k_max_range", 0.0) } else { 0.0 },
        ],
        collat_tick: [
            boolean("tick_doubles", true),
            boolean("tick_triples", true),
            boolean("tick_quadros", true),
            boolean("tick_pentas", true),
        ],
        collat_min_hs: [
            num("double_min_headshots", 0.0) as i32,
            num("triple_min_headshots", 0.0) as i32,
            num("quadro_min_headshots", 0.0) as i32,
            num("penta_min_headshots", 0.0) as i32,
        ],
        collat_special_ignores: [
            boolean("special_double_ignores_min_hs", true),
            boolean("special_triple_ignores_min_hs", true),
            boolean("special_quadro_ignores_min_hs", true),
            boolean("special_penta_ignores_min_hs", true),
        ],
        noscope_dist: num("noscope_min_distance", 2000.0),
        noscope_hs_mod: num("noscope_min_distance_hs_modifier", 1.0),
        noscope_wb_mod: num("noscope_min_distance_wb_modifier", 1.0),
        noscope_tick: boolean("tick_noscopes", true),
        jump_dist: num("jumpshot_min_distance", 800.0),
        jump_hs_mod: num("jumpshot_min_distance_hs_modifier", 1.0),
        jump_wb_mod: num("jumpshot_min_distance_wb_modifier", 1.0),
        jump_tick: boolean("tick_jumpshots", true),
        flick_dist: num("flickshot_min_distance", 120.0),
        flick_angle_mod: num("flickshot_min_angle_modifier", 1.0),
        flick_hs_only: boolean("flickshot_headshot_only", false),
        flick_tick: boolean("tick_flickshots", true),
        wallbang_tick: boolean("tick_wallbangs", false),
        wallbang_hs_only: boolean("wallbang_headshot_only", true),
        wallbang_require_two: boolean("wallbang_require_two", false),
        wallbang_pair_window: num("wallbang_another_wallbang_max_delta_time", 4.0),
        util_kills: boolean("tick_flash_smoke_kills", true),
        vs_bots: boolean("tick_frags_vs_bots", true),
        by_bots: boolean("tick_frags_by_bots", true),
    }
}
