import { WhatsAppContent } from '../push-notifications/message-channel';
/**
 * What a journey is, and what makes one valid.
 *
 * Kept free of NestJS and TypeORM so the rules can be tested as functions.
 * Everything here is checked when a journey is saved rather than when it runs:
 * a definition that cycles or points at a step that does not exist would
 * otherwise fail days later, against a person halfway through it.
 */

export type JourneyTrigger =
  | { type: 'event'; eventName: string }
  | { type: 'segment_entry'; segmentId: string };

export interface WaitStep {
  type: 'wait';
  /** How long before the next step. */
  durationSeconds: number;
}

export interface SendPushStep {
  type: 'send_push';
  title: string;
  body?: string;
  imageUrl?: string;
  deepLinkUrl?: string;
}

/**
 * Sends one email to the person, through the project's email provider and
 * subject to the same consent, suppression and frequency cap as any email
 * campaign.
 */
export interface SendEmailStep {
  type: 'send_email';
  subject: string;
  html: string;
  text?: string;
  preheader?: string;
}

/**
 * Texts the person, through the project's SMS provider and subject to the
 * same consent, suppression and frequency cap as any SMS campaign.
 */
export interface SendSmsStep {
  type: 'send_sms';
  body: string;
}

/**
 * Sends one approved WhatsApp template to the person, subject to the same
 * consent, suppression and frequency cap as a WhatsApp campaign.
 */
export interface SendWhatsAppStep {
  type: 'send_whatsapp';
  content: WhatsAppContent;
}

export interface BranchStep {
  type: 'branch';
  /** Membership decides which way the person goes. */
  segmentId: string;
  /** Step index taken when they are a member. */
  ifMember: number;
  /** Step index taken when they are not. */
  ifNot: number;
}

export interface ExitStep {
  type: 'exit';
}

export type JourneyStep =
  | WaitStep
  | SendPushStep
  | SendEmailStep
  | SendSmsStep
  | SendWhatsAppStep
  | BranchStep
  | ExitStep;

/**
 * A run may execute at most this many steps before it is abandoned.
 *
 * Validation rejects definitions that can cycle without a wait, so this should
 * never be reached. It exists because "should never" is not a guarantee, and
 * the failure it prevents is a run advancing forever inside one tick.
 */
export const MAX_STEPS_PER_RUN = 100;

/** Below this a wait is indistinguishable from no wait. */
export const MIN_WAIT_SECONDS = 60;

export function validateJourney(
  trigger: JourneyTrigger,
  steps: JourneyStep[],
): string | null {
  if (!trigger || typeof trigger !== 'object') return 'A journey needs a trigger.';
  if (trigger.type === 'event' && !trigger.eventName?.trim()) {
    return 'An event trigger needs an event name.';
  }
  if (trigger.type === 'segment_entry' && !trigger.segmentId?.trim()) {
    return 'A segment trigger needs a segment.';
  }
  if (!['event', 'segment_entry'].includes(trigger.type)) {
    return `Unknown trigger type "${(trigger as { type: string }).type}".`;
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return 'A journey needs at least one step.';
  }

  for (const [index, step] of steps.entries()) {
    const problem = validateStep(step, index, steps.length);
    if (problem) return problem;
  }

  return findCycle(steps);
}

function validateStep(
  step: JourneyStep,
  index: number,
  total: number,
): string | null {
  const at = `Step ${index + 1}`;

  switch (step?.type) {
    case 'wait':
      if (!Number.isFinite(step.durationSeconds) || step.durationSeconds < MIN_WAIT_SECONDS) {
        return `${at}: a wait must be at least ${MIN_WAIT_SECONDS} seconds.`;
      }
      return null;

    case 'send_push':
      if (!step.title?.trim()) return `${at}: a push needs a title.`;
      return null;

    case 'send_email':
      if (!step.subject?.trim()) return `${at}: an email needs a subject.`;
      if (!step.html?.trim()) return `${at}: an email needs a body.`;
      return null;

    case 'send_whatsapp': {
      const content = step.content;
      if (!content?.template?.id?.trim() || !content.template.language?.trim()) {
        return `${at}: a WhatsApp message needs a template.`;
      }
      if (!Array.isArray(content.bodyParams) || content.bodyParams.some((v) => typeof v !== 'string' || !v.trim())) {
        return `${at}: fill in every value the WhatsApp template needs.`;
      }
      return null;
    }

    case 'send_sms':
      if (!step.body?.trim()) return `${at}: a text message needs a body.`;
      if (step.body.length > 1600) return `${at}: a text message can be at most 1600 characters.`;
      return null;

    case 'branch': {
      if (!step.segmentId?.trim()) return `${at}: a branch needs a segment.`;
      // Out-of-range targets are the failure this catches: a branch pointing
      // past the end would strand whoever took it.
      for (const [label, target] of [
        ['member', step.ifMember],
        ['non-member', step.ifNot],
      ] as const) {
        if (!Number.isInteger(target) || target < 0 || target >= total) {
          return `${at}: the ${label} path points at a step that does not exist.`;
        }
      }
      return null;
    }

    case 'exit':
      return null;

    default:
      return `${at}: unknown step type "${(step as { type?: string })?.type}".`;
  }
}

/**
 * The step or steps a given step can lead to.
 *
 * Anything other than a branch simply falls through to the next step, and the
 * last step ends the run — which is why a journey needs no explicit exit.
 */
export function nextStepIndexes(steps: JourneyStep[], index: number): number[] {
  const step = steps[index];
  if (!step || step.type === 'exit') return [];
  if (step.type === 'branch') return [step.ifMember, step.ifNot];
  return index + 1 < steps.length ? [index + 1] : [];
}

/**
 * Rejects a definition that can loop without ever waiting.
 *
 * A cycle through a `wait` is legitimate and common — "check again tomorrow" —
 * so only cycles with no wait in them are refused. Those would advance a run
 * as fast as the runner can loop, which is a hot loop rather than a journey.
 */
function findCycle(steps: JourneyStep[]): string | null {
  const VISITING = 1;
  const DONE = 2;
  const state = new Array<number>(steps.length).fill(0);

  const walk = (index: number): boolean => {
    if (steps[index]?.type === 'wait') return false;
    if (state[index] === VISITING) return true;
    if (state[index] === DONE) return false;

    state[index] = VISITING;
    for (const next of nextStepIndexes(steps, index)) {
      if (walk(next)) return true;
    }
    state[index] = DONE;
    return false;
  };

  for (let i = 0; i < steps.length; i += 1) {
    if (walk(i)) {
      return 'These steps can loop without waiting, which would run without end. Add a wait inside the loop.';
    }
  }
  return null;
}
