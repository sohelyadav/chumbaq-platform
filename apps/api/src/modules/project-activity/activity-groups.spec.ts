// A test may import shared's values (jest maps the path); the API itself may not.
import { ACTIVITY_ACTION_GROUP, PROJECT_ACTIVITY_GROUPS } from '@chumbaq/shared';
import { ACTIVITY_ACTION_GROUPS, ACTIVITY_GROUPS, PRIVACY_ACTIONS, actionsInGroup } from './activity-groups';

describe('activity groups (the API copy)', () => {
  it('lists the same groups as shared, in the same order', () => {
    expect([...ACTIVITY_GROUPS]).toEqual([...PROJECT_ACTIVITY_GROUPS]);
  });

  it('puts every action in the same group as shared', () => {
    expect({ ...ACTIVITY_ACTION_GROUPS }).toEqual({ ...ACTIVITY_ACTION_GROUP });
  });

  it('names the privacy actions', () => {
    expect([...PRIVACY_ACTIONS].sort()).toEqual(
      [
        'person.erased',
        'person.exported',
        'person.consent_changed',
        'tracking.objection_recorded',
        'tracking.objection_lifted',
        'suppression.added',
        'suppression.removed',
      ].sort(),
    );
    expect(actionsInGroup('privacy')).toEqual(PRIVACY_ACTIONS);
  });

  it('gives every group at least one action', () => {
    for (const group of ACTIVITY_GROUPS) expect(actionsInGroup(group).length).toBeGreaterThan(0);
  });
});
