import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingestImage, sniffImageType, stripJpegMetadata, stripPngMetadata,
  MediaTooLargeError, UnsupportedMediaError, MAX_UPLOAD_BYTES,
} from "./media.js";

/**
 * EXIF stripping is a privacy control, not a nicety: a doorstep photo carries
 * the GPS coordinates of someone's home. These tests assert the bytes actually
 * leave.
 */

/** A minimal JPEG carrying an APP1/EXIF segment with a recognisable payload. */
function jpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);

  const exifPayload = Buffer.concat([
    Buffer.from("Exif\0\0", "ascii"),
    Buffer.from("GPSLatitude=51.3397;GPSLongitude=12.3731;Make=SecretPhone", "ascii"),
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(exifPayload.length + 2);
      return len;
    })(),
    exifPayload,
  ]);

  // A frame header so the result is still a structurally plausible JPEG.
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const scan = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const eoi = Buffer.from([0xff, 0xd9]);

  return Buffer.concat([soi, app1, sof, sos, scan, eoi]);
}

function pngWithTextChunk(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function chunk(type: string, data: Buffer) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); // Not validated by the stripper.
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", Buffer.alloc(13)),
    chunk("tEXt", Buffer.from("Comment\0taken at home 51.3397,12.3731", "ascii")),
    chunk("eXIf", Buffer.from("GPSLatitude=51.3397", "ascii")),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("JPEG EXIF is removed, including GPS coordinates", () => {
  const original = jpegWithExif();
  assert.ok(original.includes(Buffer.from("GPSLatitude", "ascii")), "fixture should contain GPS");

  const stripped = stripJpegMetadata(original);
  assert.ok(!stripped.includes(Buffer.from("GPSLatitude", "ascii")), "GPS must be gone");
  assert.ok(!stripped.includes(Buffer.from("SecretPhone", "ascii")), "device make must be gone");

  // Still a JPEG, and the image data survived.
  assert.equal(stripped[0], 0xff);
  assert.equal(stripped[1], 0xd8);
  assert.ok(stripped.includes(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])), "scan data must survive");
  assert.ok(stripped.length < original.length);
});

test("PNG text and eXIf chunks are removed, image data kept", () => {
  const original = pngWithTextChunk();
  const stripped = stripPngMetadata(original);

  assert.ok(!stripped.includes(Buffer.from("taken at home", "ascii")));
  assert.ok(!stripped.includes(Buffer.from("GPSLatitude", "ascii")));
  assert.ok(stripped.includes(Buffer.from("IHDR", "ascii")));
  assert.ok(stripped.includes(Buffer.from("IDAT", "ascii")));
  assert.ok(stripped.includes(Buffer.from("IEND", "ascii")));
});

test("type is sniffed from magic bytes, not the declared header", () => {
  assert.equal(sniffImageType(jpegWithExif()), "image/jpeg");
  assert.equal(sniffImageType(pngWithTextChunk()), "image/png");

  // An HTML document declaring itself as an image is how stored XSS gets in.
  const html = Buffer.from("<html><script>alert(1)</script></html>", "ascii");
  assert.equal(sniffImageType(html), null);
  assert.throws(() => ingestImage(html, "image/jpeg"), UnsupportedMediaError);
});

test("oversized uploads are refused before any processing", () => {
  const huge = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
  assert.throws(() => ingestImage(huge, "image/jpeg"), MediaTooLargeError);
});

test("ingest reports how much metadata it removed", () => {
  const result = ingestImage(jpegWithExif(), "image/jpeg");
  assert.equal(result.contentType, "image/jpeg");
  assert.ok(result.strippedBytes > 0, "should report stripped bytes");
  assert.ok(!result.buffer.includes(Buffer.from("GPSLatitude", "ascii")));
});

test("identical images get distinct storage keys", () => {
  // Content-addressed keys would let two orders' photos collide into one
  // object that either conversation could reach.
  const a = ingestImage(jpegWithExif(), "image/jpeg");
  const b = ingestImage(jpegWithExif(), "image/jpeg");
  assert.notEqual(a.storageKey, b.storageKey);
});
