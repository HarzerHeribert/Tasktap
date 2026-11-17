# Tasktap motion lab: notes

Open it from a local server, because the microphone needs a secure origin:

    cd design/motion-lab && python3 -m http.server 8377     # then http://localhost:8377

Files: `index.html` (the page), `lab.js` (stage, states, palettes, cost readout), `voice.js` (microphone and simulated voice), `shaders.js` (the shared studio and chrome, and one fragment shader per concept). No build step, no libraries, nothing loaded from the network.

## What is shared

Every concept reflects the same procedural studio: a dark room, a wide key overhead, a tall cool strip on the left, a warm strip on the right, two hairlines near the camera, kickers and a lit wall behind for the rims, a warm bounce off the floor. The metal is a mirror with Fresnel, the three colour channels reflected slightly apart (the chromatic edge), and a thin-film sheen in the iridescent palette. Palettes change the colour of the lights, never the metal. Each state has a signal light low in front: amber for needs you, pale green for done, dull red with the room dimmed for failed.

The voice is reduced to a handful of numbers (`voice.js`): loudness, a fast loudness, onsets, brightness, voiced loudness (vowels), hiss, pitch, and two seconds of history that the shaders read as a texture. Vowels swell forms; consonants flick highlights; silence releases over about a quarter of a second.

## The concepts

**1. Slats.** The app icon brought to life: 21 polished slats whose heights are the loudness travelling outward from the centre, drawn into the icon's S. Each slat stands slightly turned and twisted, and a consonant sends a turn through them, so the studio's strips flick across the faces. Strong at every size down to the 76 × 28 corner; the nearest of the six to a level meter, which the turning light and the S-shaped pose are there to prevent. Cost: very light, one slat per pixel and no loops.

**2. Ribbon.** The 1.2 phase field as one band of chrome with a bronze back. Speech enters at the left and runs along it as soft swells; a bright voice adds a finer wave, a consonant kicks a twist. Thinking winds it into a turning helix, done lays it flat, failed lets it sag edge-on. The most sculptural when large and it thins to a clean wire in the notch, but it is the least like the icon. Cost: very light.

**3. Drop.** The agent-orb idea in chrome: a sphere at rest that speech draws out into a long liquid body with swells running along it, and that surface tension pulls round again in silence. Consonants ripple the skin. The return to a sphere is the nicest silence of the six and the reflections are the most liquid; it is the least tied to the brand, the orb reads a little like a glass ball, and at 28 px it is only a bright pill. Cost: light.

**4. Resonator.** The 1.2 resonator in real time: a stack of rounded-square chrome rings whose sizes are the wave, seen at three-quarters; it is the icon turned in space. Loudness sizes the rings, consonants roll them so a twist runs down the stack, needs-you turns it towards you. The richest metal by a distance (rings seen through rings, with exact antialiasing because the rings are solved, not ray-marched), but it needs room: at notch sizes it is a ribbed tube, and very loud speech tangles it. Cost: the heaviest, still small.

**5. Glyphs.** Chrome type on the waveform, continuing the 1.2 dictation strip: plus, equals, slash and colon grow in columns where the voice is, lean with rising speech and spin on a consonant. Thinking, where each glyph turns edge-on and comes back as another character, is the best thinking state of the six; done turns everything into equals signs; failed drops a row of slashes. The most characterful, and the only one that says "this becomes text", but busy when large and only texture at 28 px. Cost: light.

**6. Lumen.** The icon never moves; the voice is light. Loudness becomes coloured light in the air behind the slats, leaving the centre as you speak, and a beam walks across the metal and jumps on consonants. It takes colour best because the colour is light and the chrome stays chrome, and it is the glow-behind-the-notch idea made whole. In silence it is nearly dark, and the form itself says nothing about the words. Cost: very light, and the geometry is constant, so the app could cache it.

## Ranking

1. **Slats.** It is the icon, at every size, in every state, and it is the cheapest. Someone who has seen the Dock icon recognises the notch at a glance. Its states are legible without colour: a packet shuttling (thinking), the logo's slow wandering hump (working), a gathered double beat (needs you), an even lens with one pass of light (done), a slumped row (failed).
2. **Lumen.** Not as a rival but as Slats' other half: same geometry, and it answers "other colours" without painting the metal. Its light is what should spill from behind the collapsed notch.
3. **Resonator.** The best-looking large object; keep it for Home and other big, calm surfaces, where 1.2 used the Blender loop.
4. **Glyphs.** Worth keeping for one moment: the thinking shuffle while a spoken thought becomes text.
5. **Ribbon.** Elegant and cheap, but a second identity next to the bars.
6. **Drop.** The most generic, and the weakest small.

Recommendation: Slats as the signature in the notch and the corner box, with Lumen's light as the glow behind the collapsed notch (one shader can do both: the same slats, with a control for how much the form moves and how much the light does). Resonator for Home.

## Taking Slats into the app

- Lift `HEAD` and the Slats shader into one small module with a single WebGL 2 canvas per surface (the 76 × 28 box and the collapsed strip are 152 × 56 and 400 × 64 device pixels). Keep the static icon as the fallback when WebGL 2 is missing.
- Feed it from the core's existing microphone level stream, the one `prototype/voice-wave.js` sampled. Loudness alone already drives heights, and onsets can be taken from its rise; brightness and the spectrum are refinements that need a few band energies sent alongside the level.
- Map the app's run states onto the seven here, and keep the transitions as parameter blends (about 0.3 s) so nothing cuts.
- Keep the drawing policy: draw at 60 a second only while someone speaks or a state is changing, 30 while working, 20 or less when idle, nothing at all once done or failed has settled, when the notch is hidden, or under Reduce Motion (which holds a still pose and lets only brightness follow a slow level).
- Give the native glow the same few numbers (level, the palette's two colours, the state's signal colour) rather than pixels, so the glow and the notch agree without sharing a surface.
- Measure on battery on an older integrated GPU before committing; the numbers below are from an M4 Pro.

## Measured

Headless Chromium on a real GPU (ANGLE Metal, Apple M4 Pro), device scale 2, simulated voice, listening:

| | hero 2080 × 946 px | icon 224² | corner 152 × 56 | collapsed 400 × 64 |
|---|---|---|---|---|
| Slats | 1.5 ms | 0.3 | 0.2 | 0.2 |
| Ribbon | 1.5 | 0.3 | 0.2 | 0.2 |
| Drop | 1.5 | 0.3 | 0.2 | 0.2 |
| Resonator | 2.5 | 0.4 | 0.3 | 0.3 |
| Glyphs | 0.8 | 0.3 | 0.3 | 0.2 |
| Lumen | 1.6 | 0.3 | 0.3 | 0.3 |

These are from the page's Measure button, which waits for the GPU after every frame; about 0.2 ms of each figure is that wait, so the small sizes are at the floor of what this method can see. The GPU timer query agreed: 1.3 to 3.1 ms for the hero, 0.25 to 0.45 ms for all three small sizes together. Page work (JavaScript and submitting the draws) was 0.15 to 0.35 ms a frame. The first frame of a concept compiles its shader, once, for about 15 ms.

## Not done, or not verified

- Not run in Safari: only Chromium is installed for headless use here. The code keeps to standard WebGL 2 and Web Audio, creates the audio context inside the click, and shows a plain message if WebGL 2 is missing.
- The microphone path was exercised with Chromium's fake device fed real speech from `say`, not with a physical microphone. That signal is hotter than a laptop microphone, so the default sensitivity may want a nudge.
- The motion was judged from stills and short frame sequences, not watched live.
- The light backdrop is the weak view: chrome on white is pale by nature, and the studio is only inverted for it, not redesigned.
- The glow behind the collapsed notch is one shared 2D approximation (the strip's own pixels pushed past the edge, plus palette light along the lower edge), not a per-concept design.
- Idle keeps a slow drift at 20 frames a second rather than stopping; done, failed and Reduce Motion stop completely.
