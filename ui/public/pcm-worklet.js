// The recorder's ear (ui/src/speech/record.ts): gathers what its input hears as one channel and hands it to the page
// about twenty times a second. Told to end, it hands over what it still holds and says so with an empty message.
// Nothing is kept here.
class Pcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.held = new Float32Array(2048);
    this.n = 0;
    this.port.onmessage = () => {
      this.port.postMessage(this.held.slice(0, this.n));
      this.n = 0;
      this.port.postMessage(null);
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let x = 0;
      for (const c of channels) x += c[i];
      this.held[this.n++] = x / channels.length;
      if (this.n === this.held.length) {
        this.port.postMessage(this.held.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm', Pcm);
