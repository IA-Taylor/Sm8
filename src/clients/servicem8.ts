import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

export interface ServiceM8Client {
  verifyWebhook(signatureHeader: string | undefined, rawBody: string): boolean;
  getJob(jobUuid: string): Promise<{ uuid: string; company_uuid: string; generated_job_id: string }>;
  createTask(args: {
    jobUuid: string;
    description: string;
    assigneeUuid?: string;
  }): Promise<{ taskUuid: string }>;
  closeTask(taskUuid: string): Promise<void>;
  postNote(jobUuid: string, body: string, staffUuid?: string): Promise<{ activityUuid: string }>;
}

const API = 'https://api.servicem8.com/api_1.0';

export function createServiceM8Client(cfg: Config): ServiceM8Client {
  const auth = 'Basic ' + Buffer.from(`${cfg.sm8ApiKey}:x`).toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SM8 ${method} ${path} -> ${res.status}: ${text}`);
    }
    return res;
  }

  return {
    verifyWebhook(signatureHeader, rawBody) {
      if (!signatureHeader) return false;
      const expected = createHmac('sha256', cfg.sm8WebhookSecret).update(rawBody).digest('hex');
      const got = signatureHeader.replace(/^sha256=/, '').trim();
      if (expected.length !== got.length) return false;
      return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
    },

    async getJob(jobUuid) {
      const res = await call('GET', `/job/${jobUuid}.json`);
      return (await res.json()) as { uuid: string; company_uuid: string; generated_job_id: string };
    },

    async createTask({ jobUuid, description, assigneeUuid }) {
      const res = await call('POST', `/task.json`, {
        job_uuid: jobUuid,
        name: description,
        active: 1,
        ...(assigneeUuid ? { staff_uuid: assigneeUuid } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as { uuid?: string };
      const created = res.headers.get('x-record-uuid') ?? json.uuid;
      if (!created) throw new Error('SM8 createTask: no UUID returned');
      return { taskUuid: created };
    },

    async closeTask(taskUuid) {
      await call('PUT', `/task/${taskUuid}.json`, {
        active: 0,
        actual_completion_date: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
    },

    async postNote(jobUuid, body, staffUuid) {
      const res = await call('POST', `/jobactivity.json`, {
        job_uuid: jobUuid,
        activity_type: 'Note',
        activity_description: body,
        ...(staffUuid ? { staff_uuid: staffUuid } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as { uuid?: string };
      const created = res.headers.get('x-record-uuid') ?? json.uuid ?? '';
      return { activityUuid: created };
    },
  };
}
