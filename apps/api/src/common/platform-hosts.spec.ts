import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { hostOf, isPlatformHost, PLATFORM_HOST_MESSAGE } from './platform-hosts';
import { CreateProjectDto } from '../modules/projects/dto/create-project.dto';
import { UpdateProjectDto } from '../modules/projects/dto/update-project.dto';

const env = {
  APP_URL: 'https://app.example.test',
  API_BASE_URL: 'https://api.example.test',
  SHORT_LINK_DOMAIN: 'go.example.test',
  ADMIN_APP_URL: 'https://admin.example.test',
};

describe('platform hosts', () => {
  it.each([
    ['App.Example.Test.', 'app.example.test'],
    ['https://app.example.test/some/path', 'app.example.test'],
    ['app.example.test:8443', 'app.example.test'],
    ['  acme.com ', 'acme.com'],
  ])('reads %p as host %p', (value, host) => {
    expect(hostOf(value)).toBe(host);
  });

  it.each(['app.example.test', 'API.example.test', 'go.example.test', 'https://admin.example.test/'])(
    'treats %s as the platform\'s own',
    (value) => {
      expect(isPlatformHost(value, env)).toBe(true);
    },
  );

  it.each(['acme.com', 'links.acme.com', 'example.test', 'xapp.example.test', ''])('leaves %p to tenants', (value) => {
    expect(isPlatformHost(value, env)).toBe(false);
  });
});

describe('a project domain', () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, env));
  afterEach(() => {
    process.env = { ...saved };
  });

  const errorsFor = async (cls: typeof CreateProjectDto | typeof UpdateProjectDto, body: object) =>
    (await validate(plainToInstance(cls, body))).flatMap((e) => Object.values(e.constraints ?? {}));

  it.each(['app.example.test', 'https://APP.example.test/', 'go.example.test'])(
    'is refused on create and update when it is the platform host %s',
    async (domain) => {
      expect(await errorsFor(CreateProjectDto, { name: 'b', domain })).toContain(PLATFORM_HOST_MESSAGE);
      expect(await errorsFor(UpdateProjectDto, { domain })).toContain(PLATFORM_HOST_MESSAGE);
    },
  );

  it('is accepted when it is the tenant\'s own', async () => {
    expect(await errorsFor(CreateProjectDto, { name: 'b', domain: 'acme.com' })).toEqual([]);
    expect(await errorsFor(UpdateProjectDto, { domain: 'links.acme.com' })).toEqual([]);
  });
});
