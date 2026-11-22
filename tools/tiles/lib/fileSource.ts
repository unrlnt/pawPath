/** Reads byte ranges from a local .pmtiles file — all PMTiles needs in Node. */

import { open } from 'node:fs/promises';

import type { RangeResponse, Source } from 'pmtiles';

export class FileSource implements Source {
  constructor(private readonly path: string) {}

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) };
    } finally {
      await handle.close();
    }
  }
}
