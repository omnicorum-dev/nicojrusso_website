/**
 * rbj-processor.js
 * =====================================================================
 * An AudioWorkletProcessor -- code that runs on the browser's dedicated,
 * high-priority audio rendering thread (NOT the main UI thread). This is
 * what actually applies the biquad filter to the pink noise you hear when
 * you hit Play in the demo.
 *
 * Loaded via `audioCtx.audioWorklet.addModule('/assets/apps/rbj-processor.js')`
 * in rbj_demo.js, then instantiated with
 * `new AudioWorkletNode(audioCtx, 'rbj-biquad-processor', {...})`. The
 * string 'rbj-biquad-processor' passed to registerProcessor() at the
 * bottom of this file is what ties those two together -- if you rename
 * one, rename the other to match.
 *
 * WHY A CUSTOM WORKLET INSTEAD OF THE BUILT-IN IIRFilterNode?
 * The Web Audio API already has an IIRFilterNode that can apply arbitrary
 * biquad coefficients, and an earlier version of this demo used it. The
 * problem: IIRFilterNode's coefficients are fixed at creation time and
 * can never be changed afterwards. Every time you moved a slider, the old
 * code had to throw away the old node and create a brand new one with the
 * updated coefficients -- and a brand new filter node always starts with
 * zero memory of the last couple of samples, so every parameter tweak
 * caused an audible "restart" click.
 *
 * This custom processor fixes that by keeping ONE long-lived instance
 * whose delay-line memory (x1, x2, y1, y2 below) just keeps running
 * continuously. Coefficients arrive via postMessage() and get smoothly
 * interpolated toward over ~10ms (see the ramp logic in process() below)
 * instead of snapping instantly -- so the sound bends toward the new
 * filter setting instead of jumping or restarting.
 *
 * THE MATH: this is the exact same biquad difference equation described
 * in the article and implemented in rbj_demo.js's computeCoefficients():
 *
 *   y[n] = (1/a0) * ( b0*x[n] + b1*x[n-1] + b2*x[n-2]
 *                     - a1*y[n-1] - a2*y[n-2] )
 *
 * The coefficients this processor receives over postMessage are already
 * pre-divided by a0 (see rbj_demo.js), so the code below doesn't need to
 * do that division itself every sample -- it just uses curB0/curB1/etc.
 * directly as if a0 were always 1.
 */
class RbjBiquadProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // ---- "current" coefficients actually used in the difference
        // equation each sample. Start as an identity filter (b0=1, all
        // others 0), i.e. y[n] = x[n] -- pass audio through unchanged --
        // until the main thread sends real coefficients. ----
        this.curB0 = 1; this.curB1 = 0; this.curB2 = 0;
        this.curA1 = 0; this.curA2 = 0;

        // ---- interpolation state: where we're ramping FROM (start) and
        // TO (tgt) whenever new coefficients arrive. curB0 etc. above are
        // linearly interpolated from start* to tgt* over rampTotal samples. ----
        this.startB0 = 1; this.startB1 = 0; this.startB2 = 0;
        this.startA1 = 0; this.startA2 = 0;
        this.tgtB0 = 1; this.tgtB1 = 0; this.tgtB2 = 0;
        this.tgtA1 = 0; this.tgtA2 = 0;

        this.rampTotal = 1; // total length of the current ramp, in samples
        this.rampLeft = 0;  // samples remaining in the current ramp (0 = not ramping, just use cur* as-is)

        // ---- delay-line state: the actual "memory" of the filter. These
        // are what an IIRFilterNode-swap approach would have thrown away
        // on every parameter change -- keeping them alive across
        // coefficient updates is the whole point of this file. ----
        this.x1 = 0; this.x2 = 0; // x[n-1], x[n-2]: previous two INPUT samples
        this.y1 = 0; this.y2 = 0; // y[n-1], y[n-2]: previous two OUTPUT samples

        // Called whenever the main thread does filterNode.port.postMessage({...})
        // (see rbj_demo.js's updateFilter() and play()). Rather than
        // snapping curB0 etc. straight to the new values, we capture
        // wherever the interpolation currently IS as the new start point,
        // and start a fresh ramp toward the new target -- this way, even
        // rapid slider drags (lots of messages in quick succession) chase
        // smoothly toward whatever the latest value is instead of
        // stair-stepping.
        this.port.onmessage = (event) => {
            const c = event.data; // { b0, b1, b2, a1, a2, rampMs } -- see rbj_demo.js

            this.startB0 = this.curB0; this.startB1 = this.curB1; this.startB2 = this.curB2;
            this.startA1 = this.curA1; this.startA2 = this.curA2;

            this.tgtB0 = c.b0; this.tgtB1 = c.b1; this.tgtB2 = c.b2;
            this.tgtA1 = c.a1; this.tgtA2 = c.a2;

            // rampMs controls how long the transition takes. rbj_demo.js
            // sends 12ms for normal slider tweaks (smooth but responsive)
            // and ~1ms the very first time playback starts (so the filter
            // snaps to the correct starting sound almost immediately
            // rather than audibly sweeping up from the identity filter).
            const rampMs = typeof c.rampMs === 'number' ? c.rampMs : 10;
            // `sampleRate` here is a global provided by the AudioWorkletGlobalScope
            // (NOT the same `audioCtx.sampleRate` used on the main thread, though
            // in practice they're the same number) -- it's how many samples per
            // second this processor is running at.
            this.rampTotal = Math.max(1, Math.round(sampleRate * rampMs / 1000));
            this.rampLeft = this.rampTotal;
        };
    }

    /**
     * Called automatically by the browser roughly every 128 samples (a
     * "render quantum") for as long as this node is part of an active
     * audio graph. Must return `true` to keep the processor alive --
     * returning false or omitting the return would let the browser garbage
     * collect it.
     *
     * `inputs`/`outputs` are arrays-of-arrays-of-Float32Array:
     * inputs[0] = first input's channels, inputs[0][0] = first input's
     * first (and, here, only -- see channelCount:1 in rbj_demo.js) channel,
     * a Float32Array of up to 128 samples.
     */
    process(inputs, outputs) {
        const input = inputs[0];
        // When nothing is connected to this node's input (e.g. paused, or
        // before playback has started), `input` can be an empty array
        // rather than containing a zeroed channel -- guard against that so
        // we don't throw trying to read input[0][i].
        const hasInput = !!(input && input.length > 0 && input[0] && input[0].length > 0);
        const inCh = hasInput ? input[0] : null;
        const outCh = outputs[0][0];
        if (!outCh) return true; // no output channel to write into for some reason; nothing to do this block

        for (let i = 0; i < outCh.length; i++) {
            // Advance the coefficient ramp by one sample, if one is in progress.
            if (this.rampLeft > 0) {
                const t = 1 - this.rampLeft / this.rampTotal; // 0 -> 1 over the ramp
                this.curB0 = this.startB0 + (this.tgtB0 - this.startB0) * t;
                this.curB1 = this.startB1 + (this.tgtB1 - this.startB1) * t;
                this.curB2 = this.startB2 + (this.tgtB2 - this.startB2) * t;
                this.curA1 = this.startA1 + (this.tgtA1 - this.startA1) * t;
                this.curA2 = this.startA2 + (this.tgtA2 - this.startA2) * t;
                this.rampLeft--;
            }

            // The actual biquad difference equation, one sample at a time.
            // Coefficients are already normalized (a0 = 1 implicitly), so
            // this is exactly:
            //   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
            const x0 = inCh ? inCh[i] : 0; // treat "no input connected" as silence
            const y0 = this.curB0 * x0 + this.curB1 * this.x1 + this.curB2 * this.x2
                - this.curA1 * this.y1 - this.curA2 * this.y2;

            // Shift the delay lines forward by one sample for next time.
            this.x2 = this.x1; this.x1 = x0;
            this.y2 = this.y1; this.y1 = y0;

            outCh[i] = y0;
        }

        return true; // keep this processor alive for the next render quantum
    }
}

// The string here ('rbj-biquad-processor') must match the second argument
// passed to `new AudioWorkletNode(audioCtx, 'rbj-biquad-processor', ...)`
// in rbj_demo.js.
registerProcessor('rbj-biquad-processor', RbjBiquadProcessor);
