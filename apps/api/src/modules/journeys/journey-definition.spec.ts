import {
  validateJourney,
  nextStepIndexes,
  JourneyStep,
  JourneyTrigger,
  MIN_WAIT_SECONDS,
} from './journey-definition';

const eventTrigger: JourneyTrigger = { type: 'event', eventName: 'signup' };
const wait = (durationSeconds = 3600): JourneyStep => ({ type: 'wait', durationSeconds });
const push = (title = 'Hello'): JourneyStep => ({ type: 'send_push', title });
const exitStep: JourneyStep = { type: 'exit' };

describe('journey validation', () => {
  it('accepts a straightforward journey', () => {
    expect(validateJourney(eventTrigger, [wait(), push(), exitStep])).toBeNull();
  });

  describe('triggers', () => {
    it('rejects an event trigger with no event', () => {
      expect(validateJourney({ type: 'event', eventName: ' ' }, [push()])).toMatch(
        /needs an event name/,
      );
    });

    it('rejects a segment trigger with no segment', () => {
      expect(
        validateJourney({ type: 'segment_entry', segmentId: '' }, [push()]),
      ).toMatch(/needs a segment/);
    });

    it('rejects a trigger type it cannot act on', () => {
      // Accepting it would mean a journey that is active and enrols nobody.
      expect(
        validateJourney({ type: 'birthday' } as never, [push()]),
      ).toMatch(/Unknown trigger type/);
    });
  });

  describe('steps', () => {
    it('rejects a journey with no steps', () => {
      expect(validateJourney(eventTrigger, [])).toMatch(/at least one step/);
    });

    it('rejects a wait too short to be a wait', () => {
      expect(validateJourney(eventTrigger, [wait(5)])).toMatch(/at least/);
      expect(validateJourney(eventTrigger, [wait(MIN_WAIT_SECONDS)])).toBeNull();
    });

    it('rejects a push with no title', () => {
      expect(
        validateJourney(eventTrigger, [{ type: 'send_push', title: '  ' }]),
      ).toMatch(/needs a title/);
    });

    it('names the step that is wrong', () => {
      // A journey is edited as a list; "something is invalid" is not actionable.
      expect(validateJourney(eventTrigger, [wait(), push(''), exitStep])).toMatch(
        /Step 2/,
      );
    });

    it('rejects an unknown step type', () => {
      expect(validateJourney(eventTrigger, [{ type: 'dance' } as never])).toMatch(
        /unknown step type/,
      );
    });
  });

  describe('branches', () => {
    const branch = (ifMember: number, ifNot: number): JourneyStep => ({
      type: 'branch',
      segmentId: 'seg-1',
      ifMember,
      ifNot,
    });

    it('accepts a branch pointing at real steps', () => {
      expect(
        validateJourney(eventTrigger, [branch(1, 2), push(), exitStep]),
      ).toBeNull();
    });

    it('rejects a branch pointing past the end', () => {
      // Whoever took that path would be stranded mid-journey.
      expect(validateJourney(eventTrigger, [branch(1, 99), push()])).toMatch(
        /does not exist/,
      );
    });

    it('rejects a negative target', () => {
      expect(validateJourney(eventTrigger, [branch(-1, 1), push()])).toMatch(
        /does not exist/,
      );
    });

    it('rejects a branch with no segment to test', () => {
      expect(
        validateJourney(eventTrigger, [
          { type: 'branch', segmentId: '', ifMember: 1, ifNot: 1 },
          push(),
        ]),
      ).toMatch(/needs a segment/);
    });
  });

  describe('loops', () => {
    it('rejects a cycle with no wait in it', () => {
      // This would advance as fast as the runner can loop, which is a hot
      // loop rather than a journey.
      const steps: JourneyStep[] = [
        push(),
        { type: 'branch', segmentId: 'seg-1', ifMember: 0, ifNot: 2 },
        exitStep,
      ];
      expect(validateJourney(eventTrigger, steps)).toMatch(/loop without waiting/);
    });

    it('accepts a cycle that waits, which is an ordinary reminder', () => {
      // "Check again tomorrow" is a legitimate journey, not a mistake.
      const steps: JourneyStep[] = [
        wait(86_400),
        { type: 'branch', segmentId: 'seg-1', ifMember: 2, ifNot: 0 },
        exitStep,
      ];
      expect(validateJourney(eventTrigger, steps)).toBeNull();
    });

    it('rejects a branch that points at itself', () => {
      expect(
        validateJourney(eventTrigger, [
          { type: 'branch', segmentId: 'seg-1', ifMember: 0, ifNot: 0 },
        ]),
      ).toMatch(/loop without waiting/);
    });
  });
});

describe('nextStepIndexes', () => {
  it('falls through to the following step', () => {
    expect(nextStepIndexes([push(), exitStep], 0)).toEqual([1]);
  });

  it('ends the run at the last step, so no explicit exit is needed', () => {
    expect(nextStepIndexes([push()], 0)).toEqual([]);
  });

  it('ends the run at an exit', () => {
    expect(nextStepIndexes([exitStep, push()], 0)).toEqual([]);
  });

  it('offers both sides of a branch', () => {
    const steps: JourneyStep[] = [
      { type: 'branch', segmentId: 's', ifMember: 2, ifNot: 1 },
      push(),
      exitStep,
    ];
    expect(nextStepIndexes(steps, 0)).toEqual([2, 1]);
  });

  describe('send_email', () => {
    const trigger = { type: 'event' as const, eventName: 'signup' };

    it('accepts an email with a subject and body', () => {
      expect(
        validateJourney(trigger, [{ type: 'send_email', subject: 'Hi', html: '<p>Hi</p>' }]),
      ).toBeNull();
    });

    it('refuses an email without a subject', () => {
      expect(
        validateJourney(trigger, [{ type: 'send_email', subject: ' ', html: '<p>Hi</p>' }]),
      ).toMatch(/subject/);
    });

    it('refuses an email without a body', () => {
      expect(
        validateJourney(trigger, [{ type: 'send_email', subject: 'Hi', html: '' }]),
      ).toMatch(/body/);
    });
  });

  describe('send_sms', () => {
    const trigger = { type: 'event' as const, eventName: 'signup' };

    it('accepts a text with a body', () => {
      expect(validateJourney(trigger, [{ type: 'send_sms', body: 'Hi' }])).toBeNull();
    });

    it('refuses an empty text', () => {
      expect(validateJourney(trigger, [{ type: 'send_sms', body: '  ' }])).toMatch(/body/);
    });

    it('refuses a text longer than the provider accepts', () => {
      expect(
        validateJourney(trigger, [{ type: 'send_sms', body: 'x'.repeat(1601) }]),
      ).toMatch(/1600/);
    });
  });

  describe('send_whatsapp', () => {
    const trigger = { type: 'event' as const, eventName: 'signup' };
    const content = { template: { id: 'promo', name: 'promo', language: 'en' }, bodyParams: ['Priya'] };

    it('accepts a template with its values', () => {
      expect(validateJourney(trigger, [{ type: 'send_whatsapp', content }])).toBeNull();
    });

    it('refuses a step with no template', () => {
      expect(
        validateJourney(trigger, [{ type: 'send_whatsapp', content: { ...content, template: { id: '', name: '', language: 'en' } } }]),
      ).toMatch(/template/);
    });

    it('refuses an empty value, which WhatsApp would reject', () => {
      expect(
        validateJourney(trigger, [{ type: 'send_whatsapp', content: { ...content, bodyParams: [' '] } }]),
      ).toMatch(/value/);
    });
  });
});
