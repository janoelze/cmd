# Sound design

A bare `.s("sawtooth")` sounds like a test tone. Every part should be a designed sound: an envelope, a filter that moves, some saturation or width where it belongs, and a place in the mix. Use the patches below as the starting point for each part, then tune them to the request.

## Mixing rules
- Levels: kick `.gain(1)`, snare and break `.8`, bass `.6`-`.7`, sub `.6`, chords and pads `.15`-`.3`, leads `.3`-`.45`, hats and percussion `.3`-`.5`. Many parts at full gain clip and sound small.
- Low end: only the kick and the bass/sub go below 120 Hz. Everything else gets `.hpf(150)` or more (pads, leads, hats, breaks: `.hpf(200)` to `.hpf(400)`). Keep sub and kick centered (no `pan`, no `jux`, no `spread`).
- Sidechain: put the kick on its own orbit and duck the bass and pads under it, which makes a track pump and keeps the low end clean: the kick gets `.duckorbit("2:3").duckattack(.15).duckdepth(.8)`, the bass `.orbit(2)`, pads and chords `.orbit(3)`.
- Space: reverb and delay on pads, chords, leads, stabs and percussion, not on kick or sub. Give long reverbs their own orbit (`.orbit(3).room(.7).roomsize(6)`), so the drums stay dry.
- Width: hats and percussion `.pan(sine.range(.3, .7).fast(2))` or `.jux(rev)`; pads `.spread(.8)` with `supersaw`; leads `.chorus(.4)`.
- Glue: drums together through `.compressor("-18:4:6:.005:.1")`; a touch of `.distort(.2)`-`.distort(.6)` on bass and drums adds weight; `.coarse(4)` or `.crush(6)` for lo-fi grit.
- Movement: filters that move (`.lpf(sine.range(400, 2000).slow(8))`, `.lpenv(2)`), velocity variety on hats (`.gain(".5 .3 .4 .3")`), occasional variations (`.sometimesBy(.15, x => x.ply(2))`).

## Patches
Each is a part: put it in a `stack(...)`, change the notes, keep the sound.

Kick with weight: a drum machine kick with a pitched sine under it.
```
stack(
  s("bd*4").bank("RolandTR909").gain(1).distort(.3),
  note("a1*4").s("sine").penv(24).pdecay(.04).decay(.25).sustain(0).gain(.7),
)
```

808 bass: a sine that drops in pitch and rings, with saturation so it is heard on small speakers.
```
note("c2 ~ ~ c2 ~ ~ eb2 ~").s("sine").penv(12).pdecay(.05).decay(1.2).sustain(0).distort(.5).gain(.75)
```

Reese bass (DnB, dubstep): many detuned saws through a ladder filter, with a sine sub below.
```
stack(
  note("<d2 d2 bb1 c2>").s("supersaw").unison(7).detune(.6).ftype("ladder").lpf(sine.range(250, 900).slow(8)).lpq(3).distort(.7).hpf(60).gain(.55).orbit(2),
  note("<d2 d2 bb1 c2>").s("sine").gain(.6).orbit(2),
)
```

Acid line: a saw through a resonant ladder filter with an envelope per note; accents by filter depth.
```
note("c2 c2 c3 c2 eb2 c2 g2 [c2 c3]").s("sawtooth").ftype("ladder").lpf(300).lpq(14).lpenv("<4 2 6 3>").lpdecay(.15).lpsustain(0).decay(.2).sustain(.3).distort(.5).gain(.5)
```

Pluck: a short filter envelope on a saw; lovely with delay.
```
note("c4 eb4 g4 bb4 g4 eb4 c5 g4").s("sawtooth").lpf(400).lpenv(5).lpdecay(.12).lpsustain(0).decay(.3).sustain(0).delay(.4).delaytime(3/16).delayfeedback(.45).hpf(200).gain(.35)
```

Pad: wide supersaw chords, slow attack and release, filtered, a big room, ducked by the kick.
```
note("<[c3,eb3,g3,bb3] [ab2,c3,eb3,g3]>").s("supersaw").unison(5).spread(.9).detune(.25).attack(.8).release(3).lpf(1400).hpf(250).room(.7).roomsize(6).gain(.2).orbit(3)
```

Electric piano and bells: FM sines.
```
note("<[e3,g3,b3,d4] [a2,c3,e3,g3]>").s("sine").fmi(1.5).fmh(1).fmdecay(.6).fmsustain(.2).decay(1.5).sustain(.2).room(.4).hpf(150).gain(.35)
```

Lead: a detuned square with vibrato and chorus.
```
note("g4 ~ bb4 c5 ~ eb5 d5 ~").s("square").lpf(2500).vib(5).vibmod(.15).chorus(.4).delay(.3).delaytime(1/8).decay(.4).sustain(.6).hpf(250).gain(.3)
```

Hats with life: velocity and stereo movement.
```
s("hh*16").bank("RolandTR909").gain(".45 .25 .35 .25").pan(sine.range(.35, .65).fast(2)).hpf(6000).sometimesBy(.1, x => x.ply(2))
```

A break as the whole drum kit: one bar, fitted, sliced in order with one variation, glued (no other kick or snare on top).
```
s("breaks165").fit().slice(8, "0 1 2 3 4 5 <6 2> 7").cut(1).hpf(120).compressor("-20:4:6:.003:.08").distort(.2).gain(.8)
```

Riser and impact for transitions: filtered noise that opens over four bars.
```
s("white").lpf(saw.range(200, 8000).slow(4)).hpf(400).decay(4).sustain(1).gain(saw.range(0, .25).slow(4)).room(.6)
```
