# Strudel reference

Every function a pattern can use (@strudel/reference 1.2.2). `name(params)`, aliases in brackets, what it does, an example.

## add()
Assumes a pattern of numbers. Adds the given number to each item in the pattern.
```
// Here, the triad 0, 2, 4 is shifted by different amounts
n("0 2 4".add("<0 3 4 0>")).scale("C:major")
// Without add, the equivalent would be:
// n("<[0 2 4] [3 5 7] [4 6 8] [0 2 4]>").scale("C:major")
```

## addVoicings(name, dictionary, range)
Adds a new custom voicing dictionary.
- name: identifier for the voicing dictionary
- dictionary: maps chord symbol to possible voicings
- range: min, max note
```
addVoicings('cookie', {
  7: ['3M 7m 9M 12P 15P', '7m 10M 13M 16M 19P'],
  '^7': ['3M 6M 9M 12P 14M', '7M 10M 13M 16M 19P'],
  m7: ['8P 11P 14m 17m 19P', '5P 8P 11P 14m 17m'],
  m7b5: ['3m 5d 8P 11P 14m', '5d 8P 11P 14m 17m'],
  o7: ['3m 6M 9M 11A 15P'],
  '7alt': ['3M 7m 10m 13m 15P'],
  '7#11': ['7m 10m 13m 15P 17m'],
}, ['C3', 'C6'])
"<C^7 A7 Dm7 G7>".voicings('cookie').note()
```

## adsr(time, time, gain, time)
ADSR envelope: Combination of Attack, Decay, Sustain, and Release.
- time: attack time in seconds
- time: decay time in seconds
- gain: sustain level (0 to 1)
- time: release time in seconds
```
note("[c3 bb2 f3 eb3]*2").sound("sawtooth").lpf(600).adsr(".1:.1:.5:.2")
```

## aliasBank(bank, alias)
Register an alias for a bank of sounds. Optionally accepts a single argument map of bank aliases. Optionally accepts a single argument string of a path to a JSON file containing bank aliases.
- bank: The bank to alias
- alias: The alias to use for the bank

## allTransforms()
Applies a function to all the running patterns. Note that the patterns are groups together into a single `stack` before the function is applied. This is probably what you want, but see `each` for a version that applies the function to each pattern separately. $: sound("bd - cp sd") $: sound("hh*8") all(fast("<2 3>")) $: sound("bd - cp sd") $: sound("hh*8") all(x => x.pianoroll())

## almostAlways()
Shorthand for `.sometimesBy(0.9, fn)`
```
s("hh*8").almostAlways(x=>x.speed("0.5"))
```

## almostNever()
Shorthand for `.sometimesBy(0.1, fn)`
```
s("hh*8").almostNever(x=>x.speed("0.5"))
```

## always()
Shorthand for `.sometimesBy(1, fn)` (always calls fn)
```
s("hh*8").always(x=>x.speed("0.5"))
```

## amp(amount)
Like `gain`, but linear.
- amount: gain.
```
s("bd*8").amp(".1*2 .5 .1*2 .5 .1 .5").osc()
```

## anchor(anchorNote)
The top note to align the voicing to. Defaults to c5
- anchorNote: the note to align the voicings to
```
anchor("<c4 g4 c5 g5>").chord("C").voicing()
```

## appBoth(pat_val)
When this method is called on a pattern of functions, it matches its haps with those in the given pattern of values. A new pattern is returned, with each matching value applied to the corresponding function. In this `_appBoth` variant, where timespans of the function and value haps are not the same but do intersect, the resulting hap has a timespan of the intersection. This applies to both the part and the whole timespan.

## appLeft(pat_val)
As with `appBoth`, but the `whole` timespan is not the intersection, but the timespan from the function of patterns that this method is called on. In practice, this means that the pattern structure, including onsets, are preserved from the pattern of functions (often referred to as the left hand or inner pattern).

## apply()
Like layer, but with a single function:
```
"<c3 eb3 g3>".scale('C minor').apply(scaleTranspose("0,2,4")).note()
```

## applyGradualLowpass(input, lpFreqStart, lpFreqEnd, lpFreqEndAt, callback)
Applies a constantly changing lowpass filter to the given sound.
- callback: May be called immediately within the current execution context, or later.

## applyHannWindow()
Apply Hann window in-place

## appRight(pat_val)
As with `appLeft`, but `whole` timespans are instead taken from the pattern of values, i.e. structure is preserved from the right hand/outer pattern.

## appWhole(whole_func, func)
Assumes 'this' is a pattern of functions, and given a function to resolve wholes, applies a given pattern of values to that pattern of functions.

## arp()
Selects indices in in stacked notes.
```
note("<[c,eb,g]!2 [c,f,ab] [d,f,ab]>")
.arp("0 [0,2] 1 [0,2]")
```

## arpWith()
Selects indices in in stacked notes.
```
note("<[c,eb,g]!2 [c,f,ab] [d,f,ab]>")
.arpWith(haps => haps[2])
```

## arrange()
Allows to arrange multiple patterns together over multiple cycles. Takes a variable number of arrays with two elements specifying the number of cycles and the pattern to use.
```
arrange(
  [4, "<c a f e>(3,8)"],
  [2, "<g a>(5,8)"]
).note()
```

## as(mapping)
Sets properties in a batch.
- mapping: the control names that are set
```
"c:.5 a:1 f:.25 e:.8".as("note:clip")
```

## asym(distortion, volume)
Asymmetrical diode distortion
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## attack(attack) [att]
Amplitude envelope attack time: Specifies how long it takes for the sound to reach its peak value, relative to the onset.
- attack: time in seconds.
```
note("c3 e3 f3 g3").attack("<0 .1 .5>")
```

## bank(bank)
Select the sound bank to use. To be used together with `s`. The bank name (+ "_") will be prepended to the value of `s`.
- bank: the name of the bank
```
s("bd sd [~ bd] sd").bank('RolandTR909') // = s("RolandTR909_bd RolandTR909_sd")
```

## beat()
creates a structure pattern from divisions of a cycle especially useful for creating rhythms
```
s("bd").beat("0,7,10", 16)
```

## begin(amount)
A pattern of numbers from 0 to 1. Skips the beginning of each sample, e.g. `0.25` to cut off the first quarter from each sample.
- amount: between 0 and 1, where 1 is the length of the sample
```
samples({ rave: 'rave/AREUREADY.wav' }, 'github:tidalcycles/dirt-samples')
s("rave").begin("<0 .25 .5 .75>").fast(2)
```

## berlin()
Generates a continuous pattern of [berlin noise](conceived by Jame Coyne and Jade Rowland as a joke but turned out to be surprisingly cool and useful, like perlin noise but with sawtooth waves), in the range 0..1.
```
// ascending arpeggios
n("0!16".add(berlin.fast(4).mul(14))).scale("d:minor")
```

## binary(n)
Creates a binary pattern from a number.
- n: input number to convert to binary
```
"hh".s().struct(binary(5))
// "hh".s().struct("1 0 1")
```

## binaryL(n)
Creates a binary list pattern from a number.
- n: input number to convert to binary s("saw").seg(8) .partials(binaryL(irand(4096).add(1)))

## binaryN(n, nBits)
Creates a binary pattern from a number, padded to n bits long.
- n: input number to convert to binary
- nBits: pattern length, defaults to 16
```
"hh".s().struct(binaryN(55532, 16))
// "hh".s().struct("1 1 0 1 1 0 0 0 1 1 1 0 1 1 0 0")
```

## binaryNL(n, nBits)
Creates a binary list pattern from a number, padded to n bits long.
- n: input number to convert to binary
- nBits: pattern length, defaults to 16

## bite(number, slices)
Splits a pattern into the given number of slices, and plays them according to a pattern of slice numbers. Similar to `slice`, but slices up patterns rather than sound samples.
- number: of slices
- slices: to play
```
note("0 1 2 3 4 5 6 7".scale('c:mixolydian'))
.bite(4, "3 2 1 0")
```

## bmod(config, config.bus, config.control, config.subControl, config.depth, config.depthabs, config.dc, config.fxi, id)
Modulates with the output from a given `bus`. Can be called in sequence like pat.bmod(...).bmod(...) to set up multiple modulators Send to an audio bus with `otherPat.bus(..)`. There are two ways to declare which control will be modulated: Explicitly put `control` in the config (e.g. `bmod({ id: 2, c: "lpf" })`) If the control parameter is absent, the control immediately before the `bmod` call will be used (e.g. `s("saw").lpf(500).bmod({ id: 2 })` to modulate `lpf`) Modulators can be referred to by `id` so that they can be updated later e.g. inside a `sometimes`. See example below.
- config: Bus modulation configuration.
- config.bus: Bus to get modulation signal from
- config.control: Node to modulate. Aliases: c
- config.subControl: Sub-control name to append to the control key. Aliases: sc
- config.depth: Relative modulation depth. Aliases: dep, dr
- config.depthabs: Absolute modulation depth. Aliases: da
- config.dc: DC offset prior to application
- config.fxi: FX index to target
- id: ID to use for this modulator
```
modulator: s("one").seg(64).gain(slider(0, 0, 1)).bus(1).dry(0)
carrier: s("saw").bmod({ b: 1 })
```

## bpattack(attack) [bpa]
Sets the attack duration for the bandpass filter envelope.
- attack: time of the bandpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.bpf(500)
.bpa("<.5 .25 .1 .01>/4")
.bpenv(4)
```

## bpdc(dcoffset)
DC offset of the LFO for the bandpass filter
- dcoffset: dc offset. set to 0 for unipolar

## bpdecay(decay) [bpd]
Sets the decay duration for the bandpass filter envelope.
- decay: time of the bandpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.bpf(500)
.bpd("<.5 .25 .1 0>/4")
.bps(0.2)
.bpenv(4)
```

## bpdepth(depth)
Depth of the LFO for the bandpass filter
- depth: depth of modulation

## bpdepthfrequency(depth) [bpdepthfreq]
Depth of the LFO for the bandpass filter, in HZ
- depth: depth of modulation
```
note("<c c c# c c c4>*16").s("sawtooth").lpf(600).bpdepthfrequency("<200 500 100 0>")
```

## bpenv(modulation) [bpe]
Sets the bandpass filter envelope modulation depth.
- modulation: depth of the bandpass filter envelope between 0 and n
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.bpf(500)
.bpa(.5)
.bpenv("<4 2 1 0 -1 -2 -4>/4")
```

## bpf(frequency) [bandf, bp]
Sets the center frequency of the band-pass filter. When using mininotation, you can also optionally supply the 'bpq' parameter separated by ':'.
- frequency: center frequency
```
s("bd sd [~ bd] sd,hh*6").bpf("<1000 2000 4000 8000>")
```

## bpq(q) [bandq]
Sets the band-pass q-factor (resonance).
- q: q factor
```
s("bd sd [~ bd] sd").bpf(500).bpq("<0 1 2 3>")
```

## bprate(rate)
Rate of the LFO for the bandpass filter
- rate: rate in hertz

## bprelease(release) [bpr]
Sets the release time for the bandpass filter envelope.
- release: time of the bandpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.clip(.5)
.bpf(500)
.bpenv(4)
.bpr("<.5 .25 .1 0>/4")
.release(.5)
```

## bpshape(shape)
Shape of the LFO for the bandpass filter
- shape: Shape of the lfo (0, 1, 2, ..)

## bpskew(skew)
Skew of the LFO for the bandpass filter
- skew: How much to bend the LFO shape

## bpsustain(sustain) [bps]
Sets the sustain amplitude for the bandpass filter envelope.
- sustain: amplitude of the bandpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.bpf(500)
.bpd(.5)
.bps("<0 .25 .5 1>/4")
.bpenv(4)
```

## bpsync(rate)
Cycle-synced rate of the LFO for the bandpass filter
- rate: rate in cycles

## brak()
Returns a new pattern where every other cycle is played once, twice as fast, and offset in time by one quarter of a cycle. Creates a kind of breakbeat feel.

## brand()
A continuous pattern of 0 or 1 (binary random)
```
s("hh*10").pan(brand)
```

## brandBy(probability)
A continuous pattern of 0 or 1 (binary random), with a probability for the value being 1
- probability: a number between 0 and 1
```
s("hh*10").pan(brandBy(0.2))
```

## bus(number)
A `bus` is a send which can be used for mixing patterns. It combines with.. s("bus") to play that bus through another pattern (for, say, applying non-linear effects like distortion to multiple signals) otherPat.bmod(..) (to modulate another pattern with the bus)

## busgain(number) [bgain]
Postgain multiplier prior to sending the signal to the audio bus.

## byteBeatExpression(byteBeatExpression) [bbexpr]
Create byte beats with custom expressions
- byteBeatExpression: bitwise expression for creating bytebeat
```
s("bytebeat").bbexpr('t*(t>>15^t>>66)')
```

## byteBeatStartTime(byteBeatStartTime) [bbst]
Create byte beats with custom expressions
- byteBeatStartTime: in samples (t)
```
note("c3!8".add("{0 0 12 0 7 5 3}%8")).s("bytebeat:5").bbst("<3 1>".mul(10000))._scope()
```

## cat(items) [slowcat]
The given items are concatenated, where each one takes one cycle.
- items: The items to concatenate
```
cat("e5", "b4", ["d5", "c5"]).note()
// "<e5 b4 [d5 c5]>".note()
```

## ceil()
Assumes a numerical pattern. Returns a new pattern with all values set to their mathematical ceiling. E.g. `3.2` replaced with `4`, and `-4.2` replaced with `-4`.
```
note("42 42.1 42.5 43".ceil())
```

## channel(channel)
Choose the channel the pattern is sent to in superdirt
- channel: channel number

## channels(channels) [ch]
Allows you to set the output channels on the interface
- channels: pattern the output channels
```
note("e a d b g").channels("3:4")
```

## chebyshev(distortion, volume)
Distortion via Chebyshev polynomials
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## choose(xs)
Chooses randomly from the given list of elements.
- xs: values / patterns to choose from.
```
note("c2 g2!2 d2 f1").s(choose("sine", "triangle", "bd:6"))
```

## choose2(xs)
As with choose, but the pattern that this method is called on should be in the range -1 .. 1

## chooseCycles() [randcat]
Picks one of the elements at random each cycle.
```
chooseCycles("bd", "hh", "sd").s().fast(8)
```

## chooseInWith(pat, xs)
As with {chooseWith}, but the structure comes from the chosen values, rather than the pattern you're using to choose with.

## chooseWith(pat, xs)
Choose from the list of values (or patterns of values) using the given pattern of numbers, which should be in the range of 0..1
```
note("c2 g2!2 d2 f1").s(chooseWith(sine.fast(2), ["sawtooth", "triangle", "bd:6"]))
```

## chop()
Cuts each sample into the given number of parts, allowing you to explore a technique known as 'granular synthesis'. It turns a pattern of samples into a pattern of parts of samples.
```
samples({ rhodes: 'https://cdn.freesound.org/previews/132/132051_316502-lq.mp3' })
s("rhodes")
 .chop(4)
 .rev() // reverse order of chops
 .loopAt(2) // fit sample into 2 cycles
```

## chord(symbols)
The chord to voice
- symbols: chord symbols to voice e.g., C, Eb, Fm7, G7. The symbols can be defined via addVoicings
```
chord("<Am C D F Am E Am E>").voicing()
```

## chorus(chorus)
mix control for the chorus effect
- chorus: mix amount between 0 and 1
```
note("d d a# a").s("sawtooth").chorus(.5)
```

## chunk() [slowChunk, slowchunk]
Divides a pattern into a given number of parts, then cycles through those parts in turn, applying the given function to each part in turn (one part per cycle).
```
"0 1 2 3".chunk(4, x=>x.add(7))
.scale("A:minor").note()
```

## chunkBack() [chunkback]
Like `chunk`, but cycles through the parts in reverse order. Known as chunk' in tidalcycles
```
"0 1 2 3".chunkBack(4, x=>x.add(7))
.scale("A:minor").note()
```

## chunkBackInto() [chunkbackinto]
Like `chunkInto`, but moves backwards through the chunks.
```
sound("bd sd ht lt bd - cp lt").chunkInto(4, hurry(2))
  .bank("tr909")
```

## chunkInto() [chunkinto]
Like `chunk`, but the function is applied to a looped subcycle of the source pattern.
```
sound("bd sd ht lt bd - cp lt").chunkInto(4, hurry(2))
  .bank("tr909")
```

## chyx()
BYTE BEATS

## clip(factor) [legato]
Multiplies the duration with the given number. Also cuts samples off at the end if they exceed the duration.
- factor: = 0
```
note("c a f e").s("piano").clip("<.5 1 2>")
```

## coarse(factor)
Fake-resampling for lowering the sample rate. Caution: This effect seems to only work in chromium based browsers
- factor: 1 for original 2 for half, 3 for a third and so on.
```
s("bd sd [~ bd] sd,hh*8").coarse("<1 4 8 16 32>")
```

## color(color) [colour]
Sets the color of the hap in visualizations like pianoroll or highlighting.
- color: Hexadecimal or CSS color name

## compress()
Compress each cycle into the given timespan, leaving a gap
```
cat(
  s("bd sd").compress(.25,.75),
  s("~ bd sd ~")
)
```

## compressor()
Dynamics Compressor. The params are `compressor("threshold:ratio:knee:attack:release")` More info here
```
s("bd sd [~ bd] sd,hh*8")
.compressor("-20:20:10:.002:.02")
```

## computeMagnitudes()
Compute squared magnitudes for peak finding

## contract()
Experimental Contracts the step size of the pattern by the given factor. See also `expand`.
```
sound("tha dhi thom nam").bank("mridangam").contract("3 2 1 1 2 3").pace(8)
```

## cosine()
A cosine signal between 0 and 1.
```
n(stack(sine,cosine).segment(16).range(0,15))
.scale("C:minor")
```

## cosine2()
A cosine signal between -1 and 1 (like `cosine`, but bipolar).

## cpm()
Plays the pattern at the given cycles per minute.
```
s("<bd sd>,hh*2").cpm(90) // = 90 bpm
```

## crush(depth)
Bit crusher effect.
- depth: between 1 (for drastic reduction in bit-depth) to 16 (for barely no reduction).
```
s("<bd sd>,hh*3").fast(2).crush("<16 8 7 6 5 4 3 2>")
```

## cubic(distortion, volume)
Cubic polynomial distortion
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## cut(group)
In the style of classic drum-machines, `cut` will stop a playing sample as soon as another samples with in same cutgroup is to be played. An example would be an open hi-hat followed by a closed one, essentially muting the open.
- group: cut group number
```
s("[oh hh]*4").cut(1)
```

## cyclesPer()
A pattern measuring the duration of events, in cycles per event. `cyclesPer` doesn't have structure itself, but takes structure, and therefore event durations, from the pattern that it is combined with. For example `cyclesPer.struct("1 1 [1 1] 1")` would give the same as `"0.25 0.25 [0.125 0.125] 0.25"`. See also its reciprocal, `per`, also known as `perCycle`.
```
// Shorter events are lower in pitch
sound("saw saw [saw saw] saw")
  .note(cyclesPer.range(50, 100))
```

## decay(time) [dec]
Amplitude envelope decay time: the time it takes after the attack time to reach the sustain level. Note that the decay is only audible if the sustain value is lower than 1.
- time: decay time in seconds
```
note("c3 e3 f3 g3").decay("<.1 .2 .3 .4>").sustain(0)
```

## defragmentHaps()
Combines adjacent haps with the same value and whole. Only intended for use in tests.

## degrade()
Randomly removes 50% of events from the pattern. Shorthand for `.degradeBy(0.5)`
```
s("hh*8").degrade()
```

## degradeBy(amount)
Randomly removes events from the pattern by a given amount. 0 = 0% chance of removal 1 = 100% chance of removal
- amount: a number between 0 and 1
```
s("hh*8").degradeBy(0.2)
```

## delay(level)
Sets the level of the delay signal. When using mininotation, you can also optionally add the 'delaytime' and 'delayfeedback' parameter, separated by ':'.
- level: between 0 and 1
```
s("bd bd").delay("<0 .25 .5 1>")
```

## delayfeedback(feedback) [delayfb, dfb]
Sets the level of the signal that is fed back into the delay. Caution: Values >= 1 will result in a signal that gets louder and louder! Don't do it
- feedback: between 0 and 1
```
s("bd").delay(.25).delayfeedback("<.25 .5 .75 1>")
```

## delayspeed(delayspeed) [delayt, dt]
Sets the time of the delay effect.
- delayspeed: controls the pitch of the delay feedback
```
note("d d a# a".fast(2)).s("sawtooth").delay(.8).delaytime(1/2).delayspeed("<2 .5 -1 -2>")
```

## delaysync(cycles) [delayt, dt]
Sets the time of the delay effect in cycles.
- cycles: delay length in cycles
```
s("bd bd").delay(.25).delaysync("<1 2 3 5>".div(8))
```

## density(density)
Noise crackle density
- density: between 0 and x
```
s("crackle*4").density("<0.01 0.04 0.2 0.5>".slow(4))
```

## detune(amount) [det]
Set detune for stacked voices of supported oscillators
```
note("d f a a# a d3").fast(2).s("supersaw").detune("<.1 .2 .5 24.1>")
```

## dictionary(dictionaryName)
Which dictionary to use for the voicings. This falls back to the default dictionary if not provided
- dictionaryName: which dictionary (having been defined with `addVoicings`) to use
```
addVoicings('house', {
'': ['7 12 16', '0 7 16', '4 7 12'],
'm': ['0 3 7']
})
chord("<Am C D F Am E Am E>")
.dict('house').anchor(66)
.voicing().room(.5)
```

## diode(distortion, volume)
Diode-emulating distortion
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## discreteOnly()
Returns a new pattern, with 'continuous' haps (those without 'whole' timespans) removed from query results.

## distort(distortion, volume, type) [dist]
Wave shaping distortion. CAUTION: it can get loud. Second option in optional array syntax (ex: ".9:.5") applies a postgain to the output. Third option sets the waveshaping type. Most useful values are usually between 0 and 10 (depending on source gain). If you are feeling adventurous, you can turn it up to 11 and beyond ;)
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion
- type: type of distortion to apply
```
s("bd sd [~ bd] sd,hh*8").distort("<0 2 3 10:.5>")
```

## distorttype(type) [disttype]
Type of waveshaping distortion to apply.
- type: type of distortion to apply
```
s("bd*4").bank("tr909").distort(2).distorttype("<0 1 2>")
```

## distortvol(volume) [distvol]
Postgain for waveshaping distortion.
- volume: linear postgain of the distortion
```
s("bd*4").bank("tr909").distort(2).distortvol(0.8)
```

## div()
Divides each number by the given factor.

## djf(cutoff)
DJ filter, below 0.5 is low pass filter, above is high pass filter.
- cutoff: below 0.5 is low pass filter, above is high pass filter
```
n(irand(16).seg(8)).scale("d:phrygian").s("supersaw").djf("<.5 .3 .2 .75>")
```

## drawLine(pattern, chars)
Intended for a debugging, drawLine renders the pattern as a string, where each character represents the same time span. Should only be used with single characters as values, otherwise the character slots will be messed up. Character legend: "|" cycle separator "-" hold previous value "." silence
- pattern: the pattern to use
- chars: max number of characters (approximately)
```
const line = drawLine("0 [1 2 3]", 10); // |0--123|0--123
console.log(line);
silence;
```

## drive(amount)
Filter overdrive for supported filter types
```
note("{f g g c d a a#}%16".sub(17)).s("supersaw").lpenv(8).lpf(150).lpq(.8).ftype('ladder').drive("<.5 4>")
```

## drop()
Experimental Drops the given number of steps from a pattern. A positive number will drop steps from the start of a pattern, and a negative number from the end.
```
"tha dhi thom nam".drop("1").sound().bank("mridangam")
```

## dry(dry)
Set dryness of reverb. See `room` and `size` for more information about reverb.
- dry: 0 = wet, 1 = dry
```
n("[0,3,7](3,8)").s("superpiano").room(.7).dry("<0 .5 .75 1>").osc()
```

## duckattack(time) [duckatt]
The time required for the ducked signal(s) to return to their normal volume. Can vary across orbits with the ':' mininotation, e.g. `duckonset("0:0.003")`. Note: this requires first applying the effect to multiple orbits with e.g. `duckorbit("2:3")`.
- time: The attack time in seconds
```
sound: n(run(8)).scale("c:minor").s("sawtooth").delay(.7).orbit(2)
ducker: s("bd:4!4").beat("0,4,8,11,14",16).duckorbit(2).duckattack("<0.2 0 0.4>").duckdepth(1)
```

## duckdepth(depth)
The amount of ducking applied to target orbit Can vary across orbits with the ':' mininotation, e.g. `duckdepth("0.3:0.1")`. Note: this requires first applying the effect to multiple orbits with e.g. `duckorbit("2:3")`.
- depth: depth of modulation from 0 to 1
```
stack( n(run(8)).scale("c:minor").s("sawtooth").delay(.7).orbit(2), s("bd:4!4").beat("0,4,8,11,14",16).duckorbit(2).duckattack(0.2).duckdepth("<1 .9 .6 0>"))
```

## duckonset(time) [duckons]
The time required for the ducked signal(s) to reach their lowest volume. Can be used to prevent clicking or for creative rhythmic effects. Can vary across orbits with the ':' mininotation, e.g. `duckonset("0:0.003")`. Note: this requires first applying the effect to multiple orbits with e.g. `duckorbit("2:3")`.
- time: The onset time in seconds
```
// Clicks
sound: freq("63.2388").s("sine").orbit(2).gain(4)
duckerWithClick: s("bd*4").duckorbit(2).duckattack(0.3).duckonset(0).postgain(0)
```

## duckorbit(orbit) [duck]
Modulate the amplitude of an orbit to create a "sidechain" like effect. Can be applied to multiple orbits with the ':' mininotation, e.g. `duckorbit("2:3")`
- orbit: target orbit
```
$: n(run(16)).scale("c:minor:pentatonic").s("sawtooth").delay(.7).orbit(2)
$: s("bd:4!4").beat("0,4,8,11,14",16).duckorbit(2).duckattack(0.2).duckdepth(1)
```

## duration(seconds) [dur]
Sets the duration of the event in cycles. Similar to clip / legato, it also cuts samples off at the end if they exceed the duration.
- seconds: = 0
```
note("c a f e").s("piano").dur("<.5 1 2>")
```

## each()
Applies a function to each of the running patterns separately. This is intended for future use with upcoming 'stepwise' features. See `all` for a version that applies the function to all the patterns stacked together into a single pattern. $: sound("bd - cp sd") $: sound("hh*8") each(fast("<2 3>"))

## early(cycles)
Nudge a pattern to start earlier in time. Equivalent of Tidal's <~ operator
- cycles: number of cycles to nudge left
```
"bd ~".stack("hh ~".early(.1)).s()
```

## echo(times, time, feedback)
Superimpose and offset multiple times, gradually decreasing the velocity
- times: how many times to repeat
- time: cycle offset between iterations
- feedback: velocity multiplicator for each iteration
```
s("bd sd").echo(3, 1/6, .8)
```

## echoWith(times, time, func) [echowith, stutWith, stutwith]
Superimpose and offset multiple times, applying the given function each time.
- times: how many times to repeat
- time: cycle offset between iterations
- func: function to apply, given the pattern and the iteration index
```
"<0 [2 4]>"
.echoWith(4, 1/8, (p,n) => p.add(n*2))
.scale("C:minor").note()
```

## end(length)
The same as .begin, but cuts off the end off each sample.
- length: 1 = whole sample, .5 = half sample, .25 = quarter sample etc..
```
s("bd*2,oh*4").end("<.1 .2 .5 1>").fast(2)
```

## env(config, config.control, config.subControl, config.depth, config.depthabs, config.attack, config.decay, config.sustain, config.release, config.acurve, config.dcurve, config.rcurve, config.fxi, id)
Configures an envelope. Can be called in sequence like pat.env(...).env(...) to set up multiple envelopes There are two ways to declare which control will be modulated: Explicitly put `control` in the config (e.g. `env({ c: "lpf" })`) If the control parameter is absent, the control immediately before the `env` call will be used (e.g. `s("saw").lpf(500).env({ a: 1 })` to modulate `lpf`) Modulators can be referred to by `id` so that they can be updated later e.g. inside a `sometimes`. See example below.
- config: Envelope configuration.
- config.control: Node to modulate. Aliases: c
- config.subControl: Sub-control name to append to the control key. Aliases: sc
- config.depth: Relative modulation depth. Aliases: dep, dr
- config.depthabs: Absolute modulation depth. Aliases: da
- config.attack: Time to reach depth. Aliases: att, a
- config.decay: Time to reach sustain. Aliases: dec, d
- config.sustain: Sustain depth. Aliases: sus, s
- config.release: Time to return to nominal value. Aliases: rel, r
- config.acurve: Snappiness of attack curve (-1 = relaxed, 1 = snappy). Aliases: ac
- config.dcurve: Snappiness of decay curve (-1 = relaxed, 1 = snappy). Aliases: dc
- config.rcurve: Snappiness of release curve (-1 = relaxed, 1 = snappy). Aliases: rc
- config.fxi: FX index to target
- id: ID to use for this modulator
```
s("saw").note("F1").lpf(500).env({ a: 1 })
```

## euclid(pulses, steps)
Changes the structure of the pattern to form an Euclidean rhythm. Euclidean rhythms are rhythms obtained using the greatest common divisor of two numbers. They were described in 2004 by Godfried Toussaint, a Canadian computer scientist. Euclidean rhythms are really useful for computer/algorithmic music because they can describe a large number of rhythms with a couple of numbers.
- pulses: the number of onsets/beats
- steps: the number of steps to fill
```
// The Cuban tresillo pattern.
note("c3").euclid(3,8)
```

## euclidish(pulses, steps, groove) [eish]
A 'euclid' variant with an additional parameter that morphs the resulting rhythm from 0 (no morphing) to 1 (completely 'even'). For example `sound("bd").euclidish(3,8,0)` would be the same as `sound("bd").euclid(3,8)`, and `sound("bd").euclidish(3,8,1)` would be the same as `sound("bd bd bd")`. `sound("bd").euclidish(3,8,0.5)` would have a groove somewhere between. Inspired by the work of Malcom Braff.
- pulses: the number of onsets
- steps: the number of steps to fill
- groove: exists between the extremes of 0 (straight euclidian) and 1 (straight pulse)
```
sound("hh").euclidish(7,12,sine.slow(8))
.pan(sine.slow(8))
```

## euclidLegato(pulses, steps, rotation, pat)
Similar to `euclid`, but each pulse is held until the next pulse, so there will be no gaps.
- pulses: the number of onsets/beats
- steps: the number of steps to fill
- rotation: offset in steps
```
note("c3").euclidLegato(3,8)
```

## euclidLegatoRot(pulses, steps, rotation)
Similar to `euclid`, but each pulse is held until the next pulse, so there will be no gaps, and has an additional parameter for 'rotating' the resulting sequence
- pulses: the number of onsets/beats
- steps: the number of steps to fill
- rotation: offset in steps
```
note("c3").euclidLegatoRot(3,5,2)
```

## euclidRot(pulses, steps, rotation)
Like `euclid`, but has an additional parameter for 'rotating' the resulting sequence.
- pulses: the number of onsets/beats
- steps: the number of steps to fill
- rotation: offset in steps
```
// A Samba rhythm necklace from Brazil
note("c3").euclidRot(3,16,14)
```

## every(n, func)
An alias for `firstOf`
- n: how many cycles
- func: function to apply
```
note("c3 d3 e3 g3").every(4, x=>x.rev())
```

## expand()
Experimental Expands the step size of the pattern by the given factor.
```
sound("tha dhi thom nam").bank("mridangam").expand("3 2 1 1 2 3").pace(8)
```

## extend()
Experimental `extend` is similar to `fast` in that it increases its density, but it also increases the step count accordingly. So `stepcat("a b".extend(2), "c d")` would be the same as `"a b a b c d"`, whereas `stepcat("a b".fast(2), "c d")` would be the same as `"[a b] [a b] c d"`.
```
stepcat(
  sound("bd bd - cp").extend(2),
  sound("bd - sd -")
).pace(8)
```

## fanchor(center)
controls the center of the filter envelope. 0 is unipolar positive, .5 is bipolar, 1 is unipolar negative
- center: 0 to 1
```
note("{f g g c d a a#}%8").s("sawtooth").lpf("{1000}%2")
.lpenv(8).fanchor("<0 .5 1>")
```

## fast(factor) [density]
Speed up a pattern by the given factor. Used by "*" in mini notation.
- factor: speed up factor
```
s("bd hh sd hh").fast(2) // s("[bd hh sd hh]*2")
```

## fastChunk() [fastchunk]
Like `chunk`, but the cycles of the source pattern aren't repeated for each set of chunks.
```
"<0 8> 1 2 3 4 5 6 7"
.scale("C2:major").note()
.fastChunk(4, x => x.color('red')).slow(2)
```

## fastGap() [fastgap]
speeds up a pattern like fast, but rather than it playing multiple times as fast would it instead leaves a gap in the remaining space of the cycle. For example, the following will play the sound pattern "bd sn" only once but compressed into the first half of the cycle, i.e. twice as fast.
```
s("bd sd").fastGap(2)
```

## filter(test)
Filters haps using the given function
- test: function to test Hap
```
s("hh!7 oh").filter(hap => hap.value.s === 'hh')
```

## filterHaps(hap_test)
Returns a new Pattern, which only returns haps that meet the given test.
- hap_test: a function which returns false for haps to be removed from the pattern
```
s("bd*8").velocity(rand).filterHaps((h) => (h.whole.begin % 1) < h.value.velocity)
```

## filterValues(value_test)
As with `filterHaps`, but the function is applied to values inside haps.
```
const drums = s("bd sd bd sd")
kick: drums.filterValues((v) => v.s === 'bd').duck(2)
snare: drums.filterValues((v) => v.s === 'sd')
bass: s("saw!4").note("G#1").lpf(80).lpenv(4).orbit(2)
```

## filterWhen(test)
Filters haps by their begin time
- test: function to test Hap.whole.begin
```
oneCycle: s("bd*4").filterWhen((t) => t < 1)
```

## findPeaks()
Find peaks in spectrum magnitudes

## firstCycle(with_context)
Queries the pattern for the first cycle, returning Haps. Mainly of use when debugging a pattern.
- with_context: set to true, otherwise the context field will be stripped from the resulting haps.

## firstCycleValues()
Accessor for a list of values returned by querying the first cycle.

## firstOf(n, func)
Applies the given function every n cycles, starting from the first cycle.
- n: how many cycles
- func: function to apply
```
note("c3 d3 e3 g3").firstOf(4, x=>x.rev())
```

## fit()
Makes the sample fit its event duration. Good for rhythmical loops like drum breaks. Similar to `loopAt`.
```
samples({ rhodes: 'https://cdn.freesound.org/previews/132/132051_316502-lq.mp3' })
s("rhodes/2").fit()
```

## floor()
Assumes a numerical pattern. Returns a new pattern with all values set to their mathematical floor. E.g. `3.7` replaced with to `3`, and `-4.2` replaced with `-5`.
```
note("42 42.1 42.5 43".floor())
```

## fmap()
see `withValue`

## fmattack(time) [fmatt]
Attack time for the FM envelope: time it takes to reach maximum modulation A number may be added afterwards to control the attack of the envelope of any of the 8 individual FMs (e.g. `fmatt5`)
- time: attack time
```
note("c e g b g e")
.fm(4)
.fmattack("<0 .05 .1 .2>")
._scope()
```

## fmdecay(time) [fmdec]
Decay time for the FM envelope: seconds until the sustain level is reached after the attack phase. A number may be added afterwards to control the decay of the envelope of any of the 8 individual FMs (e.g. `fmdec6`)
- time: decay time
```
note("c e g b g e")
.fm(4)
.fmdecay("<.01 .05 .1 .2>")
.fmsustain(.4)
._scope()
```

## fmenv(type)
Ramp type of fm envelope. Exp might be a bit broken.. A number may be added afterwards to control the envelope of any of the 8 individual FMs (e.g. `fmenv4`)
- type: lin | exp
```
note("c e g b g e")
.fm(4)
.fmdecay(.2)
.fmsustain(0)
.fmenv("<exp lin>")
._scope()
```

## fmh(harmonicity)
Sets the Frequency Modulation Harmonicity Ratio. Controls the timbre of the sound. Whole numbers and simple ratios sound more natural, while decimal numbers and complex ratios sound metallic. A number may be added afterwards to control the harmonicity of any of the 8 individual FMs (e.g. `fmh2`)
```
note("c e g b g e")
.fm(4)
.fmh("<1 2 1.5 1.61>")
._scope()
```

## fmi(brightness) [fm]
Sets the Frequency Modulation of the synth. Controls the modulation index, which defines the brightness of the sound. A number may be added afterwards to control the modulation index of any of the 8 individual FMs (e.g. `fm3`). Also, FMs may be routed into each other with matrix commands like `fm13`, which would send `fm1` back into `fm3`
- brightness: modulation index
```
note("c e g b g e")
.fm("<0 1 2 8 32>")
._scope()
```

## fmrelease(time) [fmrel]
Release time for the FM envelope: how much modulation is applied after the note is released A number may be added afterwards to control the release of the envelope of any of the 8 individual FMs (e.g. `fmrel8`)
- time: release time

## fmsustain(level) [fmsus]
Sustain level for the FM envelope: how much modulation is applied after the decay phase A number may be added afterwards to control the sustain of the envelope of any of the 8 individual FMs (e.g. `fmsus7`)
- level: sustain level
```
note("c e g b g e")
.fm(4)
.fmdecay(.1)
.fmsustain("<1 .75 .5 0>")
._scope()
```

## fmwave(wave)
Waveform of the fm modulator A number may be added afterwards to control the waveform any of the 8 individual FMs (e.g. `fmwave6`)
- wave: waveform
```
n("0 1 2 3".fast(4)).scale("d:minor").s("sine").fmwave("<sine square sawtooth crackle>").fm(4).fmh(2.01)
```

## focus()
Similar to `compress`, but doesn't leave gaps, and the 'focus' can be bigger than a cycle
```
s("bd hh sd hh").focus(1/4, 3/4)
```

## fold(distortion, volume)
Wavefolding distortion
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## freq(frequency)
Set frequency of sound.
- frequency: in Hz. the audible range is between 20 and 20000 Hz
```
freq("220 110 440 110").s("superzow").osc()
```

## fromBipolar()
Assumes a numerical pattern, containing bipolar values in the range -1 .. 1 Returns a new pattern with values scaled to the unipolar range 0 .. 1

## fscope(color, scale, pos, lean, min, max)
Renders an oscilloscope for the frequency domain of the audio signal.
- color: line color as hex or color name. defaults to white.
- scale: scales the y-axis. Defaults to 0.25
- pos: y-position relative to screen height. 0 = top, 1 = bottom of screen
- lean: y-axis alignment where 0 = top and 1 = bottom
- min: min value
- max: max value
```
s("sawtooth").fscope()
```

## ftype(type)
Sets the filter type. The ladder filter is more aggressive. More types might be added in the future.
- type: 12db (0), ladder (1), or 24db (2)
```
note("{f g g c d a a#}%8").s("sawtooth").lpenv(4).lpf(500).ftype("<0 1 2>").lpq(1)
```

## FX()
Establishes an FX chain. Can be called by chaining .FX(fx1).FX(fx2).. calls and/or in a single .FX(fx1, fx2, ..) call. The fx1, .. are patterns which establish the controls of the given effect. See examples.
```
$: s("[sbd <hh [bd | lt | oh]>]*4").dec(.4)
  .FX(
    phaser(0.5).gain(2),
    bpf(800),
    distort(1.3),
    room(0.2),
    delay(0.5).gain(1.25),
    distort(0.3),
  ).fxr(1.7) // sets release time of effects (like delay)
```

## gain(amount)
Controls the gain by an exponential amount.
- amount: gain.
```
s("hh*8").gain(".4!2 1 .4!2 1 .4 1").fast(2)
```

## gap(steps)
Does absolutely nothing, but with a given metrical 'steps'
```
gap(3) // "~@3"
```

## generateGraph(data, width, height, min, max)
Creates a canvas element showing a graph of the given data.
- data: An array of numbers, or a Float32Array.
- width: Width in pixels of the canvas.
- height: Height in pixels of the canvas.
- min: Minimum value of data for the graph (lower edge).
- max: Maximum value of data in the graph (upper edge).

## generateReverb(params, callback)
Generates a reverb impulse response.
- params: TODO: Document the properties.
- callback: Function to call when the impulse response has been generated. The impulse response is passed to this function as its parameter. May be called immediately within the current execution context, or later.

## getAllChannelData(buffer)

## getFreq()

## grow()
Experimental Progressively grows the pattern by 'n' steps until the full pattern is played, or if a second value is given (using mininotation list syntax with `:`), that number of times. A positive number will progressively grow steps from the start of a pattern, and a negative number from the end.
```
"tha dhi thom nam".grow("1").sound()
.bank("mridangam")
```

## handleOutputBuffersToRetrieve()
Add contents of output buffers just processed to output buffers

## hard(distortion, volume)
Hard-clipping distortion
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## hpattack(attack) [hpa]
Sets the attack duration for the highpass filter envelope.
- attack: time of the highpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.hpf(500)
.hpa("<.5 .25 .1 .01>/4")
.hpenv(4)
```

## hpdc(dcoffset)
DC offset of the LFO for the highpass filter
- dcoffset: dc offset. set to 0 for unipolar

## hpdecay(decay) [hpd]
Sets the decay duration for the highpass filter envelope.
- decay: time of the highpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.hpf(500)
.hpd("<.5 .25 .1 0>/4")
.hps(0.2)
.hpenv(4)
```

## hpdepth(depth)
Depth of the LFO for the highpass filter
- depth: depth of modulation

## hpdepthfrequency(depth) [hpdepthfreq]
Depth of the LFO for the hipass filter, in hz
- depth: depth of modulation
```
note("<c c c# c c c4>*16").s("sawtooth").lpf(600).hpdepthfrequency("<200 500 100 0>")
```

## hpenv(modulation) [hpe]
Sets the highpass filter envelope modulation depth.
- modulation: depth of the highpass filter envelope between 0 and n
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.hpf(500)
.hpa(.5)
.hpenv("<4 2 1 0 -1 -2 -4>/4")
```

## hpf(frequency) [hp, hcutoff]
Applies the cutoff frequency of the high-pass filter. When using mininotation, you can also optionally add the 'hpq' parameter, separated by ':'.
- frequency: audible between 0 and 20000
```
s("bd sd [~ bd] sd,hh*8").hpf("<4000 2000 1000 500 200 100>")
```

## hpq(q) [hresonance]
Controls the high-pass q-value.
- q: resonance factor between 0 and 50
```
s("bd sd [~ bd] sd,hh*8").hpf(2000).hpq("<0 10 20 30>")
```

## hprate(rate)
Rate of the LFO for the highpass filter
- rate: rate in hertz

## hprelease(release) [hpr]
Sets the release time for the highpass filter envelope.
- release: time of the highpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.clip(.5)
.hpf(500)
.hpenv(4)
.hpr("<.5 .25 .1 0>/4")
.release(.5)
```

## hpshape(shape)
Shape of the LFO for the highpass filter
- shape: Shape of the lfo (0, 1, 2, ..)

## hpskew(skew)
Skew of the LFO for the highpass filter
- skew: How much to bend the LFO shape

## hpsustain(sustain) [hps]
Sets the sustain amplitude for the highpass filter envelope.
- sustain: amplitude of the highpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.hpf(500)
.hpd(.5)
.hps("<0 .25 .5 1>/4")
.hpenv(4)
```

## hpsync(rate)
Cycle-synced rate of the LFO for the highpass filter
- rate: rate in cycles

## hurry()
Both speeds up the pattern (like 'fast') and the sample playback (like 'speed').
```
s("bd sd:2").hurry("<1 2 4 3>").slow(1.5)
```

## hush()
Silences a pattern.
```
stack(
  s("bd").hush(),
  s("hh*3")
)
```

## inhabit(pat, xs) [pickSqueeze]
Picks patterns (or plain values) either from a list (by index) or a lookup table (by name). Similar to `pick`, but cycles are squeezed into the target ('inhabited') pattern.
```
"<a b [a,b]>".inhabit({a: s("bd(3,8)"),
                            b: s("cp sd")
                           })
```

## inhabitmod(pat, xs) [pickmodSqueeze]
The same as `inhabit`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value. For example, if you pick the fifth pattern of a list of three, you'll get the second one.

## inside()
Carries out an operation 'inside' a cycle.
```
"0 1 2 3 4 3 2 1".inside(4, rev).scale('C major').note()
// "0 1 2 3 4 3 2 1".slow(4).rev().fast(4).scale('C major').note()
```

## into()
Breaks a pattern into pieces according to the structure of a given pattern. True values in the given pattern cause the corresponding subcycle of the source pattern to be looped, and for an (optional) given function to be applied. False values result in the corresponding part of the source pattern to be played unchanged.
```
sound("bd sd ht lt").into("1 0", hurry(2))
```

## invert() [inv]
Swaps 1s and 0s in a binary pattern.
```
s("bd").struct("1 0 0 1 0 0 1 0".lastOf(4, invert))
```

## irand(n)
A continuous pattern of random integers, between 0 and n-1.
- n: max value (exclusive)
```
// randomly select scale notes from 0 - 7 (= C to C)
n(irand(8)).struct("x x*2 x x*3").scale("C:minor")
```

## irbegin(begin) [ir]
Sets the beginning of the IR response sample
- begin: between 0 and 1
```
samples('github:switchangel/pad')
$: s("brk/2").fit().scrub(irand(16).div(16).seg(8)).ir("swpad:4").room(.65).irspeed("-2").irbegin("<0 .5 .75>/2").roomsize(.6)
```

## iresponse(sample) [ir]
Sets the sample to use as an impulse response for the reverb.
- sample: to use as an impulse response
```
s("bd sd [~ bd] sd").room(.8).ir("<shaker_large:0 shaker_large:2>")
```

## irspeed(speed)
Sets speed of the sample for the impulse response.
```
samples('github:switchangel/pad')
$: s("brk/2").fit().scrub(irand(16).div(16).seg(8)).ir("swpad:4").room(.2).irspeed("<2 1 .5>/2").irbegin(.5).roomsize(.5)
```

## isaw()
A sawtooth signal between 1 and 0 (like `saw`, but flipped).
```
note("<c3 [eb3,g3] g2 [g3,bb3]>*8")
.clip(isaw.slow(2))
```

## isaw2()
A sawtooth signal between 1 and -1 (like `saw2`, but flipped).

## iter()
Divides a pattern into a given number of subdivisions, plays the subdivisions in order, but increments the starting subdivision each cycle. The pattern wraps to the first subdivision after the last subdivision is played.
```
note("0 1 2 3".scale('A minor')).iter(4)
```

## iterBack() [iterback]
Like `iter`, but plays the subdivisions in reverse order. Known as iter' in tidalcycles
```
note("0 1 2 3".scale('A minor')).iterBack(4)
```

## itri()
An inverted triangle signal between 1 and 0 (like `tri`, but flipped).
```
n(itri.segment(8).range(0,7)).scale("C:minor")
```

## itri2()
An inverted triangle signal between -1 and 1 (like `itri`, but bipolar).

## jux()
The jux function creates strange stereo effects, by applying a function to a pattern, but only in the right-hand channel.
```
s("bd lt [~ ht] mt cp ~ bd hh").jux(rev)
```

## juxBy() [juxby]
Jux with adjustable stereo width. 0 = mono, 1 = full stereo.
```
s("bd lt [~ ht] mt cp ~ bd hh").juxBy("<0 .5 1>/2", rev)
```

## K(expr)
Produces a Kabelsalat modular sound engine. This can be used as either an effect (by including `audioin()` at the beginning of your kabel expression) or as a sound source (via any expression which doesn't start with `audioin()`). Some helpers you have available to you: Strudel mini notation works fine in K(..) via "" or `` More complex Strudel expressions (like "0 1 2".fast(4) or irand(24)) can be written by wrapping them in `S(..)` inside your Kabel code We expose Strudel's note frequency under `sFreq` and Strudel's gate information under `sGate` You can use more complex multi-line expressions (like `let x = a; let y = b; x.lpf(y);`) by wrapping them inside a function in K (see example).
- expr: Kabelsalat graph definition
```
note("A c e".fast(4)).transpose("<0 2 4 6 8>")
  .scale("F:minor").transpose("12")
  .s("saw")
  .K(
    // audioin().mul(sGate.adsr(0.001, 0.3, 0, 0.2)) // as effect
    saw(saw(sFreq / "2!3 16").mul(8).add(sFreq).lag("0!3 0.1")).mul(0.3) // as source
    .mul(sGate.adsr(0, 0.15, 0.5, "0.1!3 1"))
    .lpf(sGate.adsr(0, 0.2, 0.3, 0.2).mul(1).add(0))
    .add(x => x.delay(S("0.3 0.2".fast(2))).mul(0.7))
    .add(x => x.delay("0.03 [0.08 0.01] 0.01 0.013").mul(0.77)).mul(0.7)
    .add(x => x.delay(.13).mul(0.7))
    .out()
  )
```

## keyDown()
returns true when a key or array of keys is held Key name reference
```
keyDown("Control:j").pick([s("bd(5,8)"), s("cp(3,8)")])
```

## label(label)
Sets the displayed text for an event on the pianoroll
- label: text to display

## lastOf(n, func)
Applies the given function every n cycles, starting from the last cycle.
- n: how many cycles
- func: function to apply
```
note("c3 d3 e3 g3").lastOf(4, x=>x.rev())
```

## late(cycles)
Nudge a pattern to start later in time. Equivalent of Tidal's ~> operator
- cycles: number of cycles to nudge right
```
"bd ~".stack("hh ~".late(.1)).s()
```

## layer() [apply]
Layers the result of the given function(s). Like `superimpose`, but without the original pattern:
```
"<0 2 4 6 ~ 4 ~ 2 0!3 ~!5>*8"
  .layer(x=>x.add("0,2"))
  .scale('C minor').note()
```

## leslie(wet)
Emulation of a Leslie speaker: speakers rotating in a wooden amplified cabinet.
- wet: between 0 and 1
```
n("0,4,7").s("supersquare").leslie("<0 .4 .6 1>").osc()
```

## lfo(config, config.control, config.subControl, config.rate, config.depth, config.depthabs, config.dcoffset, config.shape, config.skew, config.curve, config.sync, config.fxi, id)
Configures an LFO. Can be called in sequence like pat.lfo(...).lfo(...) to set up multiple LFOs. There are two ways to declare which control will be modulated: Explicitly put `control` in the config (e.g. `lfo({ c: "lpf" })`) If the control parameter is absent, the control immediately before the `lfo` call will be used (e.g. `s("saw").lpf(500).lfo()` to modulate `lpf`) Modulators can be referred to by `id` so that they can be updated later e.g. inside a `sometimes`. See example below.
- config: LFO configuration.
- config.control: Node to modulate. Aliases: c
- config.subControl: Sub-control name to append to the control key. Aliases: sc
- config.rate: Modulation rate. Aliases: r
- config.depth: Relative modulation depth. Aliases: dep, dr
- config.depthabs: Absolute modulation depth. Aliases: da
- config.dcoffset: DC offset / bias for the waveform. Aliases: dc
- config.shape: Shape index. Aliases: sh
- config.skew: Skew amount. Aliases: sk
- config.curve: Exponential curve amount. Aliases: cu
- config.sync: Tempo-synced modulation rate. Aliases: s
- config.fxi: FX index to target
- id: ID to use for this modulator
```
s("saw").note("F1").lpf(500).lfo()
```

## linger(fraction)
Selects the given fraction of the pattern and repeats that part to fill the remainder of the cycle.
- fraction: fraction to select
```
s("lt ht mt cp, [hh oh]*2").linger("<1 .5 .25 .125>")
```

## lock(enable)
Specifies whether delaytime is calculated relative to cps.
- enable: When set to 1, delaytime is a direct multiple of a cycle.
```
s("sd").delay().lock(1).osc()
```

## log()
Writes the content of the current event to the console (visible in the side menu).
```
s("bd sd").log()
```

## logValues()
A simplified version of `log` which writes all "values" (various configurable parameters) within the event to the console (visible in the side menu).
```
s("bd sd").gain("0.25 0.5 1").n("2 1 0").logValues()
```

## loop(on)
Loops the sample. Note that the tempo of the loop is not synced with the cycle tempo. To change the loop region, use loopBegin / loopEnd.
- on: If 1, the sample is looped
```
s("casio").loop(1)
```

## loopAt()
Makes the sample fit the given number of cycles by changing the speed.
```
samples({ rhodes: 'https://cdn.freesound.org/previews/132/132051_316502-lq.mp3' })
s("rhodes").loopAt(2)
```

## loopAtCps()
Makes the sample fit the given number of cycles and cps value, by changing the speed. Please note that at some point cps will be given by a global clock and this function will be deprecated/removed.
```
samples({ rhodes: 'https://cdn.freesound.org/previews/132/132051_316502-lq.mp3' })
s("rhodes").loopAtCps(4,1.5).cps(1.5)
```

## loopBegin(time) [loopb]
Begin to loop at a specific point in the sample (inbetween `begin` and `end`). Note that the loop point must be inbetween `begin` and `end`, and before `loopEnd`! Note: Samples starting with wt_ will automatically loop! (wt = wavetable)
- time: between 0 and 1, where 1 is the length of the sample
```
s("space").loop(1)
.loopBegin("<0 .125 .25>")._scope()
```

## loopEnd(time) [loope]
End the looping section at a specific point in the sample (inbetween `begin` and `end`). Note that the loop point must be inbetween `begin` and `end`, and after `loopBegin`!
- time: between 0 and 1, where 1 is the length of the sample
```
s("space").loop(1)
.loopEnd("<1 .75 .5 .25>")._scope()
```

## lpattack(attack) [lpa]
Sets the attack duration for the lowpass filter envelope.
- attack: time of the filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.lpf(300)
.lpa("<.5 .25 .1 .01>/4")
.lpenv(4)
```

## lpdc(dcoffset)
DC offset of the LFO for the lowpass filter
- dcoffset: dc offset. set to 0 for unipolar

## lpdecay(decay) [lpd]
Sets the decay duration for the lowpass filter envelope.
- decay: time of the filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.lpf(300)
.lpd("<.5 .25 .1 0>/4")
.lpenv(4)
```

## lpdepth(depth)
Depth of the LFO for the lowpass filter
- depth: depth of modulation
```
note("<c c c# c c c4>*16").s("sawtooth").lpf(600).lpdepth("<1 .5 1.8 0>")
```

## lpdepthfrequency(depth) [lpdepthfreq]
Depth of the LFO for the lowpass filter, in HZ
- depth: depth of modulation
```
note("<c c c# c c c4>*16").s("sawtooth").lpf(600).lpdepthfrequency("<200 500 100 0>")
```

## lpenv(modulation) [lpe]
Sets the lowpass filter envelope modulation depth.
- modulation: depth of the lowpass filter envelope between 0 and n
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.lpf(300)
.lpa(.5)
.lpenv("<4 2 1 0 -1 -2 -4>/4")
```

## lpf(frequency) [cutoff, ctf, lp]
Applies the cutoff frequency of the low-pass filter. When using mininotation, you can also optionally add the 'lpq' parameter, separated by ':'.
- frequency: audible between 0 and 20000
```
s("bd sd [~ bd] sd,hh*6").lpf("<4000 2000 1000 500 200 100>")
```

## lpq(q) [resonance]
Controls the low-pass q-value.
- q: resonance factor between 0 and 50
```
s("bd sd [~ bd] sd,hh*8").lpf(2000).lpq("<0 10 20 30>")
```

## lprate(rate)
Rate of the LFO for the lowpass filter
- rate: rate in hertz
```
note("<c c c# c c c4>*16").s("sawtooth").lpf(600).lprate("<4 8 2 1>")
```

## lprelease(release) [lpr]
Sets the release time for the lowpass filter envelope.
- release: time of the filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.clip(.5)
.lpf(300)
.lpenv(4)
.lpr("<.5 .25 .1 0>/4")
.release(.5)
```

## lpshape(shape)
Shape of the LFO for the lowpass filter
- shape: Shape of the lfo (0, 1, 2, ..)

## lpskew(skew)
Skew of the LFO for the lowpass filter
- skew: How much to bend the LFO shape

## lpsustain(sustain) [lps]
Sets the sustain amplitude for the lowpass filter envelope.
- sustain: amplitude of the lowpass filter envelope
```
note("c2 e2 f2 g2")
.sound('sawtooth')
.lpf(300)
.lpd(.5)
.lps("<0 .25 .5 1>/4")
.lpenv(4)
```

## lpsync(rate)
Cycle-synced rate of the LFO for the lowpass filter
- rate: rate in cycles
```
note("<c c c# c c c4>*16").s("sawtooth").lpf(600).lpsync("<4 8 2 1>")
```

## lrate(rate)
Rate of modulation / rotation for leslie effect
- rate: 6.7 for fast, 0.7 for slow
```
n("0,4,7").s("supersquare").leslie(1).lrate("<1 2 4 8>").osc()
```

## lsize(meters)
Physical size of the cabinet in meters. Be careful, it might be slightly larger than your computer. Affects the Doppler amount (pitch warble)
- meters: somewhere between 0 and 1
```
n("0,4,7").s("supersquare").leslie(1).lrate(2).lsize("<.1 .5 1>").osc()
```

## mask()
Returns silence when mask is 0 or "~"
```
note("c [eb,g] d [eb,g]").mask("<1 [0 1]>")
```

## midi2note()

## mode(modeName)
Remove anchor note from the voicing. Useful for melody harmonization
- modeName: one of {below | above | duck | root}
```
mode("<below above duck root>").chord("C").voicing()
```

## morph()
Takes two binary rhythms represented as lists of 1s and 0s, and a number between 0 and 1 that morphs between them. The two lists should contain the same number of true values.
```
sound("hh").struct(morph([1,0,1,0,1,0,1,0], // straight rhythm
                         [1,1,0,1,0,1,0], // wonky rhythm
                         0.25 // creates a slightly wonky rhythm
                        )
                  )
```

## mousex()
The mouse's x position value ranges from 0 to 1.
```
n(mousex.segment(4).range(0,7)).scale("C:minor")
```

## mousey()
The mouse's y position value ranges from 0 to 1.
```
n(mousey.segment(4).range(0,7)).scale("C:minor")
```

## mul()
Multiplies each number by the given factor.
```
"<1 1.5 [1.66, <2 2.33>]>*4".mul(150).freq()
```

## n(value)
Selects the given index from the sample map. Numbers too high will wrap around. `n` can also be used to play midi numbers, but it is recommended to use `note` instead.
- value: sample index starting from 0
```
s("bd sd [~ bd] sd,hh*6").n("<0 1>")
```

## never()
Shorthand for `.sometimesBy(0, fn)` (never calls fn)
```
s("hh*8").never(x=>x.speed("0.5"))
```

## noise(wet)
Adds pink noise to the mix
- wet: wet amount
```
sound("<white pink brown>/2")
```

## note()
Plays the given note name or midi number. A note name consists of a letter (a-g or A-G) optional accidentals (b or #) optional (possibly negative) octave number (0-9). Defaults to 3 Examples of valid note names: `c`, `bb`, `Bb`, `f#`, `c3`, `A4`, `Eb2`, `c#5` You can also use midi numbers instead of note names, where 69 is mapped to A4 440Hz in 12EDO.
```
note("c a f e")
```

## octave(octave) [oct]
Sets the default octave of a synth.
- octave: octave number
```
n("0,4,7").scale("F:minor").s('supersaw').octave("<0 1 2 3>")
```

## octaves(count)
How many octaves are voicing steps spread apart, defaults to 1
- count: the number of octaves
```
chord("<Am C D F Am E Am E>").octaves("<2 4>").voicing()
```

## off(time, func)
Superimposes the function result on top of the original pattern, delayed by the given time.
- time: offset time
- func: function to apply
```
"c3 eb3 g3".off(1/8, x=>x.add(7)).note()
```

## offset(shift)
Sets how the voicing is offset from the anchored position
- shift: the amount to shift the voicing up or down
```
chord("<Am C D F Am E Am E>").offset("<0 1 2 3 4 5>") // alter the voicing each time
```

## often()
Shorthand for `.sometimesBy(0.75, fn)`
```
s("hh*8").often(x=>x.speed("0.5"))
```

## OLAProcessor()

## onsetsOnly()
Returns a new pattern, with all haps without onsets filtered out. A hap with an onset is one with a `whole` timespan that begins at the same time as its `part` timespan.

## onTriggerTime()
make something happen on event time uses browser timeout which is innacurate for audio tasks
```
s("bd!8").onTriggerTime((hap) => {console.log(hap)})
```

## orbit(number) [o]
An `orbit` is a global parameter context for patterns. Patterns with the same orbit will share the same global effects.
```
stack(
  s("hh*6").delay(.5).delaytime(.25).orbit(1),
  s("~ sd ~ sd").delay(.5).delaytime(.125).orbit(2)
)
```

## oschost(oschost)
The host to send open sound control messages to. Requires running the OSC bridge.
- oschost: e.g. 'localhost'
```
note("c4").oschost('127.0.0.1').oscport(57120).osc();
```

## oscport(oscport)
The port to send open sound control messages to. Requires running the OSC bridge.
- oscport: e.g. 57120
```
note("c4").oschost('127.0.0.1').oscport(57120).osc();
```

## outside()
Carries out an operation 'outside' a cycle.
```
"<[0 1] 2 [3 4] 5>".outside(4, rev).scale('C major').note()
// "<[0 1] 2 [3 4] 5>".fast(4).rev().slow(4).scale('C major').note()
```

## pace()
Experimental Speeds a pattern up or down, to fit to the given number of steps per cycle.
```
sound("bd sd cp").pace(4)
// The same as sound("{bd sd cp}%4") or sound("<bd sd cp>*4")
```

## palindrome()
Applies `rev` to a pattern every other cycle, so that the pattern alternates between forwards and backwards.
```
note("c d e g").palindrome()
```

## pan(pan)
Sets position in stereo.
- pan: between 0 and 1, from left to right (assuming stereo), once round a circle (assuming multichannel)
```
s("[bd hh]*2").pan("<.5 1 .5 0>")
```

## panchor(anchor)
Sets the range anchor of the envelope: anchor 0: range = [note, note + penv] anchor 1: range = [note - penv, note] If you don't set an anchor, the value will default to the psustain value.
- anchor: anchor offset
```
note("c c4").penv(12).panchor("<0 .5 1 .5>")
```

## parray()
Turns a list of patterns into a single pattern which outputs list-values

## partials(magnitudes)
Scale the magnitude of the harmonics of one of the core synths ('sine', 'tri', 'saw', ..) Can also be used to create a new synth via `s('user').partials(...)`
- magnitudes: List of [0, 1] magnitudes for partials. 0th entry is the fundamental harmonic (i.e. DC offset is skipped)
```
s("user").seg(16).n(irand(8)).scale("A:major")
  .partials([1, 0, 1, 0, 0, 1])
```

## pattack(time) [patt]
Attack time of pitch envelope.
- time: time in seconds
```
note("c eb g bb").pattack("0 .1 .25 .5").slow(2)
```

## Pattern(query)
Create a pattern. As an end user, you will most likely not create a Pattern directly.
- query: The function that maps a `State` to an array of `Hap`.

## pcurve(type)
Curve of envelope. Defaults to linear. exponential is good for kicks
- type: 0 = linear, 1 = exponential
```
note("g1*4")
.s("sine").pdec(.5)
.penv(32)
.pcurve("<0 1>")
```

## pdecay(time) [pdec]
Decay time of pitch envelope.
- time: time in seconds
```
note("<c eb g bb>").pdecay("<0 .1 .25 .5>")
```

## penv(semitones)
Amount of pitch envelope. Negative values will flip the envelope. If you don't set other pitch envelope controls, `pattack:.2` will be the default.
- semitones: change in semitones
```
note("c")
.penv("<12 7 1 .5 0 -1 -7 -12>")
```

## per() [perCycle]
A pattern measuring the 'shortness' of events, or in other words, the duration of pattern events, in events per cycle. `per` doesn't have structure itself, but takes structure, and therefore event durations, from the pattern that it is combined with. For example `per.struct("1 1 [1 1] 1")` would give the same as `"4 4 [8 8] 4"`. See also its reciprocal, `cyclesPer`.
```
// Shorter events are more distorted
n("0 0*2 0 0*2 0 [0 0 0]@2").sound("bd")
 .distort(per.div(2))
```

## perlin()
Generates a continuous pattern of perlin noise, in the range 0..1.
```
// randomly change the cutoff
s("bd*4,hh*8").cutoff(perlin.range(500,8000))
```

## perx()
Like `per` but measures the shortness of events according to an exponential curve. In particular, where the event duration halves, the returned value increases by one. `perx.struct("1 1 [1 [1 1]] 1")` would therefore be the same as `"3 3 [4 [5 5]] 3"`.

## phaser(speed) [ph]
Phaser audio effect that approximates popular guitar pedals.
- speed: speed of modulation
```
n(run(8)).scale("D:pentatonic").s("sawtooth").release(0.5)
.phaser("<1 2 4 8>")
```

## phasercenter(centerfrequency) [phc]
The center frequency of the phaser in HZ. Defaults to 1000
- centerfrequency: in HZ
```
n(run(8)).scale("D:pentatonic").s("sawtooth").release(0.5)
.phaser(2).phasercenter("<800 2000 4000>")
```

## phaserdepth(depth) [phd, phasdp]
The amount the signal is affected by the phaser effect. Defaults to 0.75
- depth: number between 0 and 1
```
n(run(8)).scale("D:pentatonic").s("sawtooth").release(0.5)
.phaser(2).phaserdepth("<0 .5 .75 1>")
```

## phasersweep(phasersweep) [phs]
The frequency sweep range of the lfo for the phaser effect. Defaults to 2000
- phasersweep: most useful values are between 0 and 4000
```
n(run(8)).scale("D:pentatonic").s("sawtooth").release(0.5)
.phaser(2).phasersweep("<800 2000 4000>")
```

## phases(phases)
Rotates the harmonics of one of the core synths ('sine', 'tri', 'saw', 'user', ..) by a list of phases
- phases: List of [0, 1) phases for partials. 0th entry is the fundamental phase (i.e. DC offset is skipped)
```
// Phase cancellation
s("saw").seg(8).n(irand(12)).scale("G#1:minor")
  .partials(partials([1, 1, 1]))
  .superimpose(x => x.phases([0.5, 0.5, 0.5]))
```

## pick(pat, xs)
Picks patterns (or plain values) either from a list (by index) or a lookup table (by name). Similar to `inhabit`, but maintains the structure of the original patterns.
```
note("<0 1 2!2 3>".pick(["g a", "e f", "f g f g" , "g c d"]))
```

## pickAndRename()
Selects entries from `source` and renames them via `map`

## pickF(pat, lookup, funcs)
pickF lets you use a pattern of numbers to pick which function to apply to another pattern.
- lookup: a pattern of indices
- funcs: the array of functions from which to pull
```
s("bd [rim hh]").pickF("<0 1 2>", [rev,jux(rev),fast(2)])
```

## pickmod(pat, xs)
The same as `pick`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value. For example, if you pick the fifth pattern of a list of three, you'll get the second one.

## pickmodF(pat, lookup, funcs)
The same as `pickF`, but if you pick a number greater than the size of the functions list, it wraps around, rather than sticking at the maximum value.
- lookup: a pattern of indices
- funcs: the array of functions from which to pull

## pickmodOut(pat, xs)
The same as `pickOut`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value.

## pickmodReset(pat, xs)
The same as `pickReset`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value.

## pickmodRestart(pat, xs)
The same as `pickRestart`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value.
```
"<a@2 b@2 c@2 d@2>".pickRestart({
        a: n("0 1 2 0"),
        b: n("2 3 4 ~"),
        c: n("[4 5] [4 3] 2 0"),
        d: n("0 -3 0 ~")
      }).scale("C:major").s("piano")
```

## pickOut(pat, xs)
Similar to `pick`, but it applies an outerJoin instead of an innerJoin.

## pickReset(pat, xs)
Similar to `pick`, but the choosen pattern is reset when its index is triggered.

## pickRestart(pat, xs)
Similar to `pick`, but the choosen pattern is restarted when its index is triggered.

## ply()
The ply function repeats each event the given number of times.
```
s("bd ~ sd cp").ply("<1 2 3>")
```

## plyForEach(factor, func) [plyforeach]
The plyForEach function repeats each event the given number of times, applying the given function to each event. This version of ply uses the iteration index as an argument to the function, similar to echoWith.
- factor: how many times to repeat
- func: function to apply, given the pattern and the iteration index
```
"<0 [2 4]>"
.plyForEach(4, (p,n) => p.add(n*2))
.scale("C:minor").note()
```

## plyWith(factor, func) [plywith]
The plyWith function repeats each event the given number of times, applying the given function to each event.\n
- factor: how many times to repeat
- func: function to apply, given the pattern
```
"<0 [2 4]>"
.plyWith(4, (p) => p.add(2))
.scale("C:minor").note()
```

## polymeter() [pm]
Experimental Aligns the steps of the patterns, creating polymeters. The patterns are repeated until they all fit the cycle. For example, in the below the first pattern is repeated twice, and the second is repeated three times, to fit the lowest common multiple of six steps.
```
// The same as note("{c eb g, c2 g2}%6")
polymeter("c eb g", "c2 g2").note()
```

## postgain()
Gain applied after all effects have been processed.
```
s("bd sd [~ bd] sd,hh*8")
.compressor("-20:20:10:.002:.02").postgain(1.5)
```

## prelease(time) [prel]
Release time of pitch envelope
- time: time in seconds
```
note("<c eb g bb> ~")
.release(.5) // to hear the pitch release
.prelease("<0 .1 .25 .5>")
```

## prepareInputBuffersToSend()
Copy contents of input buffers to buffer actually sent to process

## press()
Syncopates a rhythm, by shifting each event halfway into its timespan.
```
stack(s("hh*4"),
      s("bd mt sd ht").every(4, press)
     ).slow(2)
```

## pressBy()
Like press, but allows you to specify the amount by which each event is shifted. pressBy(0.5) is the same as press, while pressBy(1/3) shifts each event by a third of its timespan.
```
stack(s("hh*4"),
      s("bd mt sd ht").pressBy("<0 0.5 0.25>")
     ).slow(2)
```

## pure()
A discrete value that repeats once per cycle.
```
pure('e4') // "e4"
```

## pw(pulsewidth)
Controls the pulsewidth of the pulse oscillator
```
note("{f a c e}%16").s("pulse").pw(".8:1:.2")
```

## pwrate(rate)
Controls the lfo rate for the pulsewidth of the pulse oscillator
```
n(run(8)).scale("D:pentatonic").s("pulse").pw("0.5").pwrate("<5 .1 25>").pwsweep("<0.3 .8>")
```

## pwsweep(sweep)
Controls the lfo sweep for the pulsewidth of the pulse oscillator
```
n(run(8)).scale("D:pentatonic").s("pulse").pw("0.5").pwrate("<5 .1 25>").pwsweep("<0.3 .8>")
```

## queryArc(begin, end)
Query haps inside the given time span.
- begin: from time
- end: to time
```
const pattern = sequence('a', ['b', 'c'])
const haps = pattern.queryArc(0, 1)
console.log(haps)
silence
```

## rand()
A continuous pattern of random numbers, between 0 and 1.
```
// randomly change the cutoff
s("bd*4,hh*8").cutoff(rand.range(500,8000))
```

## rand2()
A continuous pattern of random numbers, between -1 and 1

## randL(n)
Creates a list of random numbers of the given length
- n: Number of random numbers to sample
```
s("saw").seg(16).n(irand(12)).scale("F1:minor")
  .partials(randL(8))
```

## randomSample()

## range()
Assumes a numerical pattern, containing unipolar values in the range 0 .. 1. Returns a new pattern with values scaled to the given min/max range. Most useful in combination with continuous patterns.
```
s("[bd sd]*2,hh*8")
.cutoff(sine.range(500,4000))
```

## range2()
Assumes a numerical pattern, containing bipolar values in the range -1 .. 1 Returns a new pattern with values scaled to the given min/max range.
```
s("[bd sd]*2,hh*8")
.cutoff(sine2.range2(500,4000))
```

## rangex()
Assumes a numerical pattern, containing unipolar values in the range 0 .. 1 Returns a new pattern with values scaled to the given min/max range, following an exponential curve.
```
s("[bd sd]*2,hh*8")
.cutoff(sine.rangex(500,4000))
```

## rarely()
Shorthand for `.sometimesBy(0.25, fn)`
```
s("hh*8").rarely(x=>x.speed("0.5"))
```

## ratio()
Allows dividing numbers via list notation using ":". Returns a new pattern with just numbers.
```
ratio("1, 5:4, 3:2").mul(110)
.freq().s("piano")
```

## readInputs()
Read next web audio block to input buffers

## reallocateChannelsIfNeeded()
Handles dynamic reallocation of input/output channels buffer (channel numbers may lety during lifecycle)

## ref()
exposes a custom value at query time. basically allows mutating state without evaluation

## register(name, func, patternify)
Registers a new pattern method. The method is added to the Pattern class + the standalone function is returned from register.
- name: name of the function, or an array of names to be used as synonyms
- func: function with 1 or more params, where last is the current pattern
- patternify: defaults to true; if set to false, you will have more control over the arguments to `func` as they will be in their raw form and it will be up to you to patternify them and/or query them for values
```
const vlpf = register('vlpf', (freq, pat) => {
  return pat.fmap((v) => ({...v, cutoff: freq * (v.velocity ?? 1) }));
})
s("saw").seg(8).velocity(rand).vlpf(800)
```

## release(time) [rel]
Amplitude envelope release time: The time it takes after the offset to go from sustain level to zero.
- time: release time in seconds
```
note("c3 e3 g3 c4").release("<0 .1 .4 .6 1>/2")
```

## removeUndefineds()
Returns a new pattern, with haps containing undefined values removed from query results.

## repeatCycles()
Repeats each cycle the given number of times.
```
note(irand(12).add(34)).segment(4).repeatCycles(2).s("gm_acoustic_guitar_nylon")
```

## replicate()
Experimental `replicate` is similar to `fast` in that it increases its density, but it also increases the step count accordingly. So `stepcat("a b".replicate(2), "c d")` would be the same as `"a b a b c d"`, whereas `stepcat("a b".fast(2), "c d")` would be the same as `"[a b] [a b] c d"`. TODO: find out how this function differs from extend
```
stepcat(
  sound("bd bd - cp").replicate(2),
  sound("bd - sd -")
).pace(8)
```

## reset()
Resets the pattern to the start of the cycle for each onset of the reset pattern.
```
s("[<bd lt> sd]*2, hh*8").reset("<x@3 x(5,8)>")
```

## restart()
Restarts the pattern for each onset of the restart pattern. While reset will only reset the current cycle, restart will start from cycle 0.
```
s("[<bd lt> sd]*2, hh*8").restart("<x@3 x(5,8)>")
```

## rev()
Reverse all cycles in a pattern. See also `revv` for reversing a whole pattern.
```
note("c d e g").rev()
```

## revv()
Reverse a whole pattern. See also `rev` for reversing each cycle.
```
// This is the same as `<[g e] [d c]>`. If `rev()` is used, you get
// the same as `<[d c] [g e]>`, where each cycle reverses, but the order of
// cycles stays the same.
note("<[c d] [e g]>").revv()
```

## ribbon(offset, cycles) [rib]
Loops the pattern inside an `offset` for `cycles`. If you think of the entire span of time in cycles as a ribbon, you can cut a single piece and loop it.
- offset: start point of loop in cycles
- cycles: loop length in cycles
```
note("<c d e f>").ribbon(1, 2)
```

## room(level)
Sets the level of reverb. When using mininotation, you can also optionally add the 'size' parameter, separated by ':'.
- level: between 0 and 1
```
s("bd sd [~ bd] sd").room("<0 .2 .4 .6 .8 1>")
```

## roomdim(frequency) [rdim]
Reverb lowpass frequency at -60dB (in hertz). When this property is changed, the reverb will be recaculated, so only change this sparsely..
- frequency: between 0 and 20000hz
```
s("bd sd [~ bd] sd").room(0.5).rlp(10000).rdim(8000)
```

## roomfade(seconds) [rfade]
Reverb fade time (in seconds). When this property is changed, the reverb will be recaculated, so only change this sparsely..
- seconds: for the reverb to fade
```
s("bd sd [~ bd] sd").room(0.5).rlp(10000).rfade(0.5)
```

## roomlp(frequency) [rlp]
Reverb lowpass starting frequency (in hertz). When this property is changed, the reverb will be recaculated, so only change this sparsely..
- frequency: between 0 and 20000hz
```
s("bd sd [~ bd] sd").room(0.5).rlp(10000)
```

## roomsize(size) [rsize, sz, size]
Sets the room size of the reverb, see `room`. When this property is changed, the reverb will be recaculated, so only change this sparsely..
- size: between 0 and 10
```
s("bd sd [~ bd] sd").room(.8).rsize(1)
```

## rootNotes(octave)
Maps the chords of the incoming pattern to root notes in the given octave.
- octave: octave to use
```
"<C^7 A7 Dm7 G7>".rootNotes(2).note()
```

## round()
Assumes a numerical pattern. Returns a new pattern with all values rounded to the nearest integer.
```
n("0.5 1.5 2.5".round()).scale("C:major")
```

## run()
A discrete pattern of numbers from 0 to n-1
```
n(run(4)).scale("C4:pentatonic")
// n("0 1 2 3").scale("C4:pentatonic")
```

## s(sound) [sound]
Select a sound / sample by name. When using mininotation, you can also optionally supply 'n' and 'gain' parameters separated by ':'.
- sound: The sound / pattern of sounds to pick
```
s("bd hh")
```

## samples()
Loads a collection of samples to use with `s`
```
samples('github:tidalcycles/dirt-samples');
s("[bd ~]*2, [~ hh]*2, ~ sd")
```

## saw()
A sawtooth signal between 0 and 1.
```
note("<c3 [eb3,g3] g2 [g3,bb3]>*8")
.clip(saw.slow(2))
```

## saw2()
A sawtooth signal between -1 and 1 (like `saw`, but bipolar).

## scale(scale)
Turns numbers into notes in the scale (zero indexed) or quantizes notes to a scale. When describing notes via numbers, note that negative numbers can be used to wrap backwards in the scale as well as sharps or flats to produce notes outside of the scale. Also sets scale for other scale operations, like {@link Pattern#scaleTranspose}. A scale consists of a root note (e.g. `c4`, `c`, `f#`, `bb4`) followed by semicolon (':') and then a scale type. The scale name must be written without spaces (because it would be interpreted as a multi-step pattern otherwise). If your scale name includes spaces, replace them with colons. The root note defaults to octave 3, if no octave number is given.
- scale: Name of scale
```
n("0 2 4 6 4 2").scale("C:major")
```

## scaleTranspose(offset) [scaleTrans, strans]
Transposes notes inside the scale by the number of steps. Expected to be called on a Pattern which already has a {@link Pattern#scale}
- offset: number of steps inside the scale
```
"-8 [2,4,6]"
.scale('C4 bebop major')
.scaleTranspose("<0 -1 -2 -3 -4 -5 -6 -4>")
.note()
```

## scope(config, align, color, thickness, scale, pos, trigger) [tscope]
Renders an oscilloscope for the time domain of the audio signal.
- config: optional config with options:
- align: if 1, the scope will be aligned to the first zero crossing. defaults to 1
- color: line color as hex or color name. defaults to white.
- thickness: line thickness. defaults to 3
- scale: scales the y-axis. Defaults to 0.25
- pos: y-position relative to screen height. 0 = top, 1 = bottom of screen
- trigger: amplitude value that is used to align the scope. defaults to 0.
```
s("sawtooth")._scope()
```

## scramble()
Slices a pattern into the given number of parts, then plays those parts at random. Similar to `shuffle`, but parts might be played more than once, or not at all, per cycle.
```
note("c d e f").sound("piano").scramble(4)
```

## scrub()
Allows you to scrub an audio file like a tape loop by passing values that represents the position in the audio file in the optional array syntax ex: "0.5:2", the second value controls the speed of playback
```
samples('github:switchangel/pad')
s("swpad:0").scrub("{0.1!2 .25@3 0.7!2 <0.8:1.5>}%8")
```

## seed(n)
Change the seed for random signals. Normally, random signals depend on time, so two patterns at the same time will have the same random values. Specifying a new seed changes the signal output by `rand`. This also affects other functions that use randomness, like `shuffle` and `sometimes`.
- n: A new seed. Can be any number.
```
$: s("hh*4").degrade();
$: s("bd*4").degrade().seed(1); // Will degrade different events from the hi-hat
```

## segment(segments) [seg]
Samples the pattern at a rate of n events per cycle. Useful for turning a continuous pattern into a discrete one.
- segments: number of segments per cycle
```
note(saw.range(40,52).segment(24))
```

## seq() [sequence, fastcat]
Like cat, but the items are crammed into one cycle.
```
seq("e5", "b4", ["d5", "c5"]).note()
// "e5 b4 [d5 c5]".note()
```

## seqPLoop()
Similarly to `arrange`, allows you to arrange multiple patterns together over multiple cycles. Unlike `arrange`, you specify a start and stop time for each pattern rather than duration, which means that patterns can overlap.
```
seqPLoop([0, 2, "bd(3,8)"],
         [1, 3, "cp(3,8)"]
        )
  .sound()
```

## sequence()
See `fastcat`

## sequenceP()
Takes a list of patterns, and returns a pattern of lists.

## setContext(context)
Returns a new pattern with the context field set to every hap set to the given value.

## setcpm(cpm)
Changes the global tempo to the given cycles per minute
- cpm: cycles per minute
```
setcpm(140/4) // =140 bpm in 4/4
$: s("bd*4,[- sd]*2").bank('tr707')
```

## setGainCurve(function)
Apply a function to all gains provided in patterns. Can be used to rescale gain to be quadratic, exponential, etc. rather than linear
- function: to apply to all gain values
```
setGainCurve((x) => x * x) // quadratic gain
s("bd*4").gain(0.5) // equivalent to 0.25 gain normally
```

## setMaxPolyphony(Max)
Set the max polyphony. If notes are ringing out via `release` then they will start to die out in first-in-first-out order once the max polyphony has been hit
- Max: polyphony. Defaults to 128
```
setMaxPolyphony(4)
n(irand(24).seg(8)).scale("C#3:minor").room(1).release(4).gain(0.5)
```

## shape(distortion)
(Deprecated) Wave shaping distortion. WARNING: can suddenly get unpredictably loud. Please use distort instead, which has a more predictable response curve second option in optional array syntax (ex: ".9:.5") applies a postgain to the output
- distortion: between 0 and 1
```
s("bd sd [~ bd] sd,hh*8").shape("<0 .2 .4 .6 .8>")
```

## shiftInputBuffers()
Shift left content of input buffers to receive new web audio block

## shiftOutputBuffers()
Shift left content of output buffers to receive new web audio block

## shiftPeaks()
Shift peaks and regions of influence by pitchFactor into new specturm

## showFirstCycle()
More human-readable version of the `firstCycleValues` accessor.

## shrink()
Experimental Progressively shrinks the pattern by 'n' steps until there's nothing left, or if a second value is given (using mininotation list syntax with `:`), that number of times. A positive number will progressively drop steps from the start of a pattern, and a negative number from the end.
```
"tha dhi thom nam".shrink("1").sound()
.bank("mridangam")
```

## shuffle()
Slices a pattern into the given number of parts, then plays those parts in random order. Each part will be played exactly once per cycle.
```
note("c d e f").sound("piano").shuffle(4)
```

## silence()
Does absolutely nothing..
```
silence // "~"
```

## sine()
A sine signal between 0 and 1.
```
n(sine.segment(16).range(0,15))
.scale("C:minor")
```

## sine2()
A sine signal between -1 and 1 (like `sine`, but bipolar).

## sinefold(distortion, volume)
Wavefolding distortion composed with sinusoid
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## slice()
Chops samples into the given number of slices, triggering those slices with a given pattern of slice numbers. Instead of a number, it also accepts a list of numbers from 0 to 1 to slice at specific points.
```
samples('github:tidalcycles/dirt-samples')
s("breaks165").slice(8, "0 1 <2 2*2> 3 [4 0] 5 6 7".every(3, rev)).slow(0.75)
```

## slow(factor) [sparsity]
Slow down a pattern over the given number of cycles. Like the "/" operator in mini notation.
- factor: slow down factor
```
s("bd hh sd hh").slow(2) // s("[bd hh sd hh]/2")
```

## slowcat() [cat]
Concatenation: combines a list of patterns, switching between them successively, one per cycle.
```
slowcat("e5", "b4", ["d5", "c5"])
```

## slowcatPrime(items)
Concatenation: combines a list of patterns, switching between them successively, one per cycle. Unlike slowcat, this version will skip cycles.
- items: The items to concatenate

## soft(distortion, volume)
Soft-clipping distortion
- distortion: amount of distortion to apply
- volume: linear postgain of the distortion

## someCycles()
Shorthand for `.someCyclesBy(0.5, fn)`
```
s("bd,hh*8").someCycles(x=>x.speed("0.5"))
```

## someCyclesBy(probability, function)
Randomly applies the given function by the given probability on a cycle by cycle basis. Similar to `sometimesBy`
- probability: a number between 0 and 1
- function: the transformation to apply
```
s("bd,hh*8").someCyclesBy(.3, x=>x.speed("0.5"))
```

## sometimes(function)
Applies the given function with a 50% chance
- function: the transformation to apply
```
s("hh*8").sometimes(x=>x.speed("0.5"))
```

## sometimesBy(probability, function)
Randomly applies the given function by the given probability. Similar to `someCyclesBy`
- probability: a number between 0 and 1
- function: the transformation to apply
```
s("hh*8").sometimesBy(.4, x=>x.speed("0.5"))
```

## sortHapsByPart()
Returns a new pattern, which returns haps sorted in temporal order. Mainly of use when comparing two patterns for equality, in tests.

## soundAlias(original, alias)
Register an alias for a sound.
- original: The original sound name
- alias: The alias to use for the sound

## source(getSource) [src]
Define a custom webaudio node to use as a sound source.

## spectrum(config, thickness, speed, min, max)
Renders a spectrum analyzer for the incoming audio signal.
- config: optional config with options:
- thickness: line thickness in px (default 3)
- speed: scroll speed (default 1)
- min: min db (default -80)
- max: max db (default 0)
```
n("<0 4 <2 3> 1>*3")
.off(1/8, add(n(5)))
.off(1/5, add(n(7)))
.scale("d3:minor:pentatonic")
.s('sine')
.dec(.3).room(.5)
._spectrum()
```

## speed(speed)
Changes the speed of sample playback, i.e. a cheap way of changing pitch.
- speed: inf to inf, negative numbers play the sample backwards.
```
s("bd*6").speed("1 2 4 1 -2 -4")
```

## splice()
Works the same as slice, but changes the playback speed of each slice to match the duration of its step.
```
samples('github:tidalcycles/dirt-samples')
s("breaks165")
.splice(8,  "0 1 [2 3 0]@2 3 0@2 7")
```

## splitQueries()
Returns a new pattern, with queries split at cycle boundaries. This makes some calculations easier to express, as all haps are then constrained to happen within a cycle.

## spread(spread)
Set the stereo pan spread for supported oscillators
- spread: between 0 and 1
```
note("d f a a# a d3").fast(2).s("supersaw").spread("<0 .3 1>")
```

## square()
A square signal between 0 and 1.
```
n(square.segment(4).range(0,7)).scale("C:minor")
```

## square2()
A square signal between -1 and 1 (like `square`, but bipolar).

## squeeze(pat, xs)
Pick from the list of values (or patterns of values) via the index using the given pattern of integers. The selected pattern will be compressed to fit the duration of the selecting event
```
note(squeeze("<0@2 [1!2] 2>", ["g a", "f g f g" , "g a c d"]))
```

## squiz(squiz)
Made by Calum Gunn. Reminiscent of some weird mixture of filter, ring-modulator and pitch-shifter. The SuperCollider manual defines Squiz as: "A simplistic pitch-raising algorithm. It's not meant to sound natural; its sound is reminiscent of some weird mixture of filter, ring-modulator and pitch-shifter, depending on the input. The algorithm works by cutting the signal into fragments (delimited by upwards-going zero-crossings) and squeezing those fragments in the time domain (i.e. simply playing them back faster than they came in), leaving silences inbetween. All the parameters apart from memlen can be modulated."
- squiz: Try passing multiples of 2 to it - 2, 4, 8 etc.
```
squiz("2 4/2 6 [8 16]").s("bd").osc()
```

## stack() [polyrhythm, pr]
The given items are played at the same time at the same length.
```
stack("g3", "b3", ["e4", "d4"]).note()
// "g3,b3,[e4 d4]".note()
```

## stepalt()
Experimental Concatenates patterns stepwise, according to an inferred 'steps per cycle'. Similar to `stepcat`, but if an argument is a list, the whole pattern will alternate between the elements in the list.
```
stepalt(["bd cp", "mt"], "bd").sound()
// The same as "bd cp bd mt bd".sound()
```

## stepcat() [timeCat, timecat]
'Concatenates' patterns like `fastcat`, but proportional to a number of steps per cycle. The steps can either be inferred from the pattern, or provided as a [length, pattern] pair. Has the alias `timecat`.
```
stepcat([3,"e3"],[1, "g3"]).note()
// the same as "e3@3 g3".note()
```

## stretch(factor)
Changes the speed of sample playback, i.e. a cheap way of changing pitch.
- factor: inf to inf, negative numbers play the sample backwards.
```
s("gm_flute").stretch("1 2 .5")
```

## striate()
Cuts each sample into the given number of parts, triggering progressive portions of each sample at each loop.
```
s("numbers:0 numbers:1 numbers:2").striate(6).slow(3)
```

## stripContext()
Returns a new pattern with the context field of every hap set to an empty object.

## struct()
Applies the given structure to the pattern:
```
note("c,eb,g")
  .struct("x ~ x ~ ~ x ~ x ~ ~ ~ x ~ x ~ ~")
  .slow(2)
```

## stut(times, feedback, time)
Deprecated. Like echo, but the last 2 parameters are flipped.
- times: how many times to repeat
- feedback: velocity multiplicator for each iteration
- time: cycle offset between iterations
```
s("bd sd").stut(3, .8, 1/6)
```

## sub()
Like add, but the given numbers are subtracted.
```
n("0 2 4".sub("<0 1 2 3>")).scale("C4:minor")
// See add for more information.
```

## superimpose()
Superimposes the result of the given function(s) on top of the original pattern:
```
"<0 2 4 6 ~ 4 ~ 2 0!3 ~!5>*8"
  .superimpose(x=>x.add(2))
  .scale('C minor').note()
```

## sustain(gain) [sus]
Amplitude envelope sustain level: The level which is reached after attack / decay, being sustained until the offset.
- gain: sustain level between 0 and 1
```
note("c3 e3 f3 g3").decay(.2).sustain("<0 .1 .4 .6 1>")
```

## swing(subdivision)
Shorthand for swingBy with 1/3:
```
s("hh*8").swing(4)
// s("hh*8").swingBy(1/3, 4)
```

## swingBy(subdivision, offset)
The function `swingBy x n` breaks each cycle into `n` slices, and then delays events in the second half of each slice by the amount `x`, which is relative to the size of the (half) slice. So if `x` is 0 it does nothing, `0.5` delays for half the note duration, and 1 will wrap around to doing nothing again. The end result is a shuffle or swing-like rhythm
```
s("hh*8").swingBy(1/3, 4)
```

## tables()
Loads a collection of wavetables to use with `s`

## tag(tag)
Tags each Hap with an identifier. Good for filtering. The function populates Hap.context.tags (Array).
- tag: anything unique
```
s("saw!16").note("F1")
  .lpf(tri.range(40, 80).slow(4)).lpenv(5).lpq(4).lpd(0.15)
  .when(rand.late(0.1).gte(0.5), x => x.transpose("12").tag('altered'))
  .when(rand.late(0.2).gte(0.5), x => x.s("square").tag('altered'))
  .when("<0 1>", x => x.filter((hap) => hap.hasTag('altered')))
```

## take()
Experimental Takes the given number of steps from a pattern (dropping the rest). A positive number will take steps from the start of a pattern, and a negative number from the end.
```
"bd cp ht mt".take("2").sound()
// The same as "bd cp".sound()
```

## time()
A signal representing the cycle time.

## timecat()
Aliases for `stepcat`

## toBipolar()
Assumes a numerical pattern, containing unipolar values in the range 0 .. Returns a new pattern with values scaled to the bipolar range -1 .. 1

## tour()
Experimental Inserts a pattern into a list of patterns. On the first repetition it will be inserted at the end of the list, then moved backwards through the list on successive repetitions. The patterns are added together stepwise, with all repetitions taking place over a single cycle. Using `pace` to set the number of steps per cycle is therefore usually recommended.
```
"[c g]".tour("e f", "e f g", "g f e c").note()
   .sound("folkharp")
   .pace(8)
```

## transient(attack, sustain)
Transient shaper. Gives independent control over the emphasis on transients and sustains
- attack: Emphasis on transients; between -1 (deaccentuate) and 1 (accentuate)
- sustain: Emphasis on the sustains; between -1 (deaccentuate) and 1 (accentuate)
```
s("bd").transient("<-1 -0.5 0 0.5 1>")
```

## transpose(amount) [trans]
Change the pitch of each value by the given amount. Expects numbers or note strings as values. The amount can be given as a number of semitones or as a string in interval short notation. If you don't care about enharmonic correctness, just use numbers. Otherwise, pass the interval of the form: ST where S is the degree number and T the type of interval with M = major m = minor P = perfect A = augmented d = diminished Examples intervals: 1P = unison 3M = major third 3m = minor third 4P = perfect fourth 4A = augmented fourth 5P = perfect fifth 5d = diminished fifth
- amount: Either number of semitones or interval string.
```
"c2 c3".fast(2).transpose("<0 -2 5 3>".slow(2)).note()
```

## tremolo(speed) [trem]
Modulate the amplitude of a sound with a continuous waveform
- speed: modulation speed in HZ
```
note("d d d# d".fast(4)).s("supersaw").tremolo("<3 2 100> ").tremoloskew("<.5>")
```

## tremolodepth(depth) [tremdepth]
Depth of amplitude modulation
```
note("a1 a1 a#1 a1".fast(4)).s("pulse").tremsync(4).tremolodepth("<1 2 .7>")
```

## tremolophase(offset) [tremphase]
Alter the phase of the modulation waveform
- offset: the offset in cycles of the modulation
```
note("{f a c e}%16").s("sawtooth").tremsync(4).tremolophase("<0 .25 .66>")
```

## tremoloshape(shape) [tremshape]
Shape of amplitude modulation
- shape: tri | square | sine | saw | ramp
```
note("{f g c d}%16").tremsync(4).tremoloshape("<sine tri square>").s("sawtooth")
```

## tremoloskew(amount) [tremskew]
Alter the shape of the modulation waveform
- amount: between 0 & 1, the shape of the waveform
```
note("{f a c e}%16").s("sawtooth").tremsync(4).tremoloskew("<.5 0 1>")
```

## tremolosync(cycles) [tremsync]
Modulate the amplitude of a sound with a continuous waveform
- cycles: modulation speed in cycles
```
note("d d d# d".fast(4)).s("supersaw").tremolosync("4").tremoloskew("<1 .5 0>")
```

## tri()
A triangle signal between 0 and 1.
```
n(tri.segment(8).range(0,7)).scale("C:minor")
```

## tri2()
A triangle signal between -1 and 1 (like `tri`, but bipolar).

## undegrade()
Inverse of `degrade`: Randomly removes 50% of events from the pattern. Shorthand for `.undegradeBy(0.5)` Events that would be removed by degrade are let through by undegrade and vice versa (see second example).
```
s("hh*8").undegrade()
```

## undegradeBy(amount)
Inverse of `degradeBy`: Randomly removes events from the pattern by a given amount. 0 = 100% chance of removal 1 = 0% chance of removal Events that would be removed by degradeBy are let through by undegradeBy and vice versa (see second example).
- amount: a number between 0 and 1
```
s("hh*8").undegradeBy(0.2)
```

## unison(numvoices)
Set number of stacked voices for supported oscillators
```
note("d f a a# a d3").fast(2).s("supersaw").unison("<1 2 7>")
```

## unit(unit)
Used in conjunction with `speed`, accepts values of "r" (rate, default behavior), "c" (cycles), or "s" (seconds). Using `unit "c"` means `speed` will be interpreted in units of cycles, e.g. `speed "1"` means samples will be stretched to fill a cycle. Using `unit "s"` means the playback speed will be adjusted so that the duration is the number of seconds specified by `speed`.
- unit: see description above
```
speed("1 2 .5 3").s("bd").unit("c").osc()
```

## useRNG(mod)
Sets which random number generator to use. Historically Strudel would use `useRNG('legacy')`, which remains the default. To use a new more statistically precise RNG, try `useRNG('precise')`.
- mod: Mode. One of 'legacy', 'precise'
```
useRNG('legacy')
// Repeats every 300 cycles
$: n(irand(50)).seg(16).scale("C:minor").ribbon(88, 32)
$: n(irand(50)).seg(16).scale("C:minor").ribbon(388, 32)
```

## velocity() [vel]
Sets the velocity from 0 to 1. Is multiplied together with gain.
```
s("hh*8")
.gain(".4!2 1 .4!2 1 .4 1")
.velocity(".4 1")
```

## vib(frequency) [vibrato, v]
Applies a vibrato to the frequency of the oscillator.
- frequency: of the vibrato in hertz
```
note("a e")
.vib("<.5 1 2 4 8 16>")
._scope()
```

## vibmod(depth) [vmod]
Sets the vibrato depth in semitones. Only has an effect if `vibrato` | `vib` | `v` is is also set
- depth: of vibrato (in semitones)
```
note("a e").vib(4)
.vibmod("<.25 .5 1 2 12>")
._scope()
```

## voicing()
Turns chord symbols into voicings. You can use the following control params: `chord`: Note, followed by chord symbol, e.g. C Am G7 Bb^7 `dict`: voicing dictionary to use, falls back to default dictionary `anchor`: the note that is used to align the chord `mode`: how the voicing is aligned to the anchor `below`: top note <= anchor `duck`: top note <= anchor, anchor excluded `above`: bottom note >= anchor `offset`: whole number that shifts the voicing up or down to the next voicing `n`: if set, the voicing is played like a scale. Overshooting numbers will be octaved All of the above controls are optional, except `chord`. If you pass a pattern of strings to voicing, they will be interpreted as chords.
```
n("0 1 2 3").chord("<C Am F G>").voicing()
```

## voicings(dictionary)
DEPRECATED: still works, but it is recommended you use .voicing instead (without s). Turns chord symbols into voicings, using the smoothest voice leading possible. Uses chord-voicings package.
- dictionary: which voicing dictionary to use.
```
stack("<C^7 A7 Dm7 G7>".voicings('lefthand'), "<C3 A2 D3 G2>").note()
```

## vowel(vowel)
Formant filter to make things sound like vowels.
- vowel: You can use a e i o u ae aa oe ue y uh un en an on, corresponding to [a] [e] [i] [o] [u] [æ] [ɑ] [ø] [y] [ɯ] [ʌ] [œ̃] [ɛ̃] [ɑ̃] [ɔ̃]. Aliases: aa = å = ɑ, oe = ø = ö, y = ı, ae = æ.
```
note("[c2 <eb2 <g2 g1>>]*2").s('sawtooth')
.vowel("<a e i <o u>>")
```

## warp(amount) [wavetableWarp]
Amount of warp (alteration of the waveform) to apply to the wavetable oscillator
- amount: Warp of the wavetable from 0 to 1
```
s("basique").bank("wt_digital").seg(8).note("F1").warp("0 0.25 0.5 0.75 1")
  .warpmode("spin")
```

## warpattack(time) [warpatt]
Attack time of the wavetable oscillator's warp envelope
- time: attack time in seconds

## warpdc(dcoffset)
DC offset of the LFO for the wavetable oscillator's warp
- dcoffset: dc offset. set to 0 for unipolar

## warpdecay(time) [warpdec]
Decay time of the wavetable oscillator's warp envelope
- time: decay time in seconds

## warpdepth(depth)
Depth of the LFO for the wavetable oscillator's warp
- depth: depth of modulation

## warpenv(amount)
Amount of envelope applied wavetable oscillator's position envelope
- amount: between 0 and 1

## warpmode(mode) [wavetableWarpMode]
Type of warp (alteration of the waveform) to apply to the wavetable oscillator. The current options are: none, asym, bendp, bendm, bendmp, sync, quant, fold, pwm, orbit, spin, chaos, primes, binary, brownian, reciprocal, wormhole, logistic, sigmoid, fractal, flip
- mode: Warp mode
```
s("morgana").bank("wt_digital").seg(8).note("F1").warp("0 0.25 0.5 0.75 1")
  .warpmode("<asym bendp spin logistic sync wormhole brownian>*2")
```

## warprate(rate)
Rate of the LFO for the wavetable oscillator's warp
- rate: rate in hertz

## warprelease(time) [warprel]
Release time of the wavetable oscillator's warp envelope
- time: release time in seconds

## warpshape(shape)
Shape of the LFO for the wavetable oscillator's warp
- shape: Shape of the lfo (0, 1, 2, ..)

## warpskew(skew)
Skew of the LFO for the wavetable oscillator's warp
- skew: How much to bend the LFO shape

## warpsustain(gain) [warpsus]
Sustain time of the wavetable oscillator's warp envelope
- gain: sustain level (0 to 1)

## warpsync(rate)
cycle synced rate of the LFO for the wavetable warp position
- rate: rate in cycles

## wchoose(pairs)
Chooses randomly from the given list of elements by giving a probability to each element
- pairs: arrays of value and weight
```
note("c2 g2!2 d2 f1").s(wchoose(["sine",10], ["triangle",1], ["bd:6",1]))
```

## wchooseCycles() [wrandcat]
Picks one of the elements at random each cycle by giving a probability to each element
```
wchooseCycles(["bd",10], ["hh",1], ["sd",1]).s().fast(8)
```

## when(binary_pat, func)
Applies the given function whenever the given pattern is in a true state.
```
"c3 eb3 g3".when("<0 1>/2", x=>x.sub("5")).note()
```

## whenKey()
Do something on a keypress, or array of keypresses Key name reference
```
s("bd(5,8)").whenKey("Control:j", x => x.segment(16).color("red")).whenKey("Control:i", x => x.fast(2).color("blue"))
```

## withContext(func)
Returns a new pattern with the given function applied to the context field of every hap.

## withHap(func)
As with `withHaps`, but applies the function to every hap, rather than every list of haps.

## withHaps(func)
Returns a new pattern with the given function applied to the list of haps returned by every query.

## withHapSpan(func)
Similar to `withQuerySpan`, but the function is applied to the timespans of all haps returned by pattern queries (both `part` timespans, and where present, `whole` timespans).

## withHapTime(func)
As with `withHapSpan`, but the function is applied to both the begin and end time of the hap timespans.
- func: the function to apply

## within(start, end, func)
Use within to apply a function to only a part of a pattern.
- start: start within cycle (0 - 1)
- end: end within cycle (0 - 1). Must be > start
- func: function to be applied to the sub-pattern

## withLoc(start, end)
Returns a new pattern with the given location information added to the context of every hap.
- start: start offset
- end: end offset

## withQuerySpan(func)
Returns a new pattern, where the given function is applied to the query timespan before passing it to the original pattern.
- func: the function to apply

## withQueryTime(func)
As with `withQuerySpan`, but the function is applied to both the begin and end time of the query timespan.
- func: the function to apply

## withSeed(func, pat)
Modify a pattern by applying a function to the `randomSeed` control if present
- func: Function from seed (or undefined) to seed (or undefined)
- pat: Pattern to update

## withValue(func) [fmap]
Returns a new pattern, with the function applied to the value of each hap. It has the alias `fmap`.
- func: to to apply to the value
```
"0 1 2".withValue(v => v + 10).log()
```

## worklet(src, inputs)
Creates a worklet effect. Typically derived by writing K(...) in the REPL which will parse Kabelsalat code.
- src: Source code of the worklet update function
- inputs: Worklet inputs

## writeOutputs()
Write next web audio block from output buffers

## wt(position) [wavetablePosition]
Position in the wavetable of the wavetable oscillator
- position: Position in the wavetable from 0 to 1
```
s("squelch").bank("wt_digital").seg(8).note("F1").wt("0 0.25 0.5 0.75 1")
```

## wtattack(time) [wtatt]
Attack time of the wavetable oscillator's position envelope
- time: attack time in seconds

## wtdc(dcoffset)
DC offset of the LFO for the wavetable oscillator's position
- dcoffset: dc offset. set to 0 for unipolar

## wtdecay(time) [wtdec]
Decay time of the wavetable oscillator's position envelope
- time: decay time in seconds

## wtdepth(depth)
Depth of the LFO for the wavetable oscillator's position
- depth: depth of modulation

## wtenv(amount)
Amount of envelope applied wavetable oscillator's position envelope
- amount: between 0 and 1

## wtphaserand(amount) [wavetablePhaseRand]
Amount of randomness of the initial phase of the wavetable oscillator.
- amount: Randomness of the initial phase. Between 0 (not random) and 1 (fully random)
```
s("basique").bank("wt_digital").seg(16).wtphaserand("<0 1>")
```

## wtrate(rate)
Rate of the LFO for the wavetable oscillator's position
- rate: rate in hertz

## wtrelease(time) [wtrel]
Release time of the wavetable oscillator's position envelope
- time: release time in seconds

## wtshape(shape)
Shape of the LFO for the wavetable oscillator's position
- shape: Shape of the lfo (0, 1, 2, ..)

## wtskew(skew)
Skew of the LFO for the wavetable oscillator's position
- skew: How much to bend the LFO shape

## wtsustain(gain) [wtsus]
Sustain time of the wavetable oscillator's position envelope
- gain: sustain level (0 to 1)

## wtsync(rate)
cycle synced rate of the LFO for the wavetable oscillator's position
- rate: rate in cycles

## xfade()
Cross-fades between left and right from 0 to 1: 0 = (full left, no right) .5 = (both equal) 1 = (no left, full right)
```
xfade(s("bd*2"), "<0 .25 .5 .75 1>", s("hh*8"))
```

## zip()
Experimental 'zips' together the steps of the provided patterns. This can create a long repetition, taking place over a single, dense cycle. Using `pace` to set the number of steps per cycle is therefore usually recommended.
```
zip("e f", "e f g", "g [f e] a f4 c").note()
   .sound("folkharp")
   .pace(8)
```

## zoom()
Plays a portion of a pattern, specified by the beginning and end of a time span. The new resulting pattern is played over the time period of the original pattern:
```
s("bd*2 hh*3 [sd bd]*2 perc").zoom(0.25, 0.75)
// s("hh*3 [sd bd]*2") // equivalent
```
