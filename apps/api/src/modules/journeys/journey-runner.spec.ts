import { decideNextStep, advance, JourneyRunState } from './journey-runner';
import { JourneyStep, MAX_STEPS_PER_RUN } from './journey-definition';

const now = new Date('2026-06-01T10:00:00Z');
const at = (index: number, stepsTaken = 0): JourneyRunState => ({
  currentStepIndex: index,
  stepsTaken,
});

const wait = (durationSeconds: number): JourneyStep => ({
  type: 'wait',
  durationSeconds,
});
const push: JourneyStep = { type: 'send_push', title: 'Hello' };
const exitStep: JourneyStep = { type: 'exit' };

describe('decideNextStep', () => {
  it('schedules a wait for the far side of its duration', () => {
    const outcome = decideNextStep([wait(3600), push], at(0), now);

    expect(outcome).toEqual({
      kind: 'wait',
      until: new Date('2026-06-01T11:00:00Z'),
      nextStepIndex: 1,
    });
  });

  it('asks the runner to send, and says what follows', () => {
    const outcome = decideNextStep([push, exitStep], at(0), now);

    expect(outcome).toMatchObject({ kind: 'send_push', nextStepIndex: 1 });
  });

  it('completes after a send that ends the journey', () => {
    const outcome = decideNextStep([push], at(0), now);

    // -1 rather than 1: pointing at a step that does not exist would strand
    // the run on the next tick.
    expect(outcome).toMatchObject({ kind: 'send_push', nextStepIndex: -1 });
  });

  it('hands a branch back undecided, because deciding it needs a lookup', () => {
    const branch: JourneyStep = {
      type: 'branch',
      segmentId: 'seg-1',
      ifMember: 2,
      ifNot: 1,
    };

    expect(decideNextStep([branch, push, exitStep], at(0), now)).toEqual({
      kind: 'branch',
      segmentId: 'seg-1',
      ifMember: 2,
      ifNot: 1,
    });
  });

  it('ends the run at an exit', () => {
    expect(decideNextStep([exitStep], at(0), now)).toEqual({
      kind: 'finished',
      reason: 'exited',
    });
  });

  it('completes a run that has run off the end', () => {
    // The definition was edited while someone was inside it.
    expect(decideNextStep([push], at(5), now)).toEqual({
      kind: 'finished',
      reason: 'completed',
    });
  });

  it('stops a run that has taken too many steps', () => {
    // Unreachable through a validated definition, which is the point: it
    // catches the one that got in another way, before it takes the tick with
    // it.
    const outcome = decideNextStep([push], at(0, MAX_STEPS_PER_RUN), now);

    expect(outcome).toMatchObject({ kind: 'failed' });
  });

  it('fails on a step type it cannot carry out', () => {
    const outcome = decideNextStep([{ type: 'dance' } as never], at(0), now);

    // Failing loudly beats skipping: a journey silently missing a step is
    // worse than one that stops and says so.
    expect(outcome).toMatchObject({ kind: 'failed' });
  });
});

describe('advance', () => {
  it('moves to the next step and counts it', () => {
    expect(advance(at(0, 3), 5)).toEqual({ currentStepIndex: 5, stepsTaken: 4 });
  });

  it('ends the run when there is nothing after', () => {
    expect(advance(at(0), -1)).toBeNull();
  });

  it('counts a step even when it goes backwards', () => {
    // A loop through a wait is legitimate, so the budget has to count laps or
    // it would never bound one.
    expect(advance(at(4, 9), 1)).toEqual({ currentStepIndex: 1, stepsTaken: 10 });
  });
});
