// Capture only. No audio is played by this processor. Downsample device PCM to
// 16 kHz in 20 ms packets; the controller owns VAD and all microphone lifetime.
class LessonCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.weight = 0; this.sum = 0;
    this.packet = new Float32Array(320); this.index = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      let left = 1;
      while (left > 1e-8) {
        const take = Math.min(left, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; left -= take;
        if (this.weight >= this.ratio - 1e-8) {
          this.packet[this.index++] = this.sum / this.ratio;
          this.weight = 0; this.sum = 0;
          if (this.index === this.packet.length) {
            this.port.postMessage(this.packet, [this.packet.buffer]);
            this.packet = new Float32Array(320); this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('lesson-capture', LessonCaptureProcessor);
