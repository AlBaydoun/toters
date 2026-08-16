/**
 * Media ingest.
 *
 * Two things matter here and neither is storage: stripping EXIF, and never
 * serving a raw public URL.
 *
 * A photo taken at someone's front door carries GPS coordinates, a timestamp
 * and a device identifier in its EXIF block. Storing that unmodified would mean
 * a courier's doorstep photo leaks the customer's exact home location into a
 * file that later gets attached to a support ticket. We strip it on ingest,
 * before the bytes are ever written.
 */
import { createHash, randomBytes } from "node:crypto";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export class UnsupportedMediaError extends Error {
  constructor(contentType: string) {
    super(`Unsupported media type: ${contentType}`);
    this.name = "UnsupportedMediaError";
  }
}

export class MediaTooLargeError extends Error {
  constructor(size: number) {
    super(`File is ${size} bytes; the limit is ${MAX_UPLOAD_BYTES}`);
    this.name = "MediaTooLargeError";
  }
}

/**
 * Detect the real type from magic bytes rather than trusting the declared
 * Content-Type. A client claiming image/jpeg while uploading an HTML document
 * is how stored-XSS gets into a chat thread.
 */
export function sniffImageType(buffer: Buffer): AllowedImageType | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => buffer[i] === byte)) return "image/png";

  // RIFF....WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * Remove EXIF/XMP metadata from a JPEG by dropping every APP segment.
 *
 * JPEG is a sequence of marker segments. APP1 (0xFFE1) holds EXIF and XMP;
 * APP0 is JFIF, which is harmless but carries nothing we need. We copy the
 * image through, skipping APPn segments, and stop at start-of-scan where the
 * compressed data begins.
 *
 * PNG and WebP are handled by chunk filtering below.
 */
export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return input;

  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;

  while (offset < input.length - 1) {
    if (input[offset] !== 0xff) break;

    const marker = input[offset + 1]!;

    // Start of scan: the rest is entropy-coded image data, copy it verbatim.
    if (marker === 0xda) {
      out.push(input.subarray(offset));
      break;
    }
    // End of image.
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    // Standalone markers carry no length field.
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = input.readUInt16BE(offset + 2);
    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    // COM comment segments can also carry arbitrary text.
    const isComment = marker === 0xfe;

    if (!isAppSegment && !isComment) {
      out.push(input.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }

  return Buffer.concat(out);
}

/** PNG: keep only the chunks needed to render. Drops eXIf, tEXt, iTXt, zTXt. */
export function stripPngMetadata(input: Buffer): Buffer {
  const signature = input.subarray(0, 8);
  const keep = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "acTL", "fcTL", "fdAT"]);

  const out: Buffer[] = [signature];
  let offset = 8;

  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const total = 12 + length; // length + type + data + crc

    if (offset + total > input.length) break;
    if (keep.has(type)) out.push(input.subarray(offset, offset + total));

    offset += total;
    if (type === "IEND") break;
  }

  return Buffer.concat(out);
}

export interface IngestResult {
  buffer: Buffer;
  contentType: AllowedImageType;
  storageKey: string;
  byteSize: number;
  /** Bytes removed by metadata stripping — surfaced so it can be asserted on. */
  strippedBytes: number;
}

/**
 * Validate, strip and key an upload. Pure: no I/O, so it is fully testable.
 */
export function ingestImage(input: Buffer, declaredType: string): IngestResult {
  if (input.length > MAX_UPLOAD_BYTES) throw new MediaTooLargeError(input.length);

  const actualType = sniffImageType(input);
  if (!actualType) throw new UnsupportedMediaError(declaredType);

  let cleaned: Buffer;
  switch (actualType) {
    case "image/jpeg":
      cleaned = stripJpegMetadata(input);
      break;
    case "image/png":
      cleaned = stripPngMetadata(input);
      break;
    default:
      // WebP metadata lives in optional EXIF/XMP chunks; until we parse RIFF
      // properly, pass it through rather than pretending it was cleaned.
      cleaned = input;
      break;
  }

  // Random key, not a content hash: identical photos from different orders must
  // not collide into one object that both conversations can reach.
  const key = `${new Date().toISOString().slice(0, 10)}/${randomBytes(16).toString("hex")}`;

  return {
    buffer: cleaned,
    contentType: actualType,
    storageKey: key,
    byteSize: cleaned.length,
    strippedBytes: input.length - cleaned.length,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface MediaStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Short-lived signed URL. Media is never publicly addressable. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

/** In-memory storage for development and tests. */
export class MemoryStorage implements MediaStorage {
  private objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }

  async signedUrl(key: string, ttlSeconds: number) {
    const expires = Date.now() + ttlSeconds * 1000;
    const signature = createHash("sha256").update(`${key}:${expires}`).digest("hex").slice(0, 16);
    return `/v1/media/${encodeURIComponent(key)}?expires=${expires}&sig=${signature}`;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  get(key: string) {
    return this.objects.get(key) ?? null;
  }
}

export const mediaStorage = new MemoryStorage();
