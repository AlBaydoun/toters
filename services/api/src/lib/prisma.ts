import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/**
 * Human-facing order reference, e.g. "LF-7Q4M2K". Excludes I/O/0/1 so it can be
 * read aloud to support without ambiguity.
 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function orderReference(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `LF-${out}`;
}
