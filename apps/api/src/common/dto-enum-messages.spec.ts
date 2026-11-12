import * as fs from 'fs';
import * as path from 'path';

/**
 * Catches the next `@IsEnum` handed an array literal.
 *
 * `@IsEnum(['a', 'b'])` validates correctly and then reports
 * `must be one of the following values: ` with nothing after the colon:
 * class-validator reads the accepted set off an enum *object*, and an array
 * gives it none. The request is refused for a reason the response does not
 * state, so a client author has no way to learn what to send — the same shape
 * of problem as the four silent 400s this codebase has already paid for, and
 * found the same way, by an SDK author staring at an unexplained rejection.
 *
 * `@IsIn(['a', 'b'])` is the decorator for a list of permitted literals and
 * names every one of them. Nine sites across the in-app-messages DTOs were
 * `@IsEnum` over an array; `@IsIn` was already the idiom in the banner DTOs.
 *
 * Source-level rather than metadata-level for the same reason
 * `dto-object-arrays.spec.ts` is: the two decorators are indistinguishable
 * once reflected — both store a list of valid values — so the mistake is only
 * visible in the text.
 */
describe('DTO enums report their accepted values', () => {
  const dtoFiles = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.dto\.ts$/.test(entry.name)) found.push(full);
      }
    };
    walk(path.join(__dirname, '..'));
    return found;
  };

  it('uses @IsIn rather than @IsEnum for a list of literal values', () => {
    const offenders: string[] = [];

    for (const file of dtoFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        // `@IsEnum([` — an array argument, on one line or opening a wrapped one.
        if (/@IsEnum\(\s*\[/.test(line)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('finds the DTO files it is supposed to be scanning', () => {
    // A guard that silently scans nothing passes forever. This has happened
    // to source-level checks before: a moved directory turns the check into a
    // no-op that still reports green.
    expect(dtoFiles().length).toBeGreaterThan(20);
  });
});
