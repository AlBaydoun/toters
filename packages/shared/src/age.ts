/**
 * Age-restricted goods under the Jugendschutzgesetz (JuSchG).
 *
 * The self-declared date of birth only pre-gates the basket. The binding check is
 * always the courier's physical ID verification at handover — we record the
 * verified yes/no and the document type, never the document number or an image.
 * That is data minimisation under GDPR Art. 5(1)(c).
 */

export const AGE_BEER_WINE = 16;
export const AGE_SPIRITS_TOBACCO = 18;

export type IdDocumentType = "PERSONALAUSWEIS" | "REISEPASS" | "AUFENTHALTSTITEL" | "EU_DRIVING_LICENCE";

export function requiredAgeForBasket(minimumAges: (number | null | undefined)[]): number | null {
  const ages = minimumAges.filter((a): a is number => typeof a === "number");
  return ages.length ? Math.max(...ages) : null;
}

export function isOldEnough(dateOfBirth: Date, requiredAge: number, at: Date = new Date()): boolean {
  const threshold = new Date(at);
  threshold.setFullYear(threshold.getFullYear() - requiredAge);
  return dateOfBirth <= threshold;
}

export interface AgeCheckRecord {
  verified: boolean;
  documentType: IdDocumentType | null;
  courierId: string;
  checkedAt: Date;
}

export function buildAgeCheckRecord(
  courierId: string,
  verified: boolean,
  documentType: IdDocumentType | null,
): AgeCheckRecord {
  return { verified, documentType: verified ? documentType : null, courierId, checkedAt: new Date() };
}
