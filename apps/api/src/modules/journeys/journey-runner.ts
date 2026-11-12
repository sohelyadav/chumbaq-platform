import {
  JourneyStep,
  MAX_STEPS_PER_RUN,
  nextStepIndexes,
} from './journey-definition';

/** Where one person is in one journey. */
export interface JourneyRunState {
  currentStepIndex: number;
  /** How many steps this run has executed, for the loop budget. */
  stepsTaken: number;
}

/** What the runner should do about a step, having decided nothing itself. */
export type StepOutcome =
  | { kind: 'wait'; until: Date; nextStepIndex: number }
  | { kind: 'send_push'; step: JourneyStep; nextStepIndex: number }
  | { kind: 'send_email'; step: JourneyStep; nextStepIndex: number }
  | { kind: 'send_sms'; step: JourneyStep; nextStepIndex: number }
  | { kind: 'send_whatsapp'; step: JourneyStep; nextStepIndex: number }
  | { kind: 'branch'; segmentId: string; ifMember: number; ifNot: number }
  | { kind: 'finished'; reason: 'completed' | 'exited' }
  | { kind: 'failed'; reason: string };

/**
 * Decides what happens next, without doing any of it.
 *
 * Pure on purpose. The runner has to talk to the database, the segment
 * evaluator and the push sender, and none of that is worth mocking to answer
 * "which step comes after this one" — which is the part that has to be right,
 * because getting it wrong sends someone the wrong message or none at all.
 *
 * A branch is returned rather than resolved here: deciding it needs a
 * membership lookup, and this function stays free of I/O so it can be reasoned
 * about as a table of cases.
 */
export function decideNextStep(
  steps: JourneyStep[],
  state: JourneyRunState,
  now: Date,
): StepOutcome {
  if (state.stepsTaken >= MAX_STEPS_PER_RUN) {
    // Validation rejects definitions that can cycle without waiting, so this
    // is unreachable by a journey saved through the API. It exists because a
    // run that advances forever inside one tick would take the tick with it.
    return {
      kind: 'failed',
      reason: `Run exceeded ${MAX_STEPS_PER_RUN} steps and was stopped.`,
    };
  }

  const step = steps[state.currentStepIndex];
  if (!step) {
    // The definition changed under a run that was already inside it.
    return { kind: 'finished', reason: 'completed' };
  }

  switch (step.type) {
    case 'wait': {
      const [next] = nextStepIndexes(steps, state.currentStepIndex);
      if (next === undefined) return { kind: 'finished', reason: 'completed' };
      return {
        kind: 'wait',
        until: new Date(now.getTime() + step.durationSeconds * 1000),
        nextStepIndex: next,
      };
    }

    case 'send_push': {
      const [next] = nextStepIndexes(steps, state.currentStepIndex);
      return {
        kind: 'send_push',
        step,
        // Undefined means the push was the last thing the journey had to say.
        nextStepIndex: next ?? -1,
      };
    }

    case 'send_email': {
      const [next] = nextStepIndexes(steps, state.currentStepIndex);
      return {
        kind: 'send_email',
        step,
        nextStepIndex: next ?? -1,
      };
    }

    case 'send_sms': {
      const [next] = nextStepIndexes(steps, state.currentStepIndex);
      return {
        kind: 'send_sms',
        step,
        nextStepIndex: next ?? -1,
      };
    }

    case 'send_whatsapp': {
      const [next] = nextStepIndexes(steps, state.currentStepIndex);
      return {
        kind: 'send_whatsapp',
        step,
        nextStepIndex: next ?? -1,
      };
    }

    case 'branch':
      return {
        kind: 'branch',
        segmentId: step.segmentId,
        ifMember: step.ifMember,
        ifNot: step.ifNot,
      };

    case 'exit':
      return { kind: 'finished', reason: 'exited' };

    default:
      return {
        kind: 'failed',
        reason: `Unknown step type "${(step as { type?: string }).type}".`,
      };
  }
}

/**
 * The state after a step has been carried out.
 *
 * `nextStepIndex` of -1 means there was nothing after it, which completes the
 * run rather than pointing at a step that does not exist.
 */
export function advance(
  state: JourneyRunState,
  nextStepIndex: number,
): JourneyRunState | null {
  if (nextStepIndex < 0) return null;
  return {
    currentStepIndex: nextStepIndex,
    stepsTaken: state.stepsTaken + 1,
  };
}
