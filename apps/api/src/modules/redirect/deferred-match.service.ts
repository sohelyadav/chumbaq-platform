import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, In } from 'typeorm';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { LinksService } from '../links/links.service';
import { DeferredMatchDto } from './dto/deferred-match.dto';

/**
 * How far back either strategy will claim a click.
 *
 * Strategy 1 had no window at all, so the oldest unclaimed click on a link
 * stayed claimable indefinitely. 48h matches what Strategy 2 has always used
 * and is the usual click-to-install interval.
 *
 * ## What binding Strategy 1 to the address costs
 *
 * Android's `cookieRef` comes from `utm_content` in the Play install
 * referrer, which Google Play delivers and which is genuine evidence about
 * that specific install — evidence that survives a network change, where an
 * address does not. A user who clicks on mobile data and then installs over
 * wifi now fails both strategies. That case is lost, deliberately: the server
 * cannot tell a referrer Play delivered from a string a caller typed, because
 * both arrive in this same field.
 *
 * Restoring it needs the field to mean what its name says — an opaque token
 * minted per click at redirect, stored on the click row, set as a cookie and
 * carried in the store URL, and sent back here instead of the short code.
 * Then provenance is verifiable without an address, and a caller naming a
 * short code gets nothing. That is a migration, a redirect change and a
 * release of all four SDKs, so it is its own task rather than part of this
 * fix.
 */
export const DEFERRED_MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class DeferredMatchService {
  private readonly logger = new Logger(DeferredMatchService.name);

  constructor(
    @InjectRepository(ClickEventEntity)
    private readonly clickEventRepository: Repository<ClickEventEntity>,
    private readonly linksService: LinksService,
  ) {}

  /**
   * @param clientIp The address the request arrived from, as derived by
   *   `getClientIp`. Fingerprint matching is skipped without it, because the
   *   alternative — matching on whatever address the caller nominated — is how
   *   one install could claim another's click.
   */
  async matchDeferred(
    dto: DeferredMatchDto,
    expectedProjectId?: string,
    clientIp?: string,
  ): Promise<{
    matched: boolean;
    linkId?: string;
    shortCode?: string;
    params?: Record<string, any>;
  }> {
    // The window both strategies claim within. A click older than this is not
    // the install in front of us, and an unbounded window means the oldest
    // unclaimed click on a link is claimable forever.
    const cutoff = new Date(Date.now() - DEFERRED_MATCH_WINDOW_MS);

    // Strategy 1: short-code match, bound to the requesting address.
    //
    // `cookieRef` is not a cookie reference and never was: there is no
    // per-click token anywhere on `click_events`, so what arrives here is the
    // link's short code — the public string in the URL of every shared link.
    // It therefore proves nothing on its own, and it used to be enough on its
    // own: naming any short code in the project claimed that link's most
    // recent unmatched click, flipped it to `matched`, and returned the
    // link's `deepLinkParams`. With the project API key shipping inside every
    // app binary that was attribution theft between campaigns, inflated
    // conversions on any chosen link, and attribution denial for the real
    // installer — and `deepLinkParams` is not otherwise public, since
    // `getLinkPreview` returns only the OG metadata.
    //
    // So the claimant must also be at the address that produced the click,
    // which is the same binding Strategy 2 has. See the note on
    // DEFERRED_MATCH_WINDOW_MS for what this costs and what would restore it.
    if (dto.cookieRef && clientIp) {
      try {
        const link = await this.linksService.findByShortCode(dto.cookieRef);

        // Scope: link must belong to the API key's project
        if (expectedProjectId && link.projectId !== expectedProjectId) {
          return { matched: false };
        }

        const clickEvent = await this.clickEventRepository.findOne({
          where: {
            linkId: link.id,
            matched: false,
            ipAddress: clientIp,
            clickedAt: MoreThan(cutoff),
          },
          order: { clickedAt: 'DESC' },
        });

        if (clickEvent) {
          clickEvent.matched = true;
          await this.clickEventRepository.save(clickEvent);

          return {
            matched: true,
            linkId: link.id,
            shortCode: link.shortCode,
            params: link.deepLinkParams,
          };
        }
      } catch {
        this.logger.debug(`Cookie ref match failed for: ${dto.cookieRef}`);
      }
    }

    // Strategy 2: Fingerprint-based match. Sending a fingerprint is how a
    // caller opts into this path; the address it is matched against is the
    // request's.
    if (dto.fingerprint && clientIp) {
      let platform: string | undefined;
      if (dto.fingerprint.os) {
        const osLower = dto.fingerprint.os.toLowerCase();
        if (osLower.includes('ios') || osLower.includes('iphone') || osLower.includes('ipad')) {
          platform = 'ios';
        } else if (osLower.includes('android')) {
          platform = 'android';
        }
      }

      const qb = this.clickEventRepository
        .createQueryBuilder('click')
        .where('click.ip_address = :ip', { ip: clientIp })
        .andWhere('click.clicked_at >= :cutoff', { cutoff })
        // `app_store` / `play_store` are never written by the redirect
        // controller — it records the *attempt* (`app_deeplink`) because at
        // redirect time nobody knows yet whether the app was installed, and
        // the interstitial's fallback to the store happens in the browser
        // ~1.5s later. Those two values reach `click_events` only from
        // `seed.ts`, so filtering on them alone meant this strategy could
        // never match a real click — which is why the unverified short-code
        // path above was the only one that worked in production.
        .andWhere('click.redirect_type IN (:...types)', {
          types: ['app_store', 'play_store', 'app_deeplink'],
        })
        .andWhere('click.matched = false');

      if (platform) {
        qb.andWhere('click.platform = :platform', { platform });
      }

      // Scope candidate clicks to links in the API key's project so one
      // project's API key cannot claim attribution for another project.
      if (expectedProjectId) {
        qb.innerJoin('links', 'l', 'l.id = click.link_id')
          .andWhere('l.project_id = :expectedProjectId', { expectedProjectId });
      }

      const clickEvent = await qb
        .orderBy('click.clicked_at', 'DESC')
        .getOne();

      if (clickEvent) {
        clickEvent.matched = true;
        await this.clickEventRepository.save(clickEvent);

        const link = await this.linksService.findOne(clickEvent.linkId);

        return {
          matched: true,
          linkId: link.id,
          shortCode: link.shortCode,
          params: link.deepLinkParams,
        };
      }
    }

    return { matched: false };
  }
}
