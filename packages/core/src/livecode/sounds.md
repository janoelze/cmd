# Sounds worth knowing

The loaded sounds list has every name; these are the ones that make genres. `s("name")` plays a sound, `s("name:3")` or `.n(3)` picks another sample of it. Drum machines are banks: `s("bd sd hh").bank("RolandTR909")`.

## Breaks (whole drum loops: fit them to the tempo, then chop)
- `breaks165`: a full break at 165 BPM. `breaks152`: the amen break at 152 BPM. `breaks157`: a funk break at 157 BPM. `breaks125` (2 samples): slower breaks.
- Play one in time: `s("breaks165").fit()` stretches it to a cycle; `.chop(16)` or `.slice(8, "0 1 2 3 ...")` cuts it into hits to rearrange; `.splice(8, "...")` slices and keeps the pitch; `.cut(1)` stops each slice when the next starts.
- `amencutup` (32 samples): the amen break cut into single hits, `n("0 .. 31")` picks them: `n("0 1 2 3 4 5 6 7").s("amencutup")`.

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
