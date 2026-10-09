# Sounds worth knowing

The loaded sounds list has every name; these are the ones that make genres. `s("name")` plays a sound, `s("name:3")` or `.n(3)` picks another sample of it. Drum machines are banks: `s("bd sd hh").bank("RolandTR909")`.

## Breaks (whole drum loops: fit them to the tempo, then chop)
- One bar long, so `s("breaks165").fit()` plays them in time: `breaks165` (a clean funk break, the best one to chop), `breaks125` (2), `breaks157`.
- `breaks152` is the amen break and is THREE bars long: `s("breaks152").slow(3).fit()`. Plain `.fit()` squeezes three bars into one and it plays three times too fast.
- Rearrange a one-bar break: `.slice(8, "0 1 2 3 4 5 6 7")` (8 eighths; reorder the numbers), `.chop(16)` for sixteenths, `.splice(8, "...")` to keep the pitch, `.cut(1)` so a slice stops when the next starts. Keep the order mostly intact: a break is a groove, not a random shuffle.
- `amencutup` (32 samples): the amen cut into single hits for building your own pattern, `n("0 2 4 6").s("amencutup")`.
- A break IS the drum kit. Do not lay another kick-and-snare pattern over a full break: they fight. Either the break alone (a kick or sub on its own downbeats at most), or your own kit with the break high-passed hard to keep only its hats and ghost notes: `.hpf(700).gain(.45)`.

## Drums
- Jungle and DnB: `jungle` (13: kicks, snares, hats, rides), `amencutup`, the breaks above, `hardkick`, `realclaps`.
- House and techno: banks `RolandTR909`, `RolandTR808`, `RolandTR707`; plain `house` (8), `techno` (7), `clubkick`, `909`, `808bd`, `808sd`, `808oh`, `808hc`.
- Hip-hop and boom bap: banks `AkaiMPC60`, `EmuSP12`, `LinnDrum`, `OberheimDMX`; `kicklinn`, `linnhats`.
- Hardcore and gabber: `gabba`, `gabbaloud`, `hardcore`, `rave`, `rave2`, `hoover` (the hoover stab).
- Plain kits: `bd`, `sd`, `hh`, `ho` (open hat), `cp`, `rm`, `lt`, `mt`, `ht`, `cr`. In banks the open hat is `oh` and the rimshot `rim`.

## Bass
- Synths, for any note: `sawtooth` (warm, filter it with `.lpf`), `square`, `triangle`, `sine` (sub bass), `supersaw` (several detuned saws: with `.detune(.3)` and a low `.lpf` it is a reese bass).
- Samples: `jungbass` (20, jungle subs), `jvbass` (13, synth bass), `bass1` (30), `bass3` (11), `bassdm`, `moog`.

## Chords, leads and texture
- `piano` (a sampled grand), `supersaw` (pads and trance leads), `triangle` and `square` (soft and hard leads), `sawtooth` (acid with `.lpf` sweeps and `.lpq`).
- Stabs and FX: `stab`, `hoover`, `rave`, `pad`, `padlong`, `arpy`, `pluck`, `juno`, `bleep`, `wobble`, `noise`, `wind`, `space`, `birds`.
- Orchestral and acoustic instruments from VCSL (sounds without a bank prefix, see the list).
- Voices: `speech`, `numbers`, `alphabet`, `yeah`, `miniyeah`.
