import { TouchpointEntity } from '../../touchpoints/entities/touchpoint.entity';
import { CreditSplit } from '../entities/attribution-result.entity';

function toSplit(tp: TouchpointEntity, credit: number): CreditSplit {
  return {
    touchpointId: tp.id,
    touchpointType: tp.touchpointType,
    channel: tp.channel || '',
    campaign: tp.campaign || '',
    utmSource: tp.utmSource || '',
    utmMedium: tp.utmMedium || '',
    linkId: tp.linkId || '',
    credit: Math.round(credit * 10000) / 10000,
    touchedAt: tp.touchedAt.toISOString(),
  };
}

export function lastTouch(touchpoints: TouchpointEntity[]): CreditSplit[] {
  if (touchpoints.length === 0) return [];
  const sorted = [...touchpoints].sort(
    (a, b) => b.touchedAt.getTime() - a.touchedAt.getTime(),
  );
  return sorted.map((tp, i) => toSplit(tp, i === 0 ? 1 : 0));
}

export function firstTouch(touchpoints: TouchpointEntity[]): CreditSplit[] {
  if (touchpoints.length === 0) return [];
  const sorted = [...touchpoints].sort(
    (a, b) => a.touchedAt.getTime() - b.touchedAt.getTime(),
  );
  return sorted.map((tp, i) => toSplit(tp, i === 0 ? 1 : 0));
}

export function linear(touchpoints: TouchpointEntity[]): CreditSplit[] {
  if (touchpoints.length === 0) return [];
  const credit = 1 / touchpoints.length;
  const sorted = [...touchpoints].sort(
    (a, b) => a.touchedAt.getTime() - b.touchedAt.getTime(),
  );
  return sorted.map((tp) => toSplit(tp, credit));
}

export function timeDecay(
  touchpoints: TouchpointEntity[],
  halfLifeHours = 168, // 7 days
): CreditSplit[] {
  if (touchpoints.length === 0) return [];

  const sorted = [...touchpoints].sort(
    (a, b) => a.touchedAt.getTime() - b.touchedAt.getTime(),
  );

  const conversionTime = sorted[sorted.length - 1].touchedAt.getTime();
  const halfLifeMs = halfLifeHours * 60 * 60 * 1000;

  // Calculate raw weights using exponential decay
  const weights = sorted.map((tp) => {
    const timeDiff = conversionTime - tp.touchedAt.getTime();
    return Math.pow(2, -timeDiff / halfLifeMs);
  });

  // Normalize weights to sum to 1
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  return sorted.map((tp, i) => toSplit(tp, weights[i] / totalWeight));
}
