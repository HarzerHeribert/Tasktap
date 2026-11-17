// The Bridge of design §12 over Tauri: the host passes this page's connection through as
// bytes; frames are cut and framed here (u32 length, u8 kind, payload), so the host never
// reads them. When the connection ends the page starts over: it holds no durable state.
import { Channel, invoke } from '@tauri-apps/api/core';
import type { Bridge } from './client.ts';

export function tauriBridge(): Bridge {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let held = new Uint8Array(0);
  let outgoing: Uint8Array[] = [];

  const bridge: Bridge = {
    send(frame) {
      const payload = typeof frame === 'string' ? encoder.encode(frame) : frame;
      const out = new Uint8Array(5 + payload.length);
      new DataView(out.buffer).setUint32(0, payload.length + 1, true);
      out[4] = typeof frame === 'string' ? 0 : 1;
      out.set(payload, 5);
      // Frames sent in one turn go to the host in one message.
      if (outgoing.push(out) > 1) return;
      queueMicrotask(() => {
        const all = new Uint8Array(outgoing.reduce((n, f) => n + f.length, 0));
        outgoing.reduce((at, f) => (all.set(f, at), at + f.length), 0);
        outgoing = [];
        void invoke('bridge_send', all);
      });
    },
    host(frame) {
      void invoke<string>('bridge_host', { frame }).then((reply) => bridge.onframe(reply));
    },
    onframe: () => {},
  };

  const frames = new Channel<ArrayBuffer>();
  frames.onmessage = (chunk) => {
    if (!chunk.byteLength) {
      setTimeout(() => location.reload(), 1000);
      return;
    }
    const bytes = new Uint8Array(chunk);
    const all = held.length ? new Uint8Array(held.length + bytes.length) : bytes;
    if (held.length) (all.set(held), all.set(bytes, held.length));
    let at = 0;
    while (all.length - at >= 5) {
      const len = new DataView(all.buffer, all.byteOffset + at, 4).getUint32(0, true);
      if (all.length - at < 4 + len) break;
      const payload = all.subarray(at + 5, at + 4 + len);
      bridge.onframe(all[at + 4] === 0 ? decoder.decode(payload) : payload);
      at += 4 + len;
    }
    held = all.slice(at);
  };
  invoke('bridge_open', { frames }).catch(() => setTimeout(() => location.reload(), 1000));
  return bridge;
}
