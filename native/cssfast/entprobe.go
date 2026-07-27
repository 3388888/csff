package main

// Two things about the entity stream can't be read off the demo: which ReadUBitVar
// flavour encodes the entity/prop index deltas, and which flag bit means
// SPROP_CHANGES_OFTEN (which decides the priority pass, and therefore every prop index).
// Both are probed on a slice of the demo and scored on what actually comes out: position
// samples with no prop-decode failures. A wrong guess produces zero usable frames, so the
// signal is unambiguous.

import (
	"fmt"
	"os"
)

func probeEntityLayout(data []byte, netProto int, mapName string, lay layout, previewStep int, dbg bool) (bool, bool, int, int) {
	first := netProto <= 8 // the 2004 engine's unary encoding
	bestEnt, bestProp, bestSerial, bestSkip, bestScore := first, first, 10, 0, -1

	for _, entUnary := range []bool{first, !first} {
		for _, propUnary := range []bool{first, !first} {
			for _, serial := range []int{10, 11, 12} {
				for skip := 0; skip <= 8; skip++ {
					p := newParser(data, netProto, mapName, lay, false)
					p.previewStep = previewStep
					p.unaryUBitVar = entUnary
					p.unaryPropUBitVar = propUnary
					p.serialBits = serial
					p.payloadSkip = skip
					p.maxPackets = 400
					p.run()
					if p.world == nil {
						continue
					}
					// frames are what we are after; prop failures mean the layout is wrong
					score := len(p.timeline)*10 - p.world.decodeFail
					if dbg && score > 0 {
						fmt.Fprintf(os.Stderr, "  probe entVar=%-5v propVar=%-5v serial=%-2d skip=%d frames=%-5d propOK=%-6d propFail=%-6d score=%d\n",
							entUnary, propUnary, serial, skip, len(p.timeline), p.world.decodeOK, p.world.decodeFail, score)
					}
					if score > bestScore {
						bestScore, bestEnt, bestProp, bestSerial, bestSkip = score, entUnary, propUnary, serial, skip
					}
					if len(p.timeline) > 0 && p.world.decodeFail == 0 {
						return bestEnt, bestProp, bestSerial, bestSkip // clean decode, stop probing
					}
				}
			}
		}
	}
	return bestEnt, bestProp, bestSerial, bestSkip
}
