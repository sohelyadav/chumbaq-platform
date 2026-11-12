/**
 * Checks for `project-role.ts`: what the dashboard shows or hides for a person's role in
 * a project. The server is still the authority; these keep the UI from offering what it
 * would refuse. Same reasoning as `segment-form.check.mjs`: `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { can, assignableRoles, canManageMember, seatLabel, atSeatLimit, roleLabel, shownValue, HIDDEN_FROM_ROLE, seatRefusalStands } = await jiti.import(
  path.join(here, 'project-role.ts'),
);

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

// The API's ROLE_PERMISSIONS, as `GET /api/projects` sends them.
const OWNER = ['project.read', 'messaging.write', 'people.read', 'channels.manage', 'keys.manage', 'members.manage', 'activity.view', 'privacy', 'project.admin'];
const ADMIN = OWNER.filter((p) => p !== 'privacy' && p !== 'project.admin');
const MEMBER = ['project.read', 'messaging.write', 'people.read'];

console.log('can');
check('a project not loaded yet can do nothing', can(undefined, 'project.read') === false);
check('nor one without permissions (an older API)', can({}, 'project.read') === false);
check('owner manages members', can({ permissions: OWNER }, 'members.manage') === true);
check('owner has project.admin', can({ permissions: OWNER }, 'project.admin') === true);
check('admin manages channels', can({ permissions: ADMIN }, 'channels.manage') === true);
check('admin has no project.admin (no danger zone)', can({ permissions: ADMIN }, 'project.admin') === false);
check('admin has no privacy', can({ permissions: ADMIN }, 'privacy') === false);
check('member reads', can({ permissions: MEMBER }, 'project.read') === true);
check('member cannot manage channels', can({ permissions: MEMBER }, 'channels.manage') === false);
check('member cannot manage keys', can({ permissions: MEMBER }, 'keys.manage') === false);
check('member cannot manage members', can({ permissions: MEMBER }, 'members.manage') === false);

console.log('assignableRoles');
const roles = (role) => JSON.stringify(assignableRoles(role));
check('owner may give all three', roles('owner') === JSON.stringify(['owner', 'admin', 'member']), roles('owner'));
check('admin may give admin and member', roles('admin') === JSON.stringify(['admin', 'member']), roles('admin'));
check('admin never offers owner', !assignableRoles('admin').includes('owner'));
check('member may give nothing', roles('member') === '[]', roles('member'));

console.log('canManageMember');
check('owner manages an owner', canManageMember('owner', 'owner') === true);
check('owner manages an admin', canManageMember('owner', 'admin') === true);
check('owner manages a member', canManageMember('owner', 'member') === true);
check('admin cannot touch an owner', canManageMember('admin', 'owner') === false);
check('admin manages an admin', canManageMember('admin', 'admin') === true);
check('admin manages a member', canManageMember('admin', 'member') === true);
check('member manages nobody', ['owner', 'admin', 'member'].every((t) => canManageMember('member', t) === false));

console.log('seatLabel');
check('"3 of 5 seats"', seatLabel({ used: 3, limit: 5 }) === '3 of 5 seats', seatLabel({ used: 3, limit: 5 }));
check('singular limit', seatLabel({ used: 1, limit: 1 }) === '1 of 1 seat', seatLabel({ used: 1, limit: 1 }));
check('no limit: "1 seat"', seatLabel({ used: 1, limit: null }) === '1 seat', seatLabel({ used: 1, limit: null }));
check('no limit: "4 seats"', seatLabel({ used: 4, limit: null }) === '4 seats', seatLabel({ used: 4, limit: null }));

console.log('atSeatLimit');
check('full', atSeatLimit({ used: 1, limit: 1 }) === true);
check('room left', atSeatLimit({ used: 1, limit: 2 }) === false);
// Staff may lower a limit below what an account already uses.
check('over the limit', atSeatLimit({ used: 4, limit: 2 }) === true);
check('no limit is never full', atSeatLimit({ used: 500, limit: null }) === false);
check('zero seats is full', atSeatLimit({ used: 0, limit: 0 }) === true);

console.log('roleLabel');
check('Owner', roleLabel('owner') === 'Owner');
check('Admin', roleLabel('admin') === 'Admin');
check('Member', roleLabel('member') === 'Member');

console.log('shownValue');
const WITHHELD = 'hidden while viewing as tenant';
check('a member sees why, not the placeholder', shownValue(WITHHELD, { permissions: MEMBER }) === HIDDEN_FROM_ROLE);
check('so does a project not loaded yet', shownValue(WITHHELD, undefined) === HIDDEN_FROM_ROLE);
// View-as reads as the owner and keeps the API's own words.
check('a role with channels.manage sees the API text', shownValue(WITHHELD, { permissions: OWNER }) === WITHHELD);
check('real values pass through for a member', shownValue('https://hooks.example.com/x', { permissions: MEMBER }) === 'https://hooks.example.com/x');
check('real values pass through for an admin', shownValue('AC123', { permissions: ADMIN }) === 'AC123');
check('null stays null', shownValue(null, { permissions: MEMBER }) === null);
check('undefined stays undefined', shownValue(undefined, { permissions: MEMBER }) === undefined);

console.log('seatRefusalStands');
// The server said "no free seats" at time 100. The form stays an upgrade notice until
// seats read after that show room, or a removal frees one (the page clears it then).
check('no refusal: nothing stands', seatRefusalStands(null, { used: 5, limit: 5 }, 200) === false);
check('refused, no seats data (not the billing owner)', seatRefusalStands(100, undefined, 0) === true);
check('refused, seats read before the refusal showing room', seatRefusalStands(100, { used: 4, limit: 5 }, 90) === true);
check('refused, seats read at the same moment', seatRefusalStands(100, { used: 4, limit: 5 }, 100) === true);
check('refused, fresh seats show room: cleared', seatRefusalStands(100, { used: 4, limit: 5 }, 150) === false);
check('refused, fresh seats still full', seatRefusalStands(100, { used: 5, limit: 5 }, 150) === true);
check('refused, fresh seats with no limit: cleared', seatRefusalStands(100, { used: 9, limit: null }, 150) === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
