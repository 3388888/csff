package main

// Last-resort name recovery.
//
// Players who were already connected when the recording started never fire
// player_connect, so their names only exist in the signon userinfo table — whose
// encoding shifts between engine branches. Instead of decoding it, we anchor on the
// one unmistakable landmark inside every player_info_t: the "STEAM_" / "BOT" guid.
// player_info_t is  [...xuid?] name[32] userID(int, network order) guid[33] ...
// so the name sits 36 bytes before the guid. Everything is bit-packed, hence the
// eight shifted passes.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
)

func (p *parser) scanPlayerInfo() {
	data := p.data
	if len(data) > 96<<20 {
		data = data[:96<<20]
	}
	buf := make([]byte, len(data))
	for shift := 0; shift < 8; shift++ {
		if shift == 0 {
			copy(buf, data)
		} else {
			for i := 0; i+1 < len(data); i++ {
				buf[i] = data[i]>>uint(shift) | data[i+1]<<uint(8-shift)
			}
		}
		for _, anchor := range []string{"STEAM_", "BOT"} {
			from := 0
			for {
				i := indexFrom(buf, anchor, from)
				if i < 0 {
					break
				}
				from = i + 1
				if i < 40 {
					continue
				}
				for _, back := range []int{36, 40} { // guid offset relative to the name field
					off := i - back
					if off < 0 {
						continue
					}
					name := cstr(buf[off : off+32])
					if !printableName(name) || !zeroPadded(buf[off:off+32], len(name)) {
						continue
					}
					uid := int(binary.BigEndian.Uint32(buf[off+32 : off+36]))
					if uid <= 0 || uid > 65535 {
						uid = int(binary.LittleEndian.Uint32(buf[off+32 : off+36]))
					}
					if uid <= 0 || uid > 65535 {
						continue
					}
					if _, dup := p.names[uid]; !dup {
						p.names[uid] = name
						if p.dbg {
							fmt.Fprintf(os.Stderr, "  scanned name uid=%d %q (shift %d)\n", uid, name, shift)
						}
					}
					break
				}
			}
		}
	}
}

func indexFrom(b []byte, s string, from int) int {
	if from >= len(b) {
		return -1
	}
	i := bytes.Index(b[from:], []byte(s))
	if i < 0 {
		return -1
	}
	return from + i
}

func zeroPadded(b []byte, n int) bool {
	for i := n; i < len(b); i++ {
		if b[i] != 0 {
			return false
		}
	}
	return true
}
