# Genre cookbook

Starting points written for this app (each one plays as it is). Borrow the idioms, not the notes: a request for a genre should get a piece that sounds like the genre, with its own parts. Tempo is `setcpm(bpm / 4)` with four beats to a cycle.

Mini-notation traps: `"a b c d"` spreads four steps over one cycle (one bar); `"<a b>"` plays ONE of them per cycle (a over bar 1, b over bar 2), so `"<~ sd ~ sd>"` is a snare every other bar, not a backbeat; `"a ~ b ~"` is a sequence with rests; write sixteenths as 16 steps or `[...]` groups.

## Drum & bass (172-176 BPM)
The two-step: kick on 1 and the "and" of 3, snare on 2 and 4, over a chopped break; a sub or reese bass in long notes; pads above.
```
setcpm(174 / 4)

stack(
  // two-step kick and snare
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").bank("RolandTR909").gain(.9),
  // the amen, chopped and rearranged
  s("breaks152").fit().slice(16, "0 1 2 3 4 5 6 7 8 9 <10 2> 11 12 <13 13*2> 14 15").cut(1).gain(.7).hpf(200),
  // reese bass: detuned saws, filtered low
  note("<d1 d1 bb0 c1>").s("supersaw").detune(.35).lpf(500).lpq(4).distort(.5).gain(.7),
  // sub under it
  note("<d1 d1 bb0 c1>").s("sine").gain(.6),
  // pad, every other bar
  note("<[d3,f3,a3,c4] ~ [bb2,d3,f3,a3] ~>").s("supersaw").attack(.5).release(2).lpf(1500).room(.6).gain(.15),
)
```

## Jungle (160-170 BPM)
Busier, rolling breaks with variations, a deep sub, ragga stabs.
```
setcpm(165 / 4)

stack(
  s("breaks165").fit().chop(16).cut(1)
    .sometimesBy(.3, x => x.ply(2))
    .every(4, x => x.rev()),
  n("0 ~ ~ 0 ~ ~ 0 ~").s("jungbass").gain(.9),
  s("~ ~ stab ~").n("<0 3>").room(.4).gain(.5),
)
```

## Techno (125-135 BPM)
Four-on-the-floor, offbeat hats, a rumbling or hypnotic bass line, slow filter movement.
```
setcpm(130 / 4)

stack(
  s("bd*4").bank("RolandTR909"),
  s("~ hh ~ hh ~ hh ~ hh").bank("RolandTR909").gain(.6),
  s("~ ~ ~ ~ cp ~ ~ ~").bank("RolandTR909").room(.3),
  note("c2 c2 [c2 c3] c2").s("sawtooth").lpf(sine.range(300, 1500).slow(8)).lpq(10).decay(.15).sustain(0),
  s("~ rim ~ ~ ~ ~ rim ~").bank("RolandTR909").delay(.4).gain(.4),
)
```

## House (120-126 BPM)
Kick on every beat, claps on 2 and 4, shuffled hats, chord stabs and a bouncing bass.
```
setcpm(124 / 4)

stack(
  s("bd*4, ~ cp ~ cp").bank("RolandTR909"),
  s("[~ hh]*4").bank("RolandTR909").gain(".6 .4"),
  note("<[a3,c4,e4,g4] [d3,f3,a3,c4]>").s("piano").struct("~ x ~ x ~ ~ x ~").room(.4).gain(.6),
  note("<a1 d2>").struct("~ x ~ x x ~ x ~").s("sawtooth").lpf(800).decay(.2).sustain(0),
)
```

## Breakbeat and big beat (110-140 BPM)
A break played whole, a heavy kick under it, a squelchy bass.
```
setcpm(128 / 4)

stack(
  s("breaks125").fit().cut(1).gain(.8),
  s("bd ~ ~ bd ~ ~ bd ~").bank("RolandTR808").gain(1.1),
  note("e1 ~ e2 e1 ~ g1 ~ a1").s("sawtooth").lpf(600).lpq(12).decay(.2).sustain(0).distort(.6),
)
```

## Hip-hop and boom bap (85-95 BPM)
Swung, dusty drums, a sampled keys loop, space.
```
setcpm(90 / 4)

stack(
  s("bd ~ ~ bd ~ ~ bd ~, ~ ~ sd ~ ~ ~ sd ~").bank("AkaiMPC60"),
  s("hh*8").bank("AkaiMPC60").gain(".5 .3").swingBy(1/6, 4),
  note("<[e3,g3,b3,d4] [a2,c3,e3,g3]>").s("piano").slow(1).room(.5).lpf(2500).gain(.5),
  note("<e1 a1>").s("sine").gain(.7),
)
```

## Acid (125-135 BPM)
A 303 line: a sawtooth with a resonant filter that moves, accents and slides.
```
setcpm(128 / 4)

stack(
  s("bd*4").bank("RolandTR808"),
  note("c2 c2 c3 c2 eb2 c2 g2 c2").s("sawtooth")
    .lpf(sine.range(200, 2500).slow(4)).lpq(18).lpenv(2)
    .decay(.12).sustain(.2).distort(.4).gain(.6),
)
```

## Ambient (60-90 BPM, or none)
Long notes, slow movement, lots of room, sparse.
```
setcpm(70 / 4)

stack(
  note("<[c3,g3,e4] [a2,e3,c4] [f2,c3,a3] [g2,d3,b3]>").s("supersaw").attack(2).release(4).lpf(900).room(.9).gain(.25),
  note("c5 ~ g4 ~ e5 ~ ~ ~").s("triangle").slow(2).delay(.6).room(.8).gain(.2).degradeBy(.3),
  s("wind").gain(.2).slow(4),
)
```

## Making it change over time
- Bring parts in and out: `.mask("<0 0 1 1>")` (silent for two bars, then in), or build sections and play them in order: `arrange([8, intro], [16, drop], [8, breakdown])`.
- Vary every few bars: `.every(4, x => x.fast(2))`, `.sometimesBy(.2, x => x.ply(2))`, `"<a b c d>"` for one choice per bar.
- Move a filter or a level slowly: `.lpf(sine.range(400, 3000).slow(16))`, `.gain(saw.range(.2, .8).slow(8))`.
