/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@chumbaq/shared$': '<rootDir>/../../../packages/shared/src',
    '^@chumbaq/shared/(.*)$': '<rootDir>/../../../packages/shared/src/$1',
  },
  // These tests share one database; running files in parallel would let
  // truncation in one file delete another file's fixtures mid-assertion.
  maxWorkers: 1,
  setupFiles: ['<rootDir>/test-support/int-env.ts'],
  testTimeout: 30000,
};
