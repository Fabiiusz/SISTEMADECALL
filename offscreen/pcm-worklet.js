// AudioWorklet: converte o áudio (float32, mono, 16 kHz) em PCM 16 bits
// e envia blocos de ~100 ms para a thread principal, junto com o nível (RMS).

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 1600; // 100 ms a 16 kHz
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;
      if (this.offset >= this.chunkSize) {
        const level = Math.sqrt(this.sumSquares / this.chunkSize);
        const out = this.buffer.buffer.slice(0);
        this.port.postMessage({ pcm: out, level }, [out]);
        this.offset = 0;
        this.sumSquares = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
