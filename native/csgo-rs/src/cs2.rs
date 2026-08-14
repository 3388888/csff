// CS2 (Source 2 / PBDEMS2) path — opt-in behind the `cs2` cargo feature, via LaihoE's
// demoparser. Kept behind a feature so the default CS:GO+CS:S binary stays zero-dep.
// NOTE: untested locally (no CS2 demos available); CDH_DEBUG dumps player_death field names.

use ahash::AHashMap;
use parser::first_pass::parser_settings::ParserInputs;
use parser::parse_demo::{Parser, ParsingMode};
use parser::second_pass::parser_settings::create_huffman_lookup_table;
use parser::second_pass::variants::Variant;

#[derive(Default, Clone)]
pub struct Cs2Kill {
    pub attacker: String,
    pub victim: String,
    pub weapon: String,
    pub headshot: bool,
    pub tick: i32,
    pub round: i32,
}

pub struct Cs2Result {
    pub kills: Vec<Cs2Kill>,
}

fn str_of(v: &Variant, dst: &mut String) {
    if let Variant::String(s) = v {
        *dst = s.clone();
    }
}

pub fn parse(data: &[u8], debug: bool) -> Option<Cs2Result> {
    let huf = create_huffman_lookup_table();
    let settings = ParserInputs {
        real_name_to_og_name: AHashMap::default(),
        wanted_players: vec![],
        wanted_player_props: vec![],
        wanted_other_props: vec![],
        wanted_prop_states: AHashMap::default(),
        wanted_events: vec!["player_death".to_string(), "round_start".to_string()],
        parse_ents: true,
        wanted_ticks: vec![],
        parse_projectiles: false,
        parse_grenades: false,
        only_header: false,
        list_props: false,
        only_convars: false,
        huffman_lookup_table: &huf,
        order_by_steamid: false,
        fallback_bytes: None,
    };
    let mut p = Parser::new(settings, ParsingMode::Normal);
    let out = p.parse_demo(data).ok()?;

    let mut kills = Vec::new();
    let mut round_ticks: Vec<i32> = Vec::new();
    let mut dumped = false;
    for ev in out.game_events {
        if ev.name == "round_start" {
            let t = ev
                .fields
                .iter()
                .find(|f| f.name == "tick")
                .and_then(|f| f.data.as_ref())
                .and_then(|v| if let Variant::I32(n) = v { Some(*n) } else { None })
                .unwrap_or(0);
            round_ticks.push(t);
            continue;
        }
        if ev.name != "player_death" {
            continue;
        }
        if debug && !dumped {
            dumped = true;
            let names: Vec<String> = ev.fields.iter().map(|f| f.name.clone()).collect();
            eprintln!("  [debug] CS2 player_death fields: {names:?}");
        }
        let mut k = Cs2Kill::default();
        for f in &ev.fields {
            let v = match &f.data {
                Some(x) => x,
                None => continue,
            };
            match f.name.as_str() {
                "attacker_name" | "attacker" => str_of(v, &mut k.attacker),
                "user_name" | "victim_name" | "victim" => str_of(v, &mut k.victim),
                "weapon" => str_of(v, &mut k.weapon),
                "headshot" => {
                    if let Variant::Bool(b) = v {
                        k.headshot = *b
                    }
                }
                "tick" => {
                    if let Variant::I32(n) = v {
                        k.tick = *n
                    }
                }
                _ => {}
            }
        }
        if !k.attacker.is_empty() && k.attacker != k.victim {
            kills.push(k);
        }
    }
    // CS2 player_death has no round field — derive it from round_start boundaries
    round_ticks.sort_unstable();
    for k in kills.iter_mut() {
        k.round = round_ticks.partition_point(|&t| t <= k.tick) as i32;
    }
    Some(Cs2Result { kills })
}
