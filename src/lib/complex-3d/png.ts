/**
 * 작은 PNG 해독기 (서버 전용) — 8비트 RGB/RGBA, 인터레이스 없음만. 표고 타일(terrarium) 읽기용.
 * 외부 패키지 없이 node:zlib 으로 푼다.
 */
import { inflateSync } from "node:zlib";

export type DecodedPng = { width: number; height: number; channels: 3 | 4; data: Uint8Array };

export function decodePng(buf: Uint8Array): DecodedPng {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error("unsupported png");
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x]!;
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const up = y ? out[dst - stride + x]! : 0;
      const ul = y && x >= channels ? out[dst - stride + x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + up; break;
        case 3: v = cur + ((a + up) >> 1); break;
        case 4: {
          const p = a + up - ul;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul);
          break;
        }
        default: throw new Error("bad png filter");
      }
      out[dst + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}
