/**
 * rbj_demo.js
 * =====================================================================
 * Interactive RBJ (Audio EQ Cookbook) biquad filter demo for the IIR
 * filters article. Hydrates the #rbj-demo-mount element inserted by
 * markdown_article.js (in place of the "EXAMPLE HERE" paragraph) once the
 * article HTML is in the DOM.
 *
 * WHAT IT DOES: lets the reader pick an RBJ filter type from a dropdown,
 * drag sliders for frequency (f0) / Q / gain, watch a live frequency
 * response graph redraw as they do, and play/pause a loop of pink noise
 * that's actually being filtered through the exact same coefficients
 * shown in the graph and the coefficients readout.
 *
 * HOW PLAYBACK WORKS (the short version -- see rbj-processor.js for the
 * full explanation): audio runs through a custom AudioWorklet processor
 * that keeps its own filter "memory" alive continuously. Moving a slider
 * just sends it new coefficients to smoothly glide toward over ~12ms --
 * it does NOT recreate any audio node, so the sound never stops or
 * restarts. Very old browsers without AudioWorklet support fall back to
 * recreating a built-in IIRFilterNode on every change instead (with a
 * quick gain "duck" to soften the resulting click) -- see the `backend`
 * variable and the two branches inside updateFilter()/play()/pause().
 *
 * HOW THE GRAPH WORKS: independently of any of the above, magnitudeDb()
 * computes the filter's frequency response with plain JS math (evaluating
 * the standard biquad transfer function on the unit circle). This means
 * the graph always works, draws instantly, and needs no audio hardware --
 * even in the "no playback support at all" case, you still see the curve.
 *
 * ---------------------------------------------------------------------
 * QUICK EDITING GUIDE
 * ---------------------------------------------------------------------
 * - To ADD/REMOVE a filter type: edit the FILTER_TYPES array below, AND
 *   add/remove the matching `case` in computeCoefficients().
 * - To CHANGE THE FREQUENCY/Q/GAIN RANGES the sliders cover: edit the
 *   FREQ_MIN/FREQ_MAX/Q_MIN/Q_MAX/GAIN_MIN/GAIN_MAX constants below.
 * - To CHANGE THE GRAPH'S LOOK (colors, gridlines, dB range): edit
 *   drawResponse().
 * - To CHANGE HOW SMOOTH/RESPONSIVE parameter changes sound: edit the
 *   `rampMs` values passed to filterNode.port.postMessage() (search for
 *   "rampMs:" below), or the ramp logic itself in rbj-processor.js.
 * - To CHANGE THE DEMO'S HTML STRUCTURE/CLASSES: edit buildControlsHtml(),
 *   and update assets/styles/rbj_demo.css to match.
 * - To CHANGE THE PINK NOISE SOUND/VOLUME: edit createPinkNoiseBuffer()
 *   (the noise color/algorithm) or volumeToGain() (the volume slider's
 *   min/max loudness).
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // The 9 RBJ filter types this demo supports, in the order they appear
    // in the dropdown. `hasGain` controls whether the Gain slider is
    // enabled for that type (only Peaking/Low Shelf/High Shelf use it --
    // see the "gainGroup.classList.toggle" line inside updateFilter()).
    // The `id` values here MUST exactly match the `case` labels in
    // computeCoefficients() below.
    // ---------------------------------------------------------------------
    var FILTER_TYPES = [
        { id: 'lowpass', label: 'Low-Pass (LPF)', hasGain: false },
        { id: 'highpass', label: 'High-Pass (HPF)', hasGain: false },
        { id: 'bandpass-skirt', label: 'Band-Pass — constant skirt gain', hasGain: false },
        { id: 'bandpass-peak', label: 'Band-Pass — constant peak gain', hasGain: false },
        { id: 'notch', label: 'Notch', hasGain: false },
        { id: 'allpass', label: 'All-Pass (APF)', hasGain: false },
        { id: 'peaking', label: 'Peaking / Bell', hasGain: true },
        { id: 'lowshelf', label: 'Low Shelf', hasGain: true },
        { id: 'highshelf', label: 'High Shelf', hasGain: true }
    ];

    // ---- slider ranges. The frequency slider is logarithmic (see
    // freqFromSlider/sliderFromFreq below) so it feels natural to drag --
    // an equal amount of slider travel roughly corresponds to an equal
    // number of "musical" octaves/semitones, matching how humans perceive
    // pitch, rather than an equal number of Hz. ----
    var FREQ_MIN = 20;     // Hz -- low end of human hearing
    var FREQ_MAX = 20000;  // Hz -- high end of human hearing
    var Q_MIN = 0.1;
    var Q_MAX = 18;
    var GAIN_MIN = -24;    // dB, only used by Peaking/Low Shelf/High Shelf
    var GAIN_MAX = 24;     // dB

    // Path to the AudioWorklet processor module (see rbj-processor.js).
    // Must be loaded via audioCtx.audioWorklet.addModule() before an
    // AudioWorkletNode using it can be constructed -- see the `backend`
    // setup further down in initDemo().
    var WORKLET_URL = '/assets/apps/rbj-processor.js';

    // =====================================================================
    // computeCoefficients(type, f0, q, dbGain, fs)
    // =====================================================================
    // The actual RBJ / Audio EQ Cookbook formulas, transcribed directly
    // from the "The RBJ Filters" section of article.md. If you ever change
    // a formula in the article, mirror the change here too (and vice
    // versa) so the write-up and the interactive demo always agree.
    //
    // Inputs:
    //   type   - one of the FILTER_TYPES[].id strings above
    //   f0     - characteristic frequency in Hz
    //   q      - the Q parameter (see the article's explanation of "how
    //            peaky/steep" a filter is)
    //   dbGain - gain in dB; only meaningful for peaking/shelf types, pass
    //            0 for the others (see updateFilter()'s
    //            `type.hasGain ? params.gain : 0`)
    //   fs     - sample rate in Hz (audioCtx.sampleRate, or 44100 as a
    //            fallback when there's no AudioContext at all -- see
    //            updateFilter())
    //
    // Returns { b0, b1, b2, a0, a1, a2 } -- the raw (NOT yet normalized by
    // a0) biquad coefficients, matching the difference equation from the
    // article:
    //
    //   y[n] = (1/a0) * ( b0*x[n] + b1*x[n-1] + b2*x[n-2]
    //                     - a1*y[n-1] - a2*y[n-2] )
    //
    // Both playback backends divide by a0 themselves at the point they
    // actually use these coefficients (see the `/coeffs.a0` divisions in
    // updateFilter() for the worklet path, and IIRFilterNode's own
    // automatic a0-normalization for the legacy path).
    // =====================================================================
    function computeCoefficients(type, f0, q, dbGain, fs) {
        var A = Math.pow(10, dbGain / 40);       // only used by peaking/shelf formulas
        var w0 = 2 * Math.PI * f0 / fs;           // normalized angular frequency
        var cw = Math.cos(w0);
        var sw = Math.sin(w0);
        var alpha = sw / (2 * q);
        var sqrtA = Math.sqrt(A);                 // only used by shelf formulas

        var b0, b1, b2, a0, a1, a2;

        switch (type) {
            case 'lowpass':
                b0 = (1 - cw) / 2;
                b1 = 1 - cw;
                b2 = (1 - cw) / 2;
                a0 = 1 + alpha;
                a1 = -2 * cw;
                a2 = 1 - alpha;
                break;
            case 'highpass':
                b0 = (1 + cw) / 2;
                b1 = -(1 + cw);
                b2 = (1 + cw) / 2;
                a0 = 1 + alpha;
                a1 = -2 * cw;
                a2 = 1 - alpha;
                break;
            case 'bandpass-skirt': // constant skirt gain, peak gain = Q
                b0 = sw / 2;
                b1 = 0;
                b2 = -sw / 2;
                a0 = 1 + alpha;
                a1 = -2 * cw;
                a2 = 1 - alpha;
                break;
            case 'bandpass-peak': // constant 0dB peak gain
                b0 = alpha;
                b1 = 0;
                b2 = -alpha;
                a0 = 1 + alpha;
                a1 = -2 * cw;
                a2 = 1 - alpha;
                break;
            case 'notch':
                b0 = 1;
                b1 = -2 * cw;
                b2 = 1;
                a0 = 1 + alpha;
                a1 = -2 * cw;
                a2 = 1 - alpha;
                break;
            case 'allpass': // unity magnitude at every frequency -- only the phase response changes
                b0 = 1 - alpha;
                b1 = -2 * cw;
                b2 = 1 + alpha;
                a0 = 1 + alpha;
                a1 = -2 * cw;
                a2 = 1 - alpha;
                break;
            case 'peaking':
                b0 = 1 + alpha * A;
                b1 = -2 * cw;
                b2 = 1 - alpha * A;
                a0 = 1 + alpha / A;
                a1 = -2 * cw;
                a2 = 1 - alpha / A;
                break;
            case 'lowshelf':
                // Careful with the +/- signs here -- see the article's warning
                // in "Low Shelf" about how easy these are to transcribe wrong.
                b0 = A * ((A + 1) - (A - 1) * cw + 2 * alpha * sqrtA);
                b1 = 2 * A * ((A - 1) - (A + 1) * cw);
                b2 = A * ((A + 1) - (A - 1) * cw - 2 * alpha * sqrtA);
                a0 = (A + 1) + (A - 1) * cw + 2 * alpha * sqrtA;
                a1 = -2 * ((A - 1) + (A + 1) * cw);
                a2 = (A + 1) + (A - 1) * cw - 2 * alpha * sqrtA;
                break;
            case 'highshelf':
                b0 = A * ((A + 1) + (A - 1) * cw + 2 * alpha * sqrtA);
                b1 = -2 * A * ((A - 1) + (A + 1) * cw);
                b2 = A * ((A + 1) + (A - 1) * cw - 2 * alpha * sqrtA);
                a0 = (A + 1) - (A - 1) * cw + 2 * alpha * sqrtA;
                a1 = 2 * ((A - 1) - (A + 1) * cw);
                a2 = (A + 1) - (A - 1) * cw - 2 * alpha * sqrtA;
                break;
            default:
                throw new Error('Unknown RBJ filter type: ' + type);
        }

        return { b0: b0, b1: b1, b2: b2, a0: a0, a1: a1, a2: a2 };
    }

    /**
     * Evaluates the biquad's frequency response at a single frequency `f`,
     * returning the magnitude in dB. This is pure math -- no Web Audio
     * node involved -- so the graph works even when no playback backend
     * is available at all.
     *
     * THE MATH: the biquad's z-domain transfer function is
     *
     *   H(z) = (b0 + b1*z^-1 + b2*z^-2) / (a0 + a1*z^-1 + a2*z^-2)
     *
     * To get the frequency response, evaluate H at z = e^(jw) where
     * w = 2*pi*f/fs (a point on the unit circle). That makes z^-1 and
     * z^-2 into complex numbers (reZ1 + i*imZ1, reZ2 + i*imZ2 below); the
     * rest of the function is just complex arithmetic (multiply b0/b1/b2
     * and a0/a1/a2 through, then divide numerator by denominator using
     * the standard "multiply by the conjugate" trick), followed by taking
     * the magnitude of the resulting complex number and converting to dB
     * with 20*log10(|H|).
     *
     * The Math.max(mag, 1e-8) guards against log10(0) = -Infinity for
     * frequencies where the filter has a true zero (e.g. right at a
     * notch's center frequency) -- clamps the displayed dB value instead
     * of producing -Infinity, which the graph then clips to dbMin anyway
     * (see drawResponse()).
     */
    function magnitudeDb(c, f, fs) {
        var w = 2 * Math.PI * f / fs;
        var reZ1 = Math.cos(-w), imZ1 = Math.sin(-w);       // z^-1 = e^(-jw)
        var reZ2 = Math.cos(-2 * w), imZ2 = Math.sin(-2 * w); // z^-2 = e^(-2jw)

        var numRe = c.b0 + c.b1 * reZ1 + c.b2 * reZ2;
        var numIm = c.b1 * imZ1 + c.b2 * imZ2;
        var denRe = c.a0 + c.a1 * reZ1 + c.a2 * reZ2;
        var denIm = c.a1 * imZ1 + c.a2 * imZ2;

        // Complex division num/den, via num * conjugate(den) / |den|^2.
        var denMagSq = denRe * denRe + denIm * denIm;
        var hRe = (numRe * denRe + numIm * denIm) / denMagSq;
        var hIm = (numIm * denRe - numRe * denIm) / denMagSq;

        var mag = Math.sqrt(hRe * hRe + hIm * hIm);
        return 20 * Math.log10(Math.max(mag, 1e-8));
    }

    /**
     * Generates `seconds` worth of pink noise into a mono AudioBuffer,
     * using Paul Kellet's well-known "economy" pink noise approximation
     * (a bank of leaky integrators applied to white noise). Pink noise
     * (equal energy per octave) is used here rather than white noise
     * because it sounds much less harsh to listen to for an extended
     * time, and its smoothly-sloped spectrum makes it easy to see and
     * hear a filter's effect across the whole frequency range.
     *
     * The `* 0.11` scale factor at the end is the commonly-cited
     * normalization constant for this particular algorithm that keeps the
     * output comfortably within [-1, 1] without needing a limiter.
     *
     * TO CHANGE THE NOISE COLOR: replacing this function's body with, e.g.,
     * `data[i] = Math.random() * 2 - 1;` would give you white noise
     * instead (louder-feeling and harsher, since it has equal energy per
     * Hz rather than per octave).
     */
    function createPinkNoiseBuffer(ctx, seconds) {
        var length = Math.floor(seconds * ctx.sampleRate);
        var buffer = ctx.createBuffer(1, length, ctx.sampleRate); // 1 = mono
        var data = buffer.getChannelData(0);
        var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // filter states, not related to the biquad b0/b1/b2 above
        for (var i = 0; i < length; i++) {
            var white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            var pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
            b6 = white * 0.115926;
            data[i] = pink * 0.11; // normalize to roughly [-1, 1]
        }
        return buffer;
    }

    // ---------------------------------------------------------------------
    // Frequency slider <-> Hz conversion helpers.
    //
    // The <input type="range"> for frequency always uses a plain linear
    // 0-1000 integer scale (see buildControlsHtml()); these two functions
    // convert between that raw slider position and an actual Hz value on a
    // LOGARITHMIC scale, so that dragging the slider feels evenly spaced
    // across the audible range (e.g. 20-200Hz gets just as much slider
    // travel as 2000-20000Hz, even though the latter spans far more Hz).
    // ---------------------------------------------------------------------

    // slider position (0-1000) -> frequency in Hz
    function freqFromSlider(pos /* 0..1000 */) {
        var t = pos / 1000; // normalize to 0..1
        var logMin = Math.log10(FREQ_MIN);
        var logMax = Math.log10(FREQ_MAX);
        return Math.pow(10, logMin + t * (logMax - logMin));
    }

    // frequency in Hz -> slider position (0-1000). Only used once, to set
    // the slider's initial position to match the default 1000Hz starting
    // frequency (see the "freqSlider.value = sliderFromFreq(1000)" line
    // below).
    function sliderFromFreq(freq) {
        var logMin = Math.log10(FREQ_MIN);
        var logMax = Math.log10(FREQ_MAX);
        var t = (Math.log10(freq) - logMin) / (logMax - logMin);
        return Math.round(t * 1000);
    }

    // Pretty-prints a Hz value for the on-screen label next to the
    // frequency slider, e.g. 440 -> "440 Hz", 1000 -> "1.00 kHz",
    // 12000 -> "12.0 kHz".
    function formatFreq(freq) {
        if (freq >= 1000) return (freq / 1000).toFixed(freq >= 10000 ? 1 : 2) + ' kHz';
        return Math.round(freq) + ' Hz';
    }

    /**
     * Builds the demo's inner HTML as one big string. Called once, when
     * the demo mount point is first hydrated (see initDemo() below).
     *
     * TO CHANGE THE DEMO'S LAYOUT/MARKUP: edit this function, then update
     * assets/styles/rbj_demo.css to match any class/id changes -- the two
     * files are tightly coupled (this defines the structure, that file
     * defines the look).
     *
     * All of the ids referenced here (rbj-type, rbj-freq, rbj-q, etc.) are
     * looked up again immediately after this HTML is inserted -- see the
     * "var typeSelect = mount.querySelector('#rbj-type')" block near the
     * top of initDemo().
     */
    function buildControlsHtml() {
        var options = FILTER_TYPES.map(function (t) {
            return '<option value="' + t.id + '">' + t.label + '</option>';
        }).join('');

        return '' +
            '<div class="rbj-demo__controls">' +
            '  <div class="rbj-control-group">' +
            '    <label for="rbj-type">Filter type</label>' +
            '    <select id="rbj-type">' + options + '</select>' +
            '  </div>' +
            '  <div class="rbj-control-group">' +
            '    <label for="rbj-freq">Frequency (f<sub>0</sub>): <span id="rbj-freq-value"></span></label>' +
            '    <input type="range" id="rbj-freq" min="0" max="1000" step="1">' +
            '  </div>' +
            '  <div class="rbj-control-group">' +
            '    <label for="rbj-q">Q: <span id="rbj-q-value"></span></label>' +
            // The Q slider uses whole-number steps internally (Q_MIN*100 to Q_MAX*100)
            // so it can represent Q values down to a 0.01 resolution with a plain
            // integer <input type="range"> -- see readParams()'s "/ 100" below.
            '    <input type="range" id="rbj-q" min="' + (Q_MIN * 100) + '" max="' + (Q_MAX * 100) + '" step="1">' +
            '  </div>' +
            '  <div class="rbj-control-group" id="rbj-gain-group">' +
            '    <label for="rbj-gain">Gain: <span id="rbj-gain-value"></span></label>' +
            // Same trick as Q above, but *10 for 0.1dB resolution -- see readParams()'s "/ 10".
            '    <input type="range" id="rbj-gain" min="' + (GAIN_MIN * 10) + '" max="' + (GAIN_MAX * 10) + '" step="1">' +
            '  </div>' +
            '  <div class="rbj-control-group rbj-transport">' +
            '    <button type="button" id="rbj-play" class="rbj-play-btn">▶ Play pink noise</button>' +
            '    <span class="rbj-volume-label">Volume</span>' +
            '    <input type="range" id="rbj-volume" min="0" max="100" step="1">' +
            '  </div>' +
            '</div>' +
            '<div class="rbj-demo__graph">' +
            '  <canvas id="rbj-canvas"></canvas>' +
            '</div>' +
            '<details class="rbj-coeffs">' +
            '  <summary>Computed biquad coefficients</summary>' +
            '  <pre id="rbj-coeffs-output"></pre>' +
            '</details>';
    }

    /**
     * Hydrates one demo mount point: builds the controls, wires up all the
     * event listeners, sets up the audio graph, and does the very first
     * updateFilter() call so the graph/labels/coefficients aren't blank on
     * first load. Called once per page load, from the "article:rendered"
     * listener at the very bottom of this file.
     *
     * `mount` is the <div id="rbj-demo-mount"> element created by
     * markdown_article.js's insertDemoMounts().
     */
    function initDemo(mount) {
        var AudioContextClass = window.AudioContext || window.webkitAudioContext; // webkitAudioContext = old Safari

        mount.className = 'rbj-demo'; // swap the "demo-mount" placeholder class for the real widget's styling
        mount.innerHTML = buildControlsHtml();

        // ---- grab references to everything buildControlsHtml() just created ----
        var typeSelect = mount.querySelector('#rbj-type');
        var freqSlider = mount.querySelector('#rbj-freq');
        var qSlider = mount.querySelector('#rbj-q');
        var gainSlider = mount.querySelector('#rbj-gain');
        var gainGroup = mount.querySelector('#rbj-gain-group');
        var freqValue = mount.querySelector('#rbj-freq-value');
        var qValue = mount.querySelector('#rbj-q-value');
        var gainValue = mount.querySelector('#rbj-gain-value');
        var playBtn = mount.querySelector('#rbj-play');
        var volumeSlider = mount.querySelector('#rbj-volume');
        var canvas = mount.querySelector('#rbj-canvas');
        var coeffsOutput = mount.querySelector('#rbj-coeffs-output');
        var canvasCtx = canvas.getContext('2d');

        // ---- default slider positions on page load ----
        freqSlider.value = sliderFromFreq(1000); // 1kHz
        qSlider.value = Math.round(0.707 * 100); // ~0.707 = Butterworth (maximally flat) response
        gainSlider.value = 0;                    // 0dB
        volumeSlider.value = 35;                 // out of 100 -- see volumeToGain()

        // If this browser has no Web Audio API at all, disable the play
        // button but leave everything else (graph, coefficients readout,
        // sliders) fully working -- see the "backend === 'none'" checks
        // throughout the rest of this function.
        if (!AudioContextClass) {
            playBtn.disabled = true;
            playBtn.textContent = 'Playback unavailable';
        }

        var audioCtx = AudioContextClass ? new AudioContextClass() : null;
        var pinkBuffer = audioCtx ? createPinkNoiseBuffer(audioCtx, 3) : null; // 3 seconds, looped during playback
        var masterGain = audioCtx ? audioCtx.createGain() : null; // overall volume control, tied to the Volume slider

        // Converts the 0-100 Volume slider into an actual linear gain
        // value. The *0.6 cap keeps the loudest setting comfortably below
        // full-scale (1.0) so pink noise -- which can have surprising
        // peaks -- doesn't clip. TO ALLOW LOUDER PLAYBACK: raise the 0.6.
        function volumeToGain(v) {
            return (v / 100) * 0.6;
        }

        if (masterGain) {
            masterGain.gain.value = volumeToGain(volumeSlider.value);
            masterGain.connect(audioCtx.destination); // masterGain stays connected to speakers permanently
        }

        // =================================================================
        // Playback backend selection.
        //
        // 'worklet' - preferred: uses the click-free AudioWorklet approach
        //             described at the top of this file and in
        //             rbj-processor.js. Used whenever the browser supports
        //             AudioWorklet AND the module actually loads
        //             successfully (loading is asynchronous -- see
        //             workletReady below).
        // 'legacy'  - fallback for browsers with Web Audio but no
        //             AudioWorklet support (or where loading the worklet
        //             module failed for some reason): recreates a native
        //             IIRFilterNode on every parameter change, with a
        //             quick gain "duck" to soften the resulting click.
        // 'none'    - no usable playback backend at all; the graph and
        //             coefficients readout still work, but the Play
        //             button does nothing (and is disabled above, if
        //             there's no AudioContext at all).
        // =================================================================
        var backend = 'none';
        var workletReady = null; // becomes a Promise once worklet module loading starts; stays null otherwise
        var filterNode = null;   // the persistent AudioWorkletNode (worklet backend), OR the current IIRFilterNode (legacy backend)
        var sourceNode = null;   // the currently-playing AudioBufferSourceNode (pink noise), null when paused
        var isPlaying = false;

        if (audioCtx && audioCtx.audioWorklet) {
            backend = 'worklet';
            // addModule() is async -- it fetches and compiles rbj-processor.js
            // on the audio thread. play() (below) waits on this promise
            // before actually starting playback, so hitting Play very
            // quickly after page load can't race ahead of the module load.
            workletReady = audioCtx.audioWorklet.addModule(WORKLET_URL).catch(function (err) {
                // If the module fails to load (404, syntax error, etc.), drop
                // down to the legacy backend instead of leaving playback
                // completely broken. Note this .catch() means workletReady
                // itself always resolves successfully (never rejects) --
                // play() below checks the `backend` variable (which this
                // sets) to detect that a fallback happened.
                console.error('Falling back to legacy filter swapping; AudioWorklet failed to load:', err);
                backend = window.IIRFilterNode ? 'legacy' : 'none';
            });
        } else if (audioCtx && window.IIRFilterNode) {
            backend = 'legacy';
        }
        // (else: backend stays 'none' -- no AudioContext, or an AudioContext
        // with neither AudioWorklet nor IIRFilterNode support.)

        // Creates the persistent AudioWorkletNode the very first time it's
        // needed (i.e. the first time Play is pressed with the worklet
        // backend active) and connects it straight to masterGain. After
        // this, the node is NEVER disconnected or recreated for the rest
        // of the page's lifetime -- only its coefficients change, via
        // postMessage (see updateFilter() below) -- which is the whole
        // reason parameter changes don't click.
        function ensureWorkletNode() {
            if (filterNode) return; // already created; no-op
            filterNode = new AudioWorkletNode(audioCtx, 'rbj-biquad-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 1,           // pink noise buffer is mono; keep everything mono until the final
                channelCountMode: 'explicit', // connection to destination, which upmixes mono -> stereo automatically
                outputChannelCount: [1]
            });
            filterNode.connect(masterGain);
        }

        // Looks up the full { id, label, hasGain } object for whatever
        // filter type is currently selected in the dropdown.
        function currentType() {
            var def = FILTER_TYPES.filter(function (t) { return t.id === typeSelect.value; })[0];
            return def || FILTER_TYPES[0]; // fall back to the first type if something's gone wrong
        }

        // Reads the three parameter sliders' raw values and converts them
        // into real-world units (Hz, Q, dB) -- see the slider-scale
        // comments in buildControlsHtml() above for why the /100 and /10
        // divisions are there.
        function readParams() {
            return {
                freq: freqFromSlider(Number(freqSlider.value)),
                q: Number(qSlider.value) / 100,
                gain: Number(gainSlider.value) / 10
            };
        }

        // Updates the small text labels next to each slider (e.g.
        // "1.00 kHz", "0.71", "6.0 dB") to match the current parameter values.
        function updateLabels(params) {
            freqValue.textContent = formatFreq(params.freq);
            qValue.textContent = params.q.toFixed(2);
            gainValue.textContent = params.gain.toFixed(1) + ' dB';
        }

        // Fills in the "Computed biquad coefficients" <details> section
        // with the current b0/b1/b2/a0/a1/a2 values, so a curious reader
        // can directly compare what's on screen to the formulas in the
        // article.
        function updateCoeffsReadout(c) {
            coeffsOutput.textContent =
                'b0 = ' + c.b0.toFixed(5) + '\n' +
                'b1 = ' + c.b1.toFixed(5) + '\n' +
                'b2 = ' + c.b2.toFixed(5) + '\n' +
                'a0 = ' + c.a0.toFixed(5) + '\n' +
                'a1 = ' + c.a1.toFixed(5) + '\n' +
                'a2 = ' + c.a2.toFixed(5);
        }

        /**
         * Draws the frequency response graph on the <canvas>, from scratch,
         * every time it's called. Nothing here is incremental/animated --
         * it fully redraws gridlines, axis labels, and the response curve
         * each call. Called every time the filter's parameters change (via
         * updateFilter()) and on window resize.
         *
         * `coeffs` is the raw { b0, b1, b2, a0, a1, a2 } from
         * computeCoefficients(); `fs` is the sample rate to evaluate the
         * response at (matters because the formulas involve f0/fs).
         */
        function drawResponse(coeffs, fs) {
            // ---- figure out how many actual device pixels to render at.
            // canvas.clientWidth/clientHeight are the CSS-pixel display
            // size (controlled by rbj_demo.css); multiplying by
            // devicePixelRatio and setting canvas.width/height to that
            // gives a crisp (non-blurry) result on high-DPI/retina
            // screens, while canvasCtx.setTransform scales all subsequent
            // drawing commands back down so we can keep writing coordinates
            // in ordinary CSS pixels below. ----
            var cssWidth = canvas.clientWidth || 600;
            var cssHeight = canvas.clientHeight || 280;
            var dpr = window.devicePixelRatio || 1;
            canvas.width = Math.round(cssWidth * dpr);
            canvas.height = Math.round(cssHeight * dpr);
            canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            canvasCtx.clearRect(0, 0, cssWidth, cssHeight);

            var N = 350; // number of points sampled along the curve -- higher = smoother but slower
            var dbMin = -30, dbMax = 30; // vertical axis range in dB (change to zoom the graph in/out)
            var padLeft = 34, padRight = 8, padTop = 10, padBottom = 22; // room for axis labels
            var plotW = cssWidth - padLeft - padRight;
            var plotH = cssHeight - padTop - padBottom;

            // Converts a frequency in Hz to an x pixel coordinate, using a
            // logarithmic scale (so 20-200Hz takes the same horizontal
            // space as 2000-20000Hz -- matches how the frequency slider
            // itself is scaled, see freqFromSlider() above).
            function xForFreq(f) {
                var t2 = (Math.log10(f) - Math.log10(FREQ_MIN)) / (Math.log10(FREQ_MAX) - Math.log10(FREQ_MIN));
                return padLeft + t2 * plotW;
            }
            // Converts a dB value to a y pixel coordinate (linear scale;
            // dbMax is at the top of the plot, dbMin at the bottom).
            function yForDb(db) {
                var t2 = (db - dbMin) / (dbMax - dbMin);
                return padTop + (1 - t2) * plotH;
            }

            // ---- vertical gridlines at standard reference frequencies,
            // with labels only at 100Hz/1kHz/10kHz to avoid clutter ----
            var freqLines = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
            canvasCtx.font = '10px Roboto, sans-serif';
            canvasCtx.fillStyle = 'rgba(196, 203, 216, 0.65)';
            canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            canvasCtx.lineWidth = 1;
            freqLines.forEach(function (f) {
                var x = xForFreq(f);
                canvasCtx.beginPath();
                canvasCtx.moveTo(x, padTop);
                canvasCtx.lineTo(x, padTop + plotH);
                canvasCtx.stroke();
                if (f === 100 || f === 1000 || f === 10000) {
                    var label = f >= 1000 ? (f / 1000) + 'k' : String(f);
                    canvasCtx.fillText(label, x - 8, cssHeight - 6);
                }
            });

            // ---- horizontal gridlines every 10dB; the 0dB line is drawn
            // brighter/more opaque so it stands out as the reference level ----
            for (var db = dbMin; db <= dbMax; db += 10) {
                var y = yForDb(db);
                canvasCtx.strokeStyle = db === 0 ? 'rgba(153, 184, 255, 0.45)' : 'rgba(255, 255, 255, 0.08)';
                canvasCtx.beginPath();
                canvasCtx.moveTo(padLeft, y);
                canvasCtx.lineTo(padLeft + plotW, y);
                canvasCtx.stroke();
                canvasCtx.fillStyle = 'rgba(196, 207, 216, 0.65)';
                canvasCtx.fillText(db + 'dB', 2, y + 3);
            }

            // ---- the actual response curve: sample magnitudeDb() at N
            // log-spaced frequencies across the visible range and connect
            // the dots. Values are clamped to [dbMin, dbMax] so a deep
            // notch or resonant peak doesn't draw off the top/bottom of
            // the canvas -- it just flattens against the edge instead. ----
            canvasCtx.beginPath();
            canvasCtx.lineWidth = 2.5;
            canvasCtx.strokeStyle = '#5fa4ff';
            canvasCtx.shadowColor = 'rgba(95, 130, 255, 0.5)'; // soft glow behind the line
            canvasCtx.shadowBlur = 6;
            for (var j = 0; j < N; j++) {
                var t = j / (N - 1);
                var f = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t); // log-spaced frequency sample
                var db2 = magnitudeDb(coeffs, f, fs);
                if (db2 < dbMin) db2 = dbMin;
                if (db2 > dbMax) db2 = dbMax;
                var x2 = xForFreq(f);
                var y2 = yForDb(db2);
                if (j === 0) canvasCtx.moveTo(x2, y2);
                else canvasCtx.lineTo(x2, y2);
            }
            canvasCtx.stroke();
            canvasCtx.shadowBlur = 0; // reset so the glow doesn't leak into anything drawn after this function returns
        }

        // Remembers the most recently computed coefficients, so window
        // resize (which needs to redraw the graph but doesn't change any
        // filter parameters) and the very first Play press (which wants to
        // send the worklet its starting coefficients immediately) don't
        // need to recompute them from scratch.
        var lastCoeffs = null;

        /**
         * The central "something changed" function. Called once up front
         * (at the bottom of initDemo()) and again every time a slider/
         * dropdown fires an "input" event (via scheduleUpdate(), which
         * throttles rapid-fire slider drags to once per animation frame).
         *
         * Does four things every time: (1) recompute coefficients from the
         * current slider values, (2) update the on-screen labels and
         * coefficients readout, (3) redraw the response graph, and (4) if
         * audio is set up, push the new coefficients to whichever playback
         * backend is active.
         */
        function updateFilter() {
            var params = readParams();
            var type = currentType();
            // Dim + disable the Gain slider for filter types that don't use it
            // (see rbj_demo.css's ".rbj-control-group.rbj-gain-hidden" rule).
            gainGroup.classList.toggle('rbj-gain-hidden', !type.hasGain);
            updateLabels(params);

            // Fall back to a plausible sample rate (44100Hz) when there's no
            // AudioContext at all, purely so the graph still has something
            // sensible to compute against.
            var fs = audioCtx ? audioCtx.sampleRate : 44100;
            var coeffs = computeCoefficients(type.id, params.freq, params.q, type.hasGain ? params.gain : 0, fs);
            lastCoeffs = coeffs;
            updateCoeffsReadout(coeffs);
            drawResponse(coeffs, fs);

            if (backend === 'worklet' && filterNode) {
                // Pre-divide by a0 here (on the main thread, once) rather than
                // making the worklet do this division every single sample --
                // see rbj-processor.js, which just uses these values directly.
                filterNode.port.postMessage({
                    b0: coeffs.b0 / coeffs.a0,
                    b1: coeffs.b1 / coeffs.a0,
                    b2: coeffs.b2 / coeffs.a0,
                    a1: coeffs.a1 / coeffs.a0,
                    a2: coeffs.a2 / coeffs.a0,
                    rampMs: 12 // how long the worklet takes to glide to these new coefficients
                });
            } else if (backend === 'legacy') {
                swapLegacyFilterNode(coeffs);
            }
            // (backend === 'none': nothing more to do -- the graph/labels/
            // readout above are already updated, which is all that's possible.)
        }

        /**
         * LEGACY FALLBACK ONLY (browsers without AudioWorklet support).
         * Recreates a brand-new native IIRFilterNode with the given
         * coefficients -- since IIRFilterNode's coefficients can't be
         * changed after creation, this is the only way to apply new
         * parameter values with this backend.
         *
         * Because swapping nodes normally causes an audible click (the new
         * node starts with zero internal history), this briefly "ducks"
         * the master volume to silence and back (an 8ms fade down, swap,
         * then a 22ms fade back up) around the swap to soften it. This is
         * strictly worse than the worklet approach (there's still a
         * momentary dip in volume, and the filter's internal state really
         * does reset) but is a reasonable compromise for the rare browser
         * that lacks AudioWorklet.
         */
        function swapLegacyFilterNode(coeffs) {
            var newFilter = new IIRFilterNode(audioCtx, {
                feedforward: [coeffs.b0, coeffs.b1, coeffs.b2],
                feedback: [coeffs.a0, coeffs.a1, coeffs.a2] // IIRFilterNode normalizes by a0 automatically
            });

            if (isPlaying && sourceNode) {
                var now = audioCtx.currentTime;
                masterGain.gain.cancelScheduledValues(now);
                masterGain.gain.setValueAtTime(masterGain.gain.value, now);
                masterGain.gain.linearRampToValueAtTime(0, now + 0.008); // fade out over 8ms

                sourceNode.disconnect();
                if (filterNode) filterNode.disconnect();

                sourceNode.connect(newFilter);
                newFilter.connect(masterGain);

                masterGain.gain.linearRampToValueAtTime(volumeToGain(volumeSlider.value), now + 0.03); // fade back in
            }

            filterNode = newFilter;
        }

        // Creates a fresh AudioBufferSourceNode looping the pink noise
        // buffer, connects it into whatever `filterNode` currently is, and
        // starts it playing. AudioBufferSourceNode can only be started
        // once ever (the Web Audio API throws if you call .start() twice
        // on the same node), which is why a new one has to be created here
        // every time Play is pressed rather than reusing one across
        // play/pause cycles.
        function startSource() {
            sourceNode = audioCtx.createBufferSource();
            sourceNode.buffer = pinkBuffer;
            sourceNode.loop = true;
            sourceNode.connect(filterNode);
            // For the worklet backend, filterNode is already permanently
            // connected to masterGain (see ensureWorkletNode()) -- only the
            // legacy backend needs to (re)connect it here, since
            // swapLegacyFilterNode() only auto-connects the new node when a
            // swap happens *while already playing*, not on this initial connect.
            if (backend === 'legacy') filterNode.connect(masterGain);
            sourceNode.start();
            isPlaying = true;
            playBtn.textContent = '⏸ Pause';
        }

        /**
         * Play button handler (called when isPlaying is false). Behavior
         * differs by backend:
         *   - 'worklet': waits for the (possibly still-loading) worklet
         *     module, creates the persistent filter node if this is the
         *     first time, sends it the current coefficients with a very
         *     short (1ms) ramp so it snaps to the right sound almost
         *     immediately rather than audibly sweeping up from silence/
         *     identity, then starts the pink noise source.
         *   - 'legacy': creates the IIRFilterNode if needed, then starts
         *     the source directly (no need to wait on anything async).
         *   - 'none': does nothing (guarded by the early return below).
         */
        function play() {
            if (isPlaying || backend === 'none') return;
            audioCtx.resume(); // required by browser autoplay policies -- must happen inside a user gesture, which this click handler is

            if (backend === 'worklet') {
                Promise.resolve(workletReady).then(function () {
                    if (backend !== 'worklet') {
                        // The worklet module failed to load sometime between
                        // page load and this Play click, and we've since
                        // fallen back to 'legacy' (or 'none'). Handle that
                        // fallback here rather than assuming worklet success.
                        if (backend === 'legacy' && !filterNode) swapLegacyFilterNode(lastCoeffs);
                        startSource();
                        return;
                    }
                    ensureWorkletNode();
                    if (lastCoeffs) {
                        filterNode.port.postMessage({
                            b0: lastCoeffs.b0 / lastCoeffs.a0,
                            b1: lastCoeffs.b1 / lastCoeffs.a0,
                            b2: lastCoeffs.b2 / lastCoeffs.a0,
                            a1: lastCoeffs.a1 / lastCoeffs.a0,
                            a2: lastCoeffs.a2 / lastCoeffs.a0,
                            rampMs: 1 // near-instant -- this is the very first sound, not a live tweak
                        });
                    }
                    startSource();
                });
            } else {
                if (!filterNode) swapLegacyFilterNode(lastCoeffs);
                startSource();
            }
        }

        // Pause button handler (called when isPlaying is true). Stops and
        // disconnects the pink noise source; for the legacy backend, also
        // disconnects the IIRFilterNode (the worklet backend deliberately
        // leaves its filterNode connected forever -- see ensureWorkletNode()
        // -- so there's nothing extra to disconnect there).
        function pause() {
            if (!isPlaying) return;
            try { sourceNode.stop(); } catch (e) { /* already stopped; ignore */ }
            sourceNode.disconnect();
            if (backend === 'legacy' && filterNode) filterNode.disconnect();
            sourceNode = null;
            isPlaying = false;
            playBtn.textContent = '▶ Play pink noise';
        }

        playBtn.addEventListener('click', function () {
            if (isPlaying) pause(); else play();
        });

        if (volumeSlider && masterGain) {
            // setTargetAtTime with a short time constant (0.01s) gives a
            // tiny smoothing to volume changes so dragging the slider
            // doesn't produce "zipper" noise (audible stepping).
            volumeSlider.addEventListener('input', function () {
                masterGain.gain.setTargetAtTime(volumeToGain(volumeSlider.value), audioCtx.currentTime, 0.01);
            });
        }

        // ---------------------------------------------------------------
        // Coalesce rapid slider drags into at most one updateFilter() call
        // per animation frame (~60 times/sec), rather than once per raw
        // "input" event (which can fire far more often than that while
        // dragging). Without this, dragging quickly could queue up a big
        // backlog of redundant graph redraws / worklet messages.
        // ---------------------------------------------------------------
        var updateScheduled = false;
        function scheduleUpdate() {
            if (updateScheduled) return;
            updateScheduled = true;
            requestAnimationFrame(function () {
                updateScheduled = false;
                updateFilter();
            });
        }

        [typeSelect, freqSlider, qSlider, gainSlider].forEach(function (el) {
            el.addEventListener('input', scheduleUpdate);
        });

        // The canvas is sized from its CSS pixel dimensions (see
        // drawResponse()), so it needs to be explicitly redrawn whenever
        // the window (and therefore the canvas's on-screen size) changes --
        // canvases don't do this automatically.
        window.addEventListener('resize', function () {
            if (lastCoeffs) drawResponse(lastCoeffs, audioCtx ? audioCtx.sampleRate : 44100);
        });

        // Do the very first render (graph, labels, coefficients readout)
        // immediately, using the default slider values set above, so the
        // widget isn't blank before the reader touches anything.
        updateFilter();
    }

    // Wait for markdown_article.js to finish rendering the article (and,
    // with it, creating the #rbj-demo-mount div in place of the "EXAMPLE
    // HERE" paragraph) before trying to hydrate the demo. If the mount
    // point doesn't exist for some reason (e.g. someone removed the
    // "EXAMPLE HERE" line from article.md entirely), this quietly does
    // nothing rather than erroring.
    document.addEventListener('article:rendered', function () {
        var mount = document.getElementById('rbj-demo-mount');
        if (mount) initDemo(mount);
    });
})();
