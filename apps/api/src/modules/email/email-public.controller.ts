import { FORM_PAGE_POLICY, STATIC_PAGE_POLICY } from '../../common/security-headers';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common/interfaces';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { EmailSettingsService } from './email-settings.service';
import { EmailUnsubscribeService } from './email-unsubscribe.service';
import { EmailEventsService } from './email-events.service';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { escapeHtml } from './email-rendering';
import { SesProvider } from './providers/ses.provider';
import { logValue } from '../../common/log-value';
import {
  BoundedCache,
  SeenMessages,
  SnsMessage,
  WindowLimiter,
  isSnsCertUrl,
  isSnsHostname,
  snsCertCacheKey,
  snsCertRegion,
  parseBrevoEvent,
  parseResendEvent,
  parseSesEvent,
  verifySnsSignature,
  verifySvix,
} from './email-webhooks';
import { PerProjectLru, webhookCacheKey } from '../webhooks/per-project-lru';

/*
 * SES webhook guarantee. Junk is refused without being counted and a message
 * signed with an already trusted certificate is always checked and accepted,
 * so the only thing a holder of one project's secret URL can use up is that
 * project's certificate fetches, which holds up only its messages whose
 * certificate is not yet trusted (the tenant replaces the URL to end it).
 * Projects share nothing a request can fill: only certificates that verified
 * a genuine SNS signature or that AWS itself said are gone, and a process-wide
 * cap on fetches in flight of which a project holds at most one slot and an
 * account (however many projects it has) at most two. So one account can
 * hold at most 2 of the 64 slots, and filling them takes 32 accounts, which
 * registration throttling bounds.
 */

/**
 * Certificates that verified a genuine SNS signature, shared by every
 * project. Safe to share because only real AWS certificates in current use
 * get in: SNS signs with one per region at a time, so this holds every
 * region with room for a rotation. Bounded all the same.
 */
export const SNS_CERT_CACHE_ENTRIES = 128;
/**
 * How long a certificate is trusted, counted from the fetch that got it and
 * not extended by use, so one AWS has withdrawn is fetched again (and
 * refused) within a day.
 */
export const SNS_CERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A real SNS certificate is under 2 KiB. */
export const SNS_CERT_MAX_BYTES = 16 * 1024;

/** For each request to SNS: the certificate fetch and the subscription confirmation. */
export const SNS_CERT_TIMEOUT_MS = 5_000;

/**
 * Certificate fetches in flight across the process: a safety net, not a
 * share. Each account has at most `SNS_CERT_FETCHES_PER_ACCOUNT` in flight,
 * so filling it takes 32 accounts, which registration throttling bounds.
 */
export const SNS_CERT_MAX_CONCURRENT_FETCHES = 64;

/**
 * Certificate fetches in flight per account (the projects' owner), across
 * all its projects. A project already holds at most one, but an account can
 * have several projects, so without this one account with enough of them
 * could hold every slot of the process cap and make other tenants' SNS
 * deliveries wait. Two, so one stuck fetch still leaves the account a slot.
 */
export const SNS_CERT_FETCHES_PER_ACCOUNT = 2;

/**
 * Fetches of certificates not in the cache, per project per minute. Real
 * senders need one per region per day. This is the only cap junk can reach:
 * a forged signature against a certificate nobody trusts is refused, the
 * certificate is not kept, and trying it again costs another fetch.
 */
export const SNS_CERT_FETCHES_PER_MINUTE = 20;

/**
 * How long a certificate AWS answered 403 or 404 for is refused without
 * asking again, for the project that asked. Short, and only for those
 * answers: a timeout, 5xx or 429 says nothing about the certificate, so it is
 * never remembered and SNS's retry asks AWS again.
 */
export const SNS_CERT_MISSING_TTL_MS = 10_000;
/** Missing certificates remembered per project; its own oldest go first. */
export const SNS_CERT_MISSING_PER_PROJECT = 8;
/**
 * Projects whose missing certificates are remembered, least recently active
 * going first, so at most 4,000 entries in all. A project pushed out only
 * asks AWS again, on its own allowance.
 */
export const SNS_CERT_MISSING_MAX_PROJECTS = 500;

/**
 * Projects whose fetch allowance and verified-request count are kept. When
 * full, the window that started first is forgotten, which hands that project
 * a fresh allowance early and refuses nobody.
 */
export const SES_WEBHOOK_LIMITER_PROJECTS = 10_000;

/**
 * Verified requests per minute one project's SES webhook may take. SES
 * publishes a campaign's events at about its sending rate, so this sits well
 * above a typical account's (tens to a few hundred messages a second at
 * most, with opens and clicks spread out after). SNS retries what is refused,
 * but under its default HTTP policy only three times in about a minute, so a
 * limit real traffic reaches loses events. Only verified messages that are
 * not replays count, so junk cannot spend it.
 */
export const SES_WEBHOOK_LIMIT_PER_MINUTE = 6_000;

/*
 * SES dedupe guarantee. A copy of a message is answered 200 only after a copy
 * of it was processed successfully, so SNS never stops retrying an event that
 * was not recorded. The ids live in one store bounded in total, and a project
 * pushes out its own ids before anyone else's, so the most another project
 * can cost it is a duplicate processed again, which the database ignores.
 */

/**
 * Message ids remembered across the process, for the hour a message is
 * accepted at all (`SNS_MAX_AGE_MS`), so a captured genuine message posted
 * again is answered 200 without being processed or counted. Bounded in
 * total because the number of accounts, and so of projects, has no limit.
 */
export const SES_WEBHOOK_SEEN_MESSAGES = 100_000;
/**
 * One project's share of `SES_WEBHOOK_SEEN_MESSAGES`. A project at its share
 * forgets its own oldest ids first; replaying those spends only that
 * project's own allowance.
 */
export const SES_WEBHOOK_SEEN_MESSAGES_PER_PROJECT = 10_000;
/**
 * How long a copy of a message waits on a first copy still in flight before
 * running it itself. Longer than every step with a time limit put together
 * (the STS lookup and the subscription confirmation, 5 s each), so it only
 * cuts short a first copy stuck on something with none, such as a database
 * that stopped answering. Running twice is safe: ingest is idempotent.
 */
export const SES_WEBHOOK_IN_FLIGHT_MS = 30_000;

/*
 * SES webhook memory guarantee. Everything the webhook keeps in memory has a
 * cap on its total, whatever the number of projects, and is kept per project
 * wherever a request can add to it, so a project fills only its own share.
 * When a cap is reached, what one project pushes out of another's costs that
 * project at most one more request to AWS or one more processing of a
 * duplicate, never a refused genuine message.
 *
 * The stores: trusted certificates (128, verified ones only), fetches and
 * URLs in flight (64 each), missing certificates (`PerProjectLru`, 500
 * projects of 8), the two per-project limiters (10,000 windows each, a full
 * one refuses nobody), seen message ids (100,000, 10,000 a project) and STS
 * account ids (`SES_ACCOUNT_ID_CACHE_ENTRIES` in ses.provider.ts, 10,000).
 */

const tooMany = (message: string) => new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);

/** AWS answered 403 or 404: the certificate does not exist. */
export class CertificateMissingException extends UnauthorizedException {}

const SNS_TYPES = new Set(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']);

/**
 * How old a signed SNS message may be. SNS delivers within seconds and its
 * default HTTP retries give up within minutes, so anything older is a
 * replay of a captured message rather than a late delivery.
 */
const SNS_MAX_AGE_MS = 60 * 60 * 1000;

const TOPIC_ARN = /^arn:aws(?:-[a-z]+)*:sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_.-]+$/;

/** The account id in `arn:aws:sns:<region>:<account>:<topic>`, or null. */
export function topicAccount(topicArn: string | undefined): string | null {
  return TOPIC_ARN.exec(topicArn ?? '')?.[2] ?? null;
}

/** The region in a topic ARN, or null. */
export function topicRegion(topicArn: string | undefined): string | null {
  return TOPIC_ARN.exec(topicArn ?? '')?.[1] ?? null;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111827;line-height:1.5}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#111827;color:#fff;cursor:pointer}
.muted{color:#6b7280;font-size:.9rem}</style></head><body>${body}</body></html>`;
}

/**
 * Endpoints the outside world calls without a dashboard session: the
 * unsubscribe link in every email, and the providers' delivery webhooks.
 * Each authenticates itself — a signed link, a secret URL plus the
 * provider's signature — instead of a JWT.
 */
@Controller('email')
export class EmailPublicController {
  private readonly logger = new Logger(EmailPublicController.name);
  // Per controller, which Nest makes once per process. See the guarantee
  // above: everything keyed by a settings id is that project's alone.
  private readonly certificates = new BoundedCache<string>(
    SNS_CERT_CACHE_ENTRIES,
    SNS_CERT_CACHE_TTL_MS,
  );
  private fetchesInFlight = 0;
  /**
   * Fetches in flight per account. An entry lives only while its account has
   * one, so this holds at most `SNS_CERT_MAX_CONCURRENT_FETCHES` entries.
   */
  private readonly accountFetches = new Map<string, number>();
  /** The one certificate fetch each project may have in flight. */
  private readonly certificateFetches = new Map<
    string,
    { key: string; fetch: Promise<FetchedCertificate> }
  >();
  /**
   * Shared, per certificate URL with a fetch in flight: when AWS last said
   * it is gone. A fetch that started at or before then cannot put the
   * certificate back in the cache, whichever answer arrived first. Kept only
   * while a fetch of that URL is in flight, so it holds at most
   * `SNS_CERT_MAX_CONCURRENT_FETCHES` entries and nothing evicts one early.
   */
  private readonly urlsInFlight = new Map<string, { fetches: number; missingAt: number | null }>();
  /**
   * Per project: certificates AWS said do not exist, keyed by a digest of
   * the URL. Capped in total, since the number of accounts, and so of
   * projects, has no limit.
   */
  private readonly missingCertificates = new PerProjectLru<{
    error: HttpException;
    expiresAt: number;
  }>(SNS_CERT_MISSING_MAX_PROJECTS, SNS_CERT_MISSING_PER_PROJECT);
  private readonly certificateBudget = new WindowLimiter(
    SNS_CERT_FETCHES_PER_MINUTE,
    60_000,
    SES_WEBHOOK_LIMITER_PROJECTS,
  );
  private readonly sesLimiter = new WindowLimiter(
    SES_WEBHOOK_LIMIT_PER_MINUTE,
    60_000,
    SES_WEBHOOK_LIMITER_PROJECTS,
  );
  private readonly seenMessages = new SeenMessages<{ recorded: number }>(
    SES_WEBHOOK_SEEN_MESSAGES,
    SES_WEBHOOK_SEEN_MESSAGES_PER_PROJECT,
    SNS_MAX_AGE_MS,
    SES_WEBHOOK_IN_FLIGHT_MS,
  );

  constructor(
    private readonly settings: EmailSettingsService,
    private readonly unsubscribe: EmailUnsubscribeService,
    private readonly suppressions: SuppressionsService,
    private readonly events: EmailEventsService,
    private readonly ses: SesProvider,
  ) {}

  /**
   * Shows a confirmation, and does not unsubscribe.
   *
   * Mail scanners and link previewers fetch every URL in a message. If a GET
   * unsubscribed, people would be unsubscribed by their own security
   * software; the change happens on the POST the button makes, or on the
   * RFC 8058 one-click POST that mail clients send.
   */
  @Get('unsubscribe')
  showUnsubscribe(
    @Query('p') projectId: string,
    @Query('e') encoded: string,
    @Query('s') signature: string,
    @Res() res: Response,
  ): void {
    const address = this.unsubscribe.verify(projectId, encoded, signature);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', FORM_PAGE_POLICY);
    if (!address) {
      res
        .status(400)
        .type('html')
        .send(page('Link not valid', '<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>'));
      return;
    }

    const action = `?${new URLSearchParams({ p: projectId, e: encoded, s: signature })}`;
    res.type('html').send(
      page(
        'Unsubscribe',
        `<h1>Unsubscribe?</h1><p>Stop marketing email to <strong>${escapeHtml(address)}</strong>.</p>
<form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  }

  @Post('unsubscribe')
  @HttpCode(200)
  async doUnsubscribe(
    @Query('p') projectId: string,
    @Query('e') encoded: string,
    @Query('s') signature: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const address = this.unsubscribe.verify(projectId, encoded, signature);
    if (!address) {
      res.status(400).type('text').send('This unsubscribe link is not valid.');
      return;
    }

    await this.suppressions.suppress(
      projectId,
      'email',
      [{ address, reason: 'unsubscribed' }],
      'link',
    );
    this.logger.log(`Unsubscribed an address from project ${projectId}`);

    // A mail client's one-click POST wants a status, not a page.
    const oneClick =
      (req.body as Record<string, unknown> | undefined)?.['List-Unsubscribe'] === 'One-Click';
    if (oneClick) {
      res.type('text').send('Unsubscribed.');
      return;
    }
    res.setHeader('Content-Security-Policy', STATIC_PAGE_POLICY);
    res.type('html').send(
      page(
        'Unsubscribed',
        `<h1>You're unsubscribed</h1><p><strong>${escapeHtml(address)}</strong> will not receive marketing email from this sender again.</p>
<p class="muted">Changed your mind? Contact the sender to be added back.</p>`,
      ),
    );
  }

  // Not throttled: SES publishes a campaign's events in bursts from a handful
  // of AWS addresses, far past the per-IP limit meant for SDK traffic, and a
  // throttled event is a lost bounce. Each request is authenticated by a
  // secret URL and a signature instead.
  @SkipThrottle()
  @Post('webhooks/resend/:token')
  @HttpCode(200)
  async resendWebhook(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ recorded: number }> {
    const settings = await this.settings.findByWebhookToken(token);
    if (!settings) throw new NotFoundException();

    const credentials = await this.settings.credentialsFor(settings.projectId, 'resend');
    const secret = credentials?.webhookSecret;
    // Without a signing secret there is no way to tell a real bounce from a
    // forged one, and a forged bounce suppresses a real customer. Refused
    // rather than trusted.
    if (typeof secret !== 'string') {
      throw new BadRequestException(
        'Add the Resend webhook signing secret in Email settings to receive events.',
      );
    }

    const raw = req.rawBody?.toString('utf8') ?? '';
    const valid = verifySvix(
      secret,
      {
        id: req.header('svix-id'),
        timestamp: req.header('svix-timestamp'),
        signature: req.header('svix-signature'),
      },
      raw,
    );
    if (!valid) throw new UnauthorizedException('Signature did not verify.');

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Body is not JSON.');
    }

    const recorded = await this.events.ingest(
      settings.projectId,
      'resend',
      parseResendEvent(payload),
    );
    return { recorded };
  }

  /**
   * Brevo does not sign its webhooks, so the secret token in this URL is the
   * whole of the authentication. Events are therefore ingested unsigned:
   * each one is checked against the project's own people before it can
   * suppress an address or count toward a campaign.
   */
  @SkipThrottle()
  @Post('webhooks/brevo/:token')
  @HttpCode(200)
  async brevoWebhook(
    @Param('token') token: string,
    @Req() req: Request,
  ): Promise<{ recorded: number }> {
    const settings = await this.settings.findByWebhookToken(token);
    if (!settings) throw new NotFoundException();

    const recorded = await this.events.ingest(
      settings.projectId,
      'brevo',
      parseBrevoEvent(req.body),
      { signed: false },
    );
    return { recorded };
  }

  @SkipThrottle()
  @Post('webhooks/ses/:token')
  @HttpCode(200)
  async sesWebhook(
    @Param('token') token: string,
    @Req() req: Request,
  ): Promise<{ recorded: number }> {
    // State is kept only after the lookup, so made-up tokens leave nothing
    // in memory.
    const settings = await this.settings.findByWebhookToken(token);
    if (!settings) throw new NotFoundException();

    // Junk is refused here without being counted anywhere, so no amount of
    // it can refuse a genuine message.
    const message = sesMessageFrom(settings, req.body);

    // A trusted certificate is used straight away, ahead of every limit: an
    // RSA check is cheap, and a genuine message must never wait on junk.
    const certificate = await this.certificate(
      settings.id,
      // Loaded with the settings row in the same query. The owner (the billing account)
      // changes only by an accepted billing transfer, which moves the project's
      // fetches to the new account from then on.
      settings.project.ownerId,
      message.SigningCertURL,
    );
    if (!verifySnsSignature(message, certificate.pem)) {
      throw new UnauthorizedException('Signature did not verify.');
    }
    // `withdrawn` is read here, with nothing awaited between the read and
    // the write, so a 404 is either seen now or arrives later and deletes it.
    if (certificate.fetchedAt !== null && !certificate.withdrawn) {
      // Trusted by every project from now on: it has just verified a real
      // SNS signature. Aged from its fetch, so use never extends it.
      this.certificates.set(
        certificate.key,
        certificate.pem,
        certificate.fetchedAt + SNS_CERT_CACHE_TTL_MS,
      );
    }

    // Only after the signature, so junk carrying a real id cannot answer
    // for it. A copy arriving while the first is in flight waits and shares
    // its outcome, so a retry is never acknowledged before the work is done,
    // and a failure is not remembered as done, so SNS's next try goes through.
    return this.seenMessages.run(
      settings.id,
      message.MessageId,
      () => this.receiveSes(settings, message),
      { recorded: 0 },
    );
  }

  /** A message whose signature has verified, from the project's own topic. */
  private async receiveSes(
    settings: { id: string; projectId: string; sesTopicArn: string | null },
    message: SnsMessage,
  ): Promise<{ recorded: number }> {
    if (!this.sesLimiter.take(settings.id)) {
      throw tooMany('Too many requests for this webhook. SNS will retry.');
    }

    // A valid signature proves the message came from *an* SNS topic, not
    // from this customer's. The topic must belong to the AWS account behind
    // the SES credentials the customer connected; otherwise anyone who
    // learned this URL could subscribe a topic in their own account first
    // and post signed bounces that suppress real people.
    const credentials = await this.settings.credentialsFor(settings.projectId, 'ses');
    if (!credentials) {
      throw new ForbiddenException('Connect Amazon SES in Email settings to receive its events.');
    }
    let account: string;
    try {
      account = await this.ses.accountId(credentials);
    } catch (error) {
      this.logger.warn(
        // The error can repeat the region the tenant typed.
        `Could not confirm the SES account for project ${settings.projectId}: ${logValue((error as Error).message)}`,
      );
      // 503 so SNS retries rather than the event being lost.
      throw new ServiceUnavailableException('Could not confirm the SES account with AWS.');
    }
    if (topicAccount(message.TopicArn) !== account) {
      throw new ForbiddenException(
        'This topic belongs to a different AWS account than the connected SES credentials.',
      );
    }

    if (message.Type === 'SubscriptionConfirmation') {
      const subscribe = message.SubscribeURL ?? '';
      // Only ever request SNS itself; the URL arrives in the request.
      if (!isSnsHost(subscribe)) {
        throw new BadRequestException('Subscribe URL is not an SNS endpoint.');
      }
      let response: globalThis.Response;
      try {
        response = await fetch(subscribe, {
          signal: AbortSignal.timeout(SNS_CERT_TIMEOUT_MS),
          redirect: 'error',
        });
      } catch {
        // 503 so SNS sends the confirmation again.
        throw new ServiceUnavailableException('Could not reach SNS to confirm the subscription.');
      }
      if (!response.ok) {
        throw new BadRequestException(`SNS refused the confirmation (${response.status}).`);
      }
      await this.settings.pinSesTopic(settings.id, message.TopicArn);
      this.logger.log(`Confirmed SES events topic ${message.TopicArn} for project ${settings.projectId}`);
      return { recorded: 0 };
    }

    if (message.Type !== 'Notification') return { recorded: 0 };

    const recorded = await this.events.ingest(
      settings.projectId,
      'ses',
      parseSesEvent(message.Message),
    );
    return { recorded };
  }

  /**
   * The certificate for `url`: trusted from the shared cache, or fetched on
   * this project's own allowance, within its account's share of the slots.
   */
  private async certificate(
    project: string,
    account: string,
    url: string,
  ): Promise<FetchedCertificate> {
    const key = snsCertCacheKey(url);
    const trusted = this.certificates.get(key);
    if (trusted) return { key, pem: trusted, fetchedAt: null, withdrawn: false };

    const missing = this.missingCertificates.get(project, webhookCacheKey(key));
    if (missing && missing.expiresAt > Date.now()) throw missing.error;

    const pending = this.certificateFetches.get(project);
    if (pending?.key === key) return pending.fetch;
    if (pending) {
      throw tooMany('A certificate is already being fetched for this webhook. SNS will retry.');
    }
    const forAccount = this.accountFetches.get(account) ?? 0;
    if (forAccount >= SNS_CERT_FETCHES_PER_ACCOUNT) {
      throw tooMany('Too many certificates are being fetched for this account. SNS will retry.');
    }
    if (this.fetchesInFlight >= SNS_CERT_MAX_CONCURRENT_FETCHES) {
      throw new ServiceUnavailableException(
        'Too many SNS certificates are being fetched. SNS will retry.',
      );
    }
    if (!this.certificateBudget.take(project)) {
      throw tooMany('Too many certificate fetches for this webhook. SNS will retry.');
    }

    this.fetchesInFlight++;
    this.accountFetches.set(account, forAccount + 1);
    let shared = this.urlsInFlight.get(key);
    if (!shared) {
      shared = { fetches: 0, missingAt: null };
      this.urlsInFlight.set(key, shared);
    }
    shared.fetches++;
    const record = shared;
    const fetchedAt = Date.now();
    const fetch = this.fetchCertificate(key)
      .then(
        // Read when the caller writes the cache, not now: another fetch's
        // 404 can land in the microtasks between this 200 and that write.
        // The record outlives its map entry, so the read still sees it.
        (pem): FetchedCertificate => ({
          key,
          pem,
          fetchedAt,
          get withdrawn() {
            return record.missingAt !== null && record.missingAt >= fetchedAt;
          },
        }),
        (error: unknown) => {
          if (error instanceof CertificateMissingException) {
            // AWS says it does not exist: stop trusting it at once, for
            // everyone, keep any fetch already under way from trusting it
            // again, and spare this project asking again for a while.
            this.certificates.delete(key);
            record.missingAt = Date.now();
            this.missingCertificates.set(project, webhookCacheKey(key), {
              error,
              expiresAt: Date.now() + SNS_CERT_MISSING_TTL_MS,
            });
          }
          throw error;
        },
      )
      .finally(() => {
        this.fetchesInFlight--;
        const left = (this.accountFetches.get(account) ?? 1) - 1;
        if (left > 0) this.accountFetches.set(account, left);
        else this.accountFetches.delete(account);
        this.certificateFetches.delete(project);
        if (--record.fetches === 0) this.urlsInFlight.delete(key);
      });
    this.certificateFetches.set(project, { key, fetch });
    return fetch;
  }

  /** One request for a certificate; the caller decides what to remember. */
  private async fetchCertificate(key: string): Promise<string> {
    let response: globalThis.Response;
    try {
      response = await fetch(key, {
        signal: AbortSignal.timeout(SNS_CERT_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      // 503 so SNS retries a genuine message rather than it being lost.
      throw new ServiceUnavailableException('Could not fetch the SNS certificate.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 403 || response.status === 404) {
        throw new CertificateMissingException(
          `SNS has no such certificate (${response.status}).`,
        );
      }
      // AWS busy or failing says nothing about the certificate.
      if (response.status === 429 || response.status >= 500) {
        throw new ServiceUnavailableException(
          `Could not fetch the SNS certificate (${response.status}). SNS will retry.`,
        );
      }
      throw new UnauthorizedException(`Could not fetch the SNS certificate (${response.status}).`);
    }
    const pem = await readCapped(response, SNS_CERT_MAX_BYTES);
    if (pem === null) {
      throw new UnauthorizedException('SNS certificate is too large.');
    }
    return pem;
  }
}

interface FetchedCertificate {
  key: string;
  pem: string;
  /** When it was fetched; null when it came from the trusted cache. */
  fetchedAt: number | null;
  /**
   * AWS said it was gone at or after this fetch began: never cache it. A
   * getter, read at the moment of the cache write.
   */
  readonly withdrawn: boolean;
}

/**
 * The message, once everything that can be refused without the certificate
 * has been: a malformed, stale or foreign message never makes this server
 * fetch, and none of these refusals is counted against anything.
 */
function sesMessageFrom(settings: { sesTopicArn: string | null }, body: unknown): SnsMessage {
  let message: SnsMessage;
  try {
    message = (typeof body === 'string' ? JSON.parse(body) : body) as SnsMessage;
  } catch {
    throw new BadRequestException('Body is not an SNS message.');
  }

  if (!message?.SigningCertURL || !isSnsCertUrl(message.SigningCertURL)) {
    throw new UnauthorizedException('Certificate is not from SNS.');
  }
  if (!looksLikeSnsMessage(message)) {
    throw new UnauthorizedException('Body is not a signed SNS message.');
  }
  const sentAt = Date.parse(message.Timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > SNS_MAX_AGE_MS) {
    throw new UnauthorizedException('Message is too old to accept.');
  }
  // Only the project's own topic, and before it has one only the
  // confirmation that pins it, so fetches stay within one real topic.
  if (!settings.sesTopicArn) {
    if (message.Type !== 'SubscriptionConfirmation') {
      throw new ForbiddenException(
        'No SNS topic is confirmed for this webhook yet. Subscribe the topic to this URL again so SNS sends a confirmation.',
      );
    }
  } else if (settings.sesTopicArn !== message.TopicArn) {
    throw new ForbiddenException(
      'Events from this topic are not accepted. Reset the SES topic in Email settings to switch topics.',
    );
  }
  // SNS signs with its own region's certificate, so any other region is
  // made up, and would be a fetch from somewhere the topic never sends.
  if (snsCertRegion(message.SigningCertURL) !== topicRegion(message.TopicArn)) {
    throw new UnauthorizedException("Certificate is not from the topic's region.");
  }
  return message;
}

/**
 * The fields the signature covers, of the types SNS sends. Checked before the
 * certificate is fetched.
 */
function looksLikeSnsMessage(message: SnsMessage): boolean {
  const field = (value: unknown) => typeof value === 'string' && value.length > 0;
  return (
    SNS_TYPES.has(message.Type) &&
    (message.SignatureVersion === '1' || message.SignatureVersion === '2') &&
    field(message.Signature) &&
    field(message.MessageId) &&
    typeof message.Message === 'string' &&
    typeof message.Timestamp === 'string' &&
    topicAccount(message.TopicArn) !== null
  );
}

/**
 * The body as text, or null once it passes `maxBytes`. Reads the stream
 * rather than `text()` so an endless body is abandoned at the cap.
 */
async function readCapped(response: globalThis.Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // A body that broke off part-way is as untrustworthy as a missing one.
    throw new ServiceUnavailableException('Could not fetch the SNS certificate.');
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The SubscribeURL carries a query, so only its host is pinned. */
function isSnsHost(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      isSnsHostname(url.hostname)
    );
  } catch {
    return false;
  }
}
