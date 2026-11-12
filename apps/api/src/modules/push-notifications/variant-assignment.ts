import type { WhatsAppContent } from './message-channel';
import { createHash } from 'crypto';

/** One arm of an experiment. */
export interface PushVariant {
  /** Short stable label shown in reports, e.g. `A`. */
  key: string;
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  deepLinkUrl?: string | null;
  /** Share of the treated audience, as a percentage. Weights total 100. */
  weight: number;
  /**
   * Per-language copy for *this arm*.
   *
   * Deliberately per-variant rather than campaign-wide: a campaign-level
   * translation would replace whatever copy the arm is testing, which is the
   * one thing an experiment must not do. Each arm carries its own languages,
   * so the thing being compared survives translation.
   */
  translations?: Record<string, { title?: string; body?: string }>;
  /** Email arms only: this arm's HTML. Falls back to the campaign's. */
  html?: string | null;
  /** Email arms only: this arm's preheader. Falls back to the campaign's. */
  preheader?: string | null;
  /**
   * WhatsApp arms only: this arm's template and values. An arm cannot fall
   * back field by field — a different template has different placeholders —
   * so it is the whole message or nothing.
   */
  whatsapp?: WhatsAppContent | null;
}

/** Where a device landed. */
export type VariantAssignment =
  | { arm: 'control' }
  | { arm: 'variant'; key: string };

export const MAX_CONTROL_PERCENTAGE = 50;

/**
 * A stable number in [0, 100) for this device in this experiment.
 *
 * Hashed rather than random so a resumed or re-expanded campaign puts the same
 * person in the same arm every time — an experiment that reshuffles on retry
 * is not an experiment. Salted with the campaign id so the same device is not
 * permanently in the same position across every test you ever run.
 */
export function bucketFor(campaignId: string, deviceIdentityId: string): number {
  const digest = createHash('sha256')
    .update(`${campaignId}:${deviceIdentityId}`)
    .digest();
  // 32 bits is far more resolution than 100 buckets needs, and avoids the
  // modulo bias a single byte would introduce.
  return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

/**
 * Decides which arm a device belongs to.
 *
 * The control slice is taken off the top of the bucket range, so changing the
 * variant weights does not move anyone in or out of control — only the split
 * among the treated changes.
 */
export function assignVariant(
  campaignId: string,
  deviceIdentityId: string,
  variants: PushVariant[],
  controlPercentage = 0,
): VariantAssignment {
  const bucket = bucketFor(campaignId, deviceIdentityId);

  if (controlPercentage > 0 && bucket < controlPercentage) {
    return { arm: 'control' };
  }

  // Rescale the remaining range onto the variant weights so each arm gets its
  // stated share of the *treated* audience rather than of everyone.
  const treatedSpan = 100 - controlPercentage;
  const position = ((bucket - controlPercentage) / treatedSpan) * 100;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (position < cumulative) return { arm: 'variant', key: variant.key };
  }

  // Floating-point drift can leave `position` a hair above the final boundary.
  // Falling back to the last variant keeps every device assigned; returning
  // nothing would silently drop recipients from the send.
  return { arm: 'variant', key: variants[variants.length - 1].key };
}

/** Groups an audience into control plus one bucket per variant key. */
export function splitAudience(
  campaignId: string,
  deviceIdentityIds: string[],
  variants: PushVariant[],
  controlPercentage = 0,
): { control: string[]; byVariant: Map<string, string[]> } {
  const control: string[] = [];
  const byVariant = new Map<string, string[]>(
    variants.map((variant) => [variant.key, []]),
  );

  for (const deviceIdentityId of deviceIdentityIds) {
    const assignment = assignVariant(
      campaignId,
      deviceIdentityId,
      variants,
      controlPercentage,
    );
    if (assignment.arm === 'control') {
      control.push(deviceIdentityId);
    } else {
      byVariant.get(assignment.key)!.push(deviceIdentityId);
    }
  }

  return { control, byVariant };
}

/**
 * Validates an experiment definition.
 *
 * Server-side because a client could otherwise post arms summing to 90 and
 * quietly lose a tenth of the audience.
 */
export function validateVariants(
  variants: PushVariant[],
  controlPercentage: number,
): string | null {
  if (!Array.isArray(variants) || variants.length < 2) {
    return 'An experiment needs at least two variants.';
  }
  if (variants.length > 5) {
    return 'An experiment supports at most five variants.';
  }

  const keys = new Set(variants.map((v) => v.key));
  if (keys.size !== variants.length) {
    return 'Variant keys must be unique.';
  }
  if (variants.some((v) => !v.key?.trim())) {
    return 'Every variant needs a key.';
  }
  if (variants.some((v) => !v.title?.trim())) {
    return 'Every variant needs a title.';
  }
  if (variants.some((v) => !Number.isFinite(v.weight) || v.weight <= 0)) {
    return 'Every variant needs a weight above zero.';
  }

  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  if (Math.abs(total - 100) > 0.01) {
    return `Variant weights must total 100, got ${total}.`;
  }

  if (
    controlPercentage < 0 ||
    controlPercentage > MAX_CONTROL_PERCENTAGE ||
    !Number.isFinite(controlPercentage)
  ) {
    return `Control group must be between 0 and ${MAX_CONTROL_PERCENTAGE} percent.`;
  }

  return null;
}
