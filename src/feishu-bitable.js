import { truncate } from "./utils.js";

const DEFAULT_APP_TOKEN = "P1g7bR1bkaBhIDs2QHQcoGbEnLg";

export class FeishuBitableClient {
  constructor({ config }) {
    this.config = config;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.config.feishuAppId && this.config.feishuAppSecret);
  }

  async tenantAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) return this.token;

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishuAppId,
        app_secret: this.config.feishuAppSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu tenant token failed: ${truncate(JSON.stringify(data), 500)}`);
    }

    this.token = data.tenant_access_token;
    this.tokenExpiresAt = now + Number(data.expire || 3600) * 1000;
    return this.token;
  }

  async request(path, { method = "GET", body } = {}) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Feishu bitable API returned non-JSON: ${truncate(text, 500)}`);
    }
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu bitable API failed ${response.status}: ${truncate(JSON.stringify(data), 800)}`);
    }
    return data.data || {};
  }

  async listAll(path, params = {}) {
    const output = [];
    let pageToken = "";

    do {
      const url = new URL(`https://placeholder.local${path}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
      }
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const data = await this.request(`${url.pathname}${url.search}`);
      output.push(...(data.items || []));
      pageToken = data.page_token || "";
      if (!data.has_more) break;
    } while (pageToken);

    return output;
  }

  async snapshot({ appToken = DEFAULT_APP_TOKEN, sampleSize = 5 } = {}) {
    if (!this.enabled) throw new Error("Feishu app credentials are not configured.");

    const encodedAppToken = encodeURIComponent(appToken || DEFAULT_APP_TOKEN);
    const tables = await this.listAll(`/open-apis/bitable/v1/apps/${encodedAppToken}/tables`, {
      page_size: 100
    });

    const snapshot = {
      appToken: appToken || DEFAULT_APP_TOKEN,
      generatedAt: new Date().toISOString(),
      tableCount: tables.length,
      tables: []
    };

    for (const table of tables) {
      const tableId = table.table_id;
      const encodedTableId = encodeURIComponent(tableId);
      const fields = await this.listAll(
        `/open-apis/bitable/v1/apps/${encodedAppToken}/tables/${encodedTableId}/fields`,
        { page_size: 100 }
      );

      let records = [];
      if (sampleSize > 0) {
        records = await this.listAll(
          `/open-apis/bitable/v1/apps/${encodedAppToken}/tables/${encodedTableId}/records`,
          { page_size: Math.min(Number(sampleSize) || 5, 20) }
        );
      }

      snapshot.tables.push({
        tableId,
        name: table.name,
        revision: table.revision,
        fieldCount: fields.length,
        fields: fields.map((field) => ({
          fieldId: field.field_id,
          name: field.field_name,
          type: field.type,
          property: field.property || {}
        })),
        sampleRecords: records.slice(0, Math.min(Number(sampleSize) || 5, 20)).map((record) => ({
          recordId: record.record_id,
          fields: record.fields || {}
        }))
      });
    }

    return snapshot;
  }
}
