import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { MixpanelConfigEntity } from './entities/mixpanel-config.entity';

export interface MixpanelCohortInfo {
  id: number;
  name: string;
  count: number;
  description?: string;
  created: string;
}

export interface MixpanelProfile {
  $distinct_id: string;
  $properties: {
    $email?: string;
    $name?: string;
    $phone?: string;
    $distinct_ids?: string[];
    [key: string]: any;
  };
}

@Injectable()
export class MixpanelApiService {
  private readonly logger = new Logger(MixpanelApiService.name);
  private readonly baseUrl = 'https://mixpanel.com/api/2.0';

  private parseCohortCount(rawCohort: any): number {
    const rawCount =
      rawCohort?.count ??
      rawCohort?.num_users ??
      rawCohort?.user_count ??
      rawCohort?.users_count ??
      rawCohort?.size ??
      rawCohort?.total;

    const parsed = Number.parseInt(String(rawCount ?? 0), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Test credentials by attempting to list cohorts.
   */
  async testConnection(
    username: string,
    password: string,
    mixpanelProjectId: string,
  ): Promise<boolean> {
    try {
      const client = this.buildClient(username, password);
      await client.get('/cohorts/list', {
        params: { project_id: mixpanelProjectId },
      });
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Mixpanel connection test failed: ${msg}`);
      return false;
    }
  }

  /**
   * Fetch all cohorts for a project from Mixpanel.
   */
  async listCohorts(
    config: { username: string; password: string; mixpanelProjectId: string },
  ): Promise<MixpanelCohortInfo[]> {
    const client = this.buildClient(config.username, config.password);
    const response = await client.get('/cohorts/list', {
      params: { project_id: config.mixpanelProjectId },
    });

    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected Mixpanel response: ${JSON.stringify(data)}`);
    }

    return data.map((c: any) => ({
      id: c.id,
      name: c.name,
      count: this.parseCohortCount(c),
      description: c.description ?? null,
      created: c.created,
    }));
  }

  /**
   * Fetch all members of a cohort, handling pagination automatically.
   * Mixpanel returns up to 1000 per page; we loop until done.
   */
  async getCohortMembers(
    config: { username: string; password: string; mixpanelProjectId: string },
    cohortId: number,
  ): Promise<MixpanelProfile[]> {
    const client = this.buildClient(config.username, config.password);
    const allResults: MixpanelProfile[] = [];
    let page = 0;
    let sessionId: string | null = null;

    while (true) {
      const params = new URLSearchParams();
      params.append('filter_by_cohort', JSON.stringify({ id: cohortId }));
      params.append(
        'output_properties',
        JSON.stringify(['$distinct_id', '$email', '$name', '$phone', '$distinct_ids']),
      );
      params.append('project_id', config.mixpanelProjectId);
      params.append('page', String(page));
      if (sessionId) {
        params.append('session_id', sessionId);
      }

      const response = await client.post('/engage', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const body = response.data;

      if (body.status !== 'ok') {
        throw new Error(`Mixpanel engage API error: ${body.error ?? JSON.stringify(body)}`);
      }

      const results: MixpanelProfile[] = body.results ?? [];
      allResults.push(...results);

      if (!sessionId) {
        sessionId = body.session_id;
      }

      const total: number = body.total ?? results.length;
      this.logger.debug(
        `Fetched page ${page} for cohort ${cohortId}: ${results.length} records (${allResults.length}/${total} total)`,
      );

      if (allResults.length >= total || results.length === 0) {
        break;
      }

      page++;
    }

    return allResults;
  }

  private buildClient(username: string, password: string): AxiosInstance {
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    return axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Basic ${token}`,
        Accept: 'application/json',
      },
      timeout: 30_000,
    });
  }
}
