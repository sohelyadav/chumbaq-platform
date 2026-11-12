import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Catches the next object array that forgets `@Type`.
 *
 * The global pipe runs with `enableImplicitConversion`, which coerces every
 * property to its reflected `design:type`. TypeScript erases `Foo[]` to
 * `Array`, so an array of objects has each element coerced into an array and
 * arrives as `[[]]` — silently, with validation passing.
 *
 * It cost three fields before anyone noticed: journey steps, push action
 * buttons and carousel slides, each shipped, unit-tested and broken on every
 * real request. A string array is unaffected, since a string is not coerced
 * into an array.
 *
 * Source-level rather than metadata-level on purpose: the failure is the
 * *absence* of a decorator, and an absent decorator leaves no metadata to
 * inspect. Reading the files is what lets this fail for a field nobody
 * remembered to think about.
 */
describe('DTO object arrays declare their element type', () => {
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

  /** Property declarations whose type is an array of something non-primitive. */
  const objectArrayFields = (source: string) => {
    const offenders: string[] = [];
    // Each decorated property, from its first decorator to its declaration.
    const blocks = source.split(/\n\s*\n/);

    for (const block of blocks) {
      const declaration = block.match(
        // `foo: Bar[]` and `foo: Array<Bar>`, optional and definite forms.
        /^\s*(\w+)[?!]?:\s*(?:([A-Za-z_][\w.]*)\[\]|Array<\s*([A-Za-z_][\w.]*)\s*>)\s*;/m,
      );
      if (!declaration) continue;

      const [, field, bracketType, genericType] = declaration;
      const elementType = bracketType ?? genericType;
      // Primitives are never coerced into arrays, so they need no @Type.
      if (/^(string|number|boolean|Date|any|unknown)$/.test(elementType)) continue;
      if (/@Type\(/.test(block)) continue;

      offenders.push(`${field}: ${elementType}[]`);
    }
    return offenders;
  };

  it('every object array in every DTO has @Type', () => {
    const offenders: string[] = [];

    for (const file of dtoFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const field of objectArrayFields(source)) {
        offenders.push(`${path.relative(__dirname, file)} → ${field}`);
      }
    }

    // Each of these would arrive as [[]] on a real request.
    expect(offenders).toEqual([]);
  });

  it('actually looks at the DTOs, so a pass means something', () => {
    // Guards the guard: a walk that found nothing would pass the test above
    // for the wrong reason.
    expect(dtoFiles().length).toBeGreaterThan(5);
  });

  it('flags an array of objects with no @Type', () => {
    const offenders = objectArrayFields(`
      @IsArray()
      steps: JourneyStep[];
    `);
    expect(offenders).toEqual(['steps: JourneyStep[]']);
  });

  it('accepts one that declares its element type', () => {
    expect(
      objectArrayFields(`
        @IsArray()
        @ValidateNested({ each: true })
        @Type(() => JourneyStepDto)
        steps: JourneyStep[];
      `),
    ).toEqual([]);
  });

  it('leaves primitive arrays alone', () => {
    expect(
      objectArrayFields(`
        @IsArray()
        deviceIdentityIds?: string[];
      `),
    ).toEqual([]);
  });
});
