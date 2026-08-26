# A Practical Guide to Digital Audio Filters

## Introduction

I have found that audio filtering is a topic that many people have heard of, and they might think they have an idea of how it works, but seldom actually do. Those who are familiar with programming and have perhaps dabbled with audio programming before may reach for FFT to do this sort of frequency-dependent processing, but this is generally overkill for simple filters and introduces far more latency and processing overhead than is actually needed for this task.

The method that is commonly used for filtering audio in realtime is called **Infinite Impulse Response filtering**, or **IIR filtering** for short. This article aims to give a guide to what IIR filtering is, how to interpret the often poorly explained names and symbols used, and how to create the most commonly used IIR filters.

## Background

Digital audio theory is an incredibly lengthy and complex topic that, unfortunately, cannot be fully explained in an article specifically about digital filters. However, I will introduce some essential concepts without going into unnecessary detail. Feel free to do some more research after you finish this. Who knows, maybe I'll write an article going deeper into these topics in the future!

First, we must establish that we are working with *digital* audio here. We are not working with continuous functions as we would in traditional mathematics. We are working with a *representation* of a continuous signal that has been *sampled* at a specific rate, known as the **sampling rate** (written as $f_s$). A single *sample*, therefore, is one of these sampled points.

We must also establish, for reasons that will become evident soon, that we are processing a *single channel* of audio. Commonly, you will deal with multiple channels. In this case, you would need *one filter per channel*. As a bit of a side note, a collection of simultaneous samples across several channels is referred to as a *frame*. As filters are a single-channel operation, however, I will refer to everything as samples from now on.

Shockingly, the mathematicians who came up with the notation for digital functions did it in a way helpful to programmers! The discrete (digital) audio signal we are working with is notated like an array, and a specific sample in the signal is referred to as if you were indexing into the array. For example, the phrase "the $n$th sample in signal $x$" would be written simply as:

$$
x[n]
$$

Filters are a specific kind of process applied to audio called an **effect**. Effects are distinct from **generators** (such as oscillators) in that effects have an input signal (commonly $x[]$) and an output signal (commonly $y[]$). Generators only have an output signal. Other examples of effects are reverb, distortion, compression, etc.

*When writing effects practically, you commonly write the output sample back into the input buffer you were given. Because of this, additional state is often required to remember previous inputs after they are overwritten.*

Effects, therefore, are commonly written as a *difference equation*, which is written as $y[n] = ...$. The left side is y[n], the output sample currently being calculated. The right side describes how that output is calculated from the current and previous input and output samples.

Finally, with all that out of the way, we can get into specifics!

## IIR Filtering

IIR filters are defined roughly as "a linear time-invariant system that is distinguished by having an impulse response $h(t)$ that does not become exactly zero past a certain point but continues indefinitely." I find this explanation... less than enlightening.

The key insight that allows IIRs to function is that we can use *previous inputs* **and previous outputs** to affect our input signal. Previous inputs contributing is known as *feed-forward*, and previous outputs contributing are known as *feedback*. These previous samples are referred to by offsetting the index of the signal. For example, the previous input sample is referred to as $x[n-1]$, and the previous output is $y[n-1]$.

Let's start with the difference equation for an IIR filter and work our way back from there:

$$
y[n]=\frac{1}{a_0}\left(\sum^P_{i=0}b_ix[n-i] - \sum^Q_{i=1}a_iy[n-i]\right)
$$

I know it looks horrendous. I actually find it more helpful to look at this in an expanded view rather than as $\sum$-style summations.

$$
y[n]= \frac{1}{a_0}[( b_0x[n] + b_1x[n-1] + ... + b_Px[n-P]) 
$$
$$
- (a_1y[n-1]+a_2y[n-2]+...+a_Qy[n-Q])]
$$

The section with $b$s and $x$s is our *feed-forward* portion, and is a sum of *input* samples, each multiplied by its own coefficient $b$. Notably, this *includes* the current sample, which gets its own $b_0$. The section with $a$s and $y$s is our *feedback* portion, and is a sum of previous *output* samples, each multiplied by its own coefficient $a$. Notably, this section does NOT include the current output sample. The coefficient of $y[n]$ is $a_0$, but I divided the equation by $a_0$ in order to isolate $y[n]$.

$P$ in this case refers to what is called the *feed-forward order*, and $Q$ is called the *feedback order*. As mentioned previously, this is why we'll need to retain a little bit of extra state! You need to store $x[n-1], x[n-2], ..., y[n-1], y[n-2], ...,$ etc.

Why might we need to store the previous outputs? This is a bit more technical, and I will probably write more on audio buffer behaviour in the future... The buffer contains audio data. The filter's state is the information that must survive from one processing call to the next. Previous outputs can *happen* to exist in the buffer, but they should **not** be relied upon as filter state.

For those interested, the reason that these are called "Infinite Impulse Response" filters is because when you send an impulse (a single sample 1, followed by an infinite number of 0s), the resulting output will never fully reach 0. This is a result of the feedback component. Of course, in reality, computers do not have infinite precision, and so eventually (and often quite quickly) values will taper below what is effectively representable.

## The Biquad Filter

There are plenty of IIR filter architectures out there (feel free to look them up in your free time), but there is one that dominates them all: the **biquad filter**.

The biquad filter is very simple. It's an IIR filter with three feed-forward coefficients and three feedback coefficients, with $a_0$ serving as a normalization coefficient. Its difference equation is:

$$
y[n] = \frac{1}{a_0}\left(b_0x[n] + b_1x[n-1] + b_2x[n-2] - a_1y[n-1] - a_2y[n-2]\right)
$$

That's it! Note one important detail: **the $a$ coefficients are subtracted instead of added**. This is simply a convention used by the coefficient formulas we'll be using, and makes calculating those coefficients slightly easier.

The biquad is capable of creating a truly wild number of different filter types simply by giving it different coefficients. (If working in an object-oriented programming language, I highly recommend creating a class that contains the difference equation as a function and can keep track of the 4 necessary pieces of state: $x[n-1], x[n-2], y[n-1], y[n-2]$)

Here is [my current biquad implementation in C++](https://github.com/omnicorum-dev/PluginDevCourse/blob/main/Templates_Materials/Classes/Biquad.h) if you're curious.

Among these, the most common coefficient functions were written by Robert Bristow-Johnson, and are known as the **Audio EQ Cookbook**. Here is an interactive demo that shows all the different filters that the RBJ filters allow for and the different parameters they expose. Additionally, this should allow you to learn the names of these filters, hear how they sound, and how the parameters change the behaviour of the filter. We will be referring to these names and parameters a lot in the coming section. You might need to enable your ringer if viewing this on mobile.

<RBJ Example>

## The RBJ Filters

The equations for the coefficients of the biquad are written in terms of these values:

- $f_s$: the sampling rate
- $f_0$: the filter's characteristic frequency. Depending on the filter type, this may be its cutoff frequency, center frequency, or another characteristic frequency.
- $dBgain$: used only for peaking and shelving filters and represents the amount of gain or attenuation in decibels.
- $Q$: a parameter that generally describes how "peaky" or steep the filter is. Its exact effect depends on the filter type. Check out the demo above to see for yourself how it works.

These values are generally set by the user. Additionally, to save processing power, coefficients are recalculated *only when these parameters changed*.

Generally, before any coefficient calculation, a few intermediate variables are calculated to save repeated calculation.

$$ A = \sqrt{10^{dBgain/20}} = 10^{dBgain/40} $$

$$ \omega_0=2\pi\frac{f_0}{f_s}$$

$$ c_\omega = cos(\omega_0) $$

$$ s_\omega = sin(\omega_0) $$

$$ \alpha = \frac{s_\omega}{2Q} $$

Then, depending on the filter you want, set the coefficients accordingly:

### Low-Pass Filter (LPF)

$$ b_0 = \frac{1-c_\omega}{2}$$
$$ b_1 = 1-c_\omega$$
$$ b_2 = \frac{1-c_\omega}{2}$$
$$ a_0 = 1+\alpha$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1-\alpha$$

### High-Pass Filter (HPF)

$$ b_0 = \frac{1+c_\omega}{2}$$
$$ b_1 = -(1+c_\omega)$$
$$ b_2 = \frac{1+c_\omega}{2}$$
$$ a_0 = 1+\alpha$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1-\alpha$$

### Band-Pass Filter (BPF) w/ constant skirt gain

$$ b_0 = \frac{s_\omega}{2} = Q\alpha$$
$$ b_1 = 0$$
$$ b_2 = -\frac{s_\omega}{2} = -Q\alpha$$
$$ a_0 = 1+\alpha$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1-\alpha$$

### Band-Pass Filter (BPF) w/ constant peak gain

$$ b_0 = \alpha$$
$$ b_1 = 0$$
$$ b_2 = -\alpha$$
$$ a_0 = 1+\alpha$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1-\alpha$$

### Notch

$$ b_0 = 1$$
$$ b_1 = -2c_\omega$$
$$ b_2 = 1$$
$$ a_0 = 1+\alpha$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1-\alpha$$

### All-Pass Filter (APF)

$$ b_0 = 1-\alpha$$
$$ b_1 = -2c_\omega$$
$$ b_2 = 1+\alpha$$
$$ a_0 = 1+\alpha$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1-\alpha$$

### Peaking/Bell

$$ b_0 = 1 + \alpha A$$
$$ b_1 = -2c_\omega$$
$$ b_2 = 1 - \alpha A$$
$$ a_0 = 1 + \frac{\alpha}{A}$$
$$ a_1 = -2c_\omega$$
$$ a_2 = 1 - \frac{\alpha}{A}$$

### Low Shelf
Be careful with the +, - and As in these last two!

$$ b_0 = A\left((A+1) - ((A-1)c_\omega) + 2\alpha\sqrt{A}\right)$$
$$ b_1 = 2A\left((A-1) - ((A+1)c_\omega)\right)$$
$$ b_2 = A\left((A+1) - ((A-1)c_\omega) - 2\alpha\sqrt{A}\right)$$
$$ a_0 = (A + 1) + ((A-1)c_\omega) + 2\alpha\sqrt{A}$$
$$ a_1 = -2\left((A-1) + ((A+1)c_\omega)\right)$$
$$ a_2 = (A + 1) + ((A-1)c_\omega) - 2\alpha\sqrt{A}$$

### High Shelf

$$ b_0 = A\left((A+1) + ((A-1)c_\omega) + 2\alpha\sqrt{A}\right)$$
$$ b_1 = -2A\left((A-1) + ((A+1)c_\omega)\right)$$
$$ b_2 = A\left((A+1) + ((A-1)c_\omega) - 2\alpha\sqrt{A}\right)$$
$$ a_0 = (A + 1) - ((A-1)c_\omega) + 2\alpha\sqrt{A}$$
$$ a_1 = 2\left((A-1) - ((A+1)c_\omega)\right)$$
$$ a_2 = (A + 1) - ((A-1)c_\omega) - 2\alpha\sqrt{A}$$

## Conclusion

Now you should be able to write your own set of basic digital filters! There is a massive rabbit hole of even just different IIR filters. The RBJ filters are examples of *second-order* filters, and when it comes to non-IIR filters, it gets even crazier.

Good luck, and try to find some other types of filters and implement them yourself! The world is your oyster.

## References
- [The RBJ Audio EQ Cookbook](https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html)
- [Christopher Bennett - Digital Audio Theory](https://www.routledge.com/Digital-Audio-Theory-A-Practical-Guide/Bennett/p/book/9780367276539)
- [My Biquad, RBJ, and LR4 Implementation](https://github.com/omnicorum-dev/PluginDevCourse/blob/main/Templates_Materials/Classes/Biquad.h)