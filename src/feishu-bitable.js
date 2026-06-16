import { truncate } from "./utils.js";

const DEFAULT_APP_TOKEN = "P1g7bR1bkaBhIDs2QHQcoGbEnLg";

function option(name, color) {
  return { name, color };
}

function field(field_name, type = 1, property = undefined) {
  return property ? { field_name, type, property } : { field_name, type };
}

const SALES_SCHEMA = [
  {
    name: "客户表",
    primary: field("客户名称", 1),
    fields: [
      field("客户编号", 1),
      field("客户类型", 3, { options: [option("企业客户", 0), option("个人客户", 1), option("渠道客户", 2), option("其他", 3)] }),
      field("客户等级", 3, { options: [option("A重点", 0), option("B潜力", 1), option("C普通", 2), option("D沉睡", 3)] }),
      field("客户来源", 3, { options: [option("平台", 0), option("转介绍", 1), option("广告推广", 2), option("销售开发", 3), option("其他", 4)] }),
      field("所属行业", 1),
      field("所在地区", 1),
      field("负责人", 1),
      field("客户状态", 3, { options: [option("潜在", 0), option("跟进中", 1), option("已成交", 2), option("流失", 3), option("暂停", 4)] }),
      field("首次成交日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("最近跟进日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("最近成交日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("累计销售额", 2, { formatter: "0.00" }),
      field("累计利润", 2, { formatter: "0.00" }),
      field("跟进次数", 2, { formatter: "0" }),
      field("备注", 1)
    ]
  },
  {
    name: "客户联系人表",
    primary: field("联系人姓名", 1),
    fields: [
      field("关联客户", 18, { linkTo: "客户表", multiple: false }),
      field("职位", 1),
      field("手机/微信", 1),
      field("邮箱", 1),
      field("是否主要联系人", 7),
      field("关系状态", 3, { options: [option("正常", 0), option("重点维护", 1), option("已离职", 2), option("停用", 3)] }),
      field("备注", 1)
    ]
  },
  {
    name: "跟进记录表",
    primary: field("跟进主题", 1),
    fields: [
      field("关联客户", 18, { linkTo: "客户表", multiple: false }),
      field("关联联系人", 18, { linkTo: "客户联系人表", multiple: false }),
      field("关联商机", 18, { linkTo: "商机表", multiple: false }),
      field("跟进人", 18, { linkTo: "销售人员表", multiple: false }),
      field("跟进时间", 5, { date_formatter: "yyyy/MM/dd HH:mm" }),
      field("跟进方式", 3, { options: [option("电话", 0), option("微信", 1), option("飞书", 2), option("面访", 3), option("邮件", 4), option("其他", 5)] }),
      field("跟进内容", 1),
      field("下次跟进时间", 5, { date_formatter: "yyyy/MM/dd HH:mm" }),
      field("跟进结果", 3, { options: [option("需继续跟进", 0), option("有明确需求", 1), option("已报价", 2), option("已成交", 3), option("暂不合作", 4)] }),
      field("是否需要提醒", 7)
    ]
  },
  {
    name: "商机表",
    primary: field("商机名称", 1),
    fields: [
      field("关联客户", 18, { linkTo: "客户表", multiple: false }),
      field("商机来源", 3, { options: [option("客户咨询", 0), option("销售开发", 1), option("广告线索", 2), option("转介绍", 3), option("复购", 4), option("其他", 5)] }),
      field("商机阶段", 3, { options: [option("初步接触", 0), option("需求确认", 1), option("报价方案", 2), option("谈判中", 3), option("赢单", 4), option("输单", 5), option("搁置", 6)] }),
      field("商机负责人", 18, { linkTo: "销售人员表", multiple: false }),
      field("预计成交金额", 2, { formatter: "0.00" }),
      field("预计成本", 2, { formatter: "0.00" }),
      field("预计利润", 2, { formatter: "0.00" }),
      field("预计成交日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("成交概率", 2, { formatter: "0%" }),
      field("商机状态", 3, { options: [option("进行中", 0), option("赢单", 1), option("输单", 2), option("搁置", 3)] }),
      field("实际成交订单", 18, { linkTo: "销售订单表", multiple: true }),
      field("创建日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("关闭日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("备注", 1)
    ]
  },
  {
    name: "销售订单表",
    primary: field("订单编号", 1),
    fields: [
      field("订单日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("归属月份", 5, { date_formatter: "yyyy/MM" }),
      field("关联客户", 18, { linkTo: "客户表", multiple: false }),
      field("关联平台", 18, { linkTo: "平台表", multiple: false }),
      field("销售人员", 18, { linkTo: "销售人员表", multiple: false }),
      field("关联商机", 18, { linkTo: "商机表", multiple: false }),
      field("订单状态", 3, { options: [option("待确认", 0), option("已成交", 1), option("已发货", 2), option("已完成", 3), option("已退货", 4), option("已取消", 5)] }),
      field("订单销售额", 2, { formatter: "0.00" }),
      field("订单成本", 2, { formatter: "0.00" }),
      field("平台扣费", 2, { formatter: "0.00" }),
      field("推广费", 2, { formatter: "0.00" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("销售利润", 20, { formula: ["订单销售额", "-", "订单成本", "-", "平台扣费", "-", "推广费", "-", "退货金额"], formatter: "0.00" }),
      field("利润率", 2, { formatter: "0.00%" }),
      field("销售明细", 18, { linkTo: "销售明细表", multiple: true }),
      field("退货记录", 18, { linkTo: "退货表", multiple: true }),
      field("备注", 1)
    ]
  },
  {
    name: "销售明细表",
    primary: field("明细编号", 1),
    fields: [
      field("关联订单", 18, { linkTo: "销售订单表", multiple: false }),
      field("商品/SKU", 1),
      field("数量", 2, { formatter: "0" }),
      field("单价", 2, { formatter: "0.00" }),
      field("销售金额", 20, { formula: ["数量", "*", "单价"], formatter: "0.00" }),
      field("单位成本", 2, { formatter: "0.00" }),
      field("成本金额", 20, { formula: ["数量", "*", "单位成本"], formatter: "0.00" }),
      field("明细利润", 20, { formula: ["销售金额", "-", "成本金额"], formatter: "0.00" }),
      field("备注", 1)
    ]
  },
  {
    name: "退货表",
    primary: field("退货编号", 1),
    fields: [
      field("关联订单", 18, { linkTo: "销售订单表", multiple: false }),
      field("关联客户", 18, { linkTo: "客户表", multiple: false }),
      field("关联平台", 18, { linkTo: "平台表", multiple: false }),
      field("销售人员", 18, { linkTo: "销售人员表", multiple: false }),
      field("退货日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("退货成本", 2, { formatter: "0.00" }),
      field("退货原因", 1),
      field("处理状态", 3, { options: [option("待处理", 0), option("处理中", 1), option("已退款", 2), option("已关闭", 3)] }),
      field("备注", 1)
    ]
  },
  {
    name: "平台表",
    primary: field("平台名称", 1),
    fields: [
      field("平台类型", 3, { options: [option("电商平台", 0), option("线下渠道", 1), option("私域", 2), option("批发", 3), option("其他", 4)] }),
      field("扣费规则", 1),
      field("负责人", 18, { linkTo: "销售人员表", multiple: false }),
      field("状态", 3, { options: [option("启用", 0), option("暂停", 1), option("停用", 2)] }),
      field("备注", 1)
    ]
  },
  {
    name: "平台费用表",
    primary: field("费用名称", 1),
    fields: [
      field("费用日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("归属月份", 5, { date_formatter: "yyyy/MM" }),
      field("关联平台", 18, { linkTo: "平台表", multiple: false }),
      field("费用类型", 3, { options: [option("平台扣费", 0), option("推广费", 1), option("服务费", 2), option("物流费", 3), option("其他", 4)] }),
      field("费用金额", 2, { formatter: "0.00" }),
      field("关联订单", 18, { linkTo: "销售订单表", multiple: false }),
      field("备注", 1)
    ]
  },
  {
    name: "销售人员表",
    primary: field("姓名", 1),
    fields: [
      field("员工编号", 1),
      field("部门/团队", 1),
      field("岗位", 1),
      field("入职日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("离职日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("在职状态", 3, { options: [option("在职", 0), option("离职", 1), option("休假", 2)] }),
      field("直属上级", 1),
      field("目标规则", 1),
      field("提成规则", 1),
      field("备注", 1)
    ]
  },
  {
    name: "销售目标表",
    primary: field("目标名称", 1),
    fields: [
      field("目标月份", 5, { date_formatter: "yyyy/MM" }),
      field("销售人员", 18, { linkTo: "销售人员表", multiple: false }),
      field("关联平台", 18, { linkTo: "平台表", multiple: false }),
      field("销售额目标", 2, { formatter: "0.00" }),
      field("利润目标", 2, { formatter: "0.00" }),
      field("实际销售额", 2, { formatter: "0.00" }),
      field("实际利润", 2, { formatter: "0.00" }),
      field("销售额完成率", 2, { formatter: "0.00%" }),
      field("利润完成率", 2, { formatter: "0.00%" }),
      field("目标差额", 20, { formula: ["实际销售额", "-", "销售额目标"], formatter: "0.00" }),
      field("达成状态", 3, { options: [option("未开始", 0), option("进行中", 1), option("已达成", 2), option("未达成", 3)] }),
      field("备注", 1)
    ]
  },
  {
    name: "工资表",
    primary: field("工资记录", 1),
    fields: [
      field("工资月份", 5, { date_formatter: "yyyy/MM" }),
      field("销售人员", 18, { linkTo: "销售人员表", multiple: false }),
      field("基本工资", 2, { formatter: "0.00" }),
      field("实际销售额", 2, { formatter: "0.00" }),
      field("实际利润", 2, { formatter: "0.00" }),
      field("目标完成率", 2, { formatter: "0.00%" }),
      field("提成金额", 2, { formatter: "0.00" }),
      field("奖金", 2, { formatter: "0.00" }),
      field("扣款", 2, { formatter: "0.00" }),
      field("应发工资", 20, { formula: ["基本工资", "+", "提成金额", "+", "奖金", "-", "扣款"], formatter: "0.00" }),
      field("发放状态", 3, { options: [option("待生成", 0), option("待审核", 1), option("已确认", 2), option("已发放", 3)] }),
      field("备注", 1)
    ]
  },
  {
    name: "经营看板指标表",
    primary: field("指标名称", 1),
    fields: [
      field("指标月份", 5, { date_formatter: "yyyy/MM" }),
      field("关联平台", 18, { linkTo: "平台表", multiple: false }),
      field("销售人员", 18, { linkTo: "销售人员表", multiple: false }),
      field("销售额", 2, { formatter: "0.00" }),
      field("销售利润", 2, { formatter: "0.00" }),
      field("平台扣费", 2, { formatter: "0.00" }),
      field("推广费", 2, { formatter: "0.00" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("订单数", 2, { formatter: "0" }),
      field("目标完成率", 2, { formatter: "0.00%" }),
      field("备注", 1)
    ]
  }
];

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

  async createTable({ name, primary }) {
    const data = await this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(DEFAULT_APP_TOKEN)}/tables`, {
      method: "POST",
      body: {
        table: {
          name,
          default_view_name: "表格视图",
          fields: [this.toApiField(primary)]
        }
      }
    });
    return data;
  }

  toApiField(input, tableMap = {}, fieldMap = {}) {
    const output = { field_name: input.field_name, type: input.type };
    const property = input.property || {};
    if (input.type === 3 || input.type === 4) {
      output.property = { options: property.options || [] };
    } else if (input.type === 2) {
      output.property = { formatter: property.formatter || "0.00" };
    } else if (input.type === 5) {
      output.property = { date_formatter: property.date_formatter || "yyyy/MM/dd" };
    } else if (input.type === 18) {
      const targetTableId = tableMap[property.linkTo];
      if (!targetTableId) throw new Error(`Missing linked table for ${input.field_name}: ${property.linkTo}`);
      output.property = { table_id: targetTableId, multiple: Boolean(property.multiple) };
    } else if (input.type === 20) {
      const expression = this.formulaExpression(input, tableMap, fieldMap);
      output.property = {
        formula_expression: expression,
        formatter: property.formatter || "0.00"
      };
    }
    return output;
  }

  formulaExpression(input, tableMap, fieldMap) {
    const parts = input.property?.formula || [];
    const tableId = tableMap.__current;
    return parts.map((part) => {
      if (["+", "-", "*", "/", "(", ")"].includes(part)) return part;
      const fieldId = fieldMap[part];
      if (!fieldId) throw new Error(`Missing formula field ${part} for ${input.field_name}`);
      return `bitable::$table[${tableId}].$field[${fieldId}]`;
    }).join("");
  }

  async createField(appToken, tableId, fieldInput, tableMap, fieldMap) {
    return this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      {
        method: "POST",
        body: this.toApiField(fieldInput, { ...tableMap, __current: tableId }, fieldMap)
      }
    );
  }

  async applySalesSchema({ appToken = DEFAULT_APP_TOKEN } = {}) {
    if (!this.enabled) throw new Error("Feishu app credentials are not configured.");

    const logs = [];
    const tables = await this.listAll(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
      page_size: 100
    });
    const tableMap = Object.fromEntries(tables.map((item) => [item.name, item.table_id]));

    for (const tableSpec of SALES_SCHEMA) {
      if (tableMap[tableSpec.name]) {
        logs.push({ action: "skip_table", table: tableSpec.name, tableId: tableMap[tableSpec.name] });
        continue;
      }
      const created = await this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
        method: "POST",
        body: {
          table: {
            name: tableSpec.name,
            default_view_name: "表格视图",
            fields: [this.toApiField(tableSpec.primary)]
          }
        }
      });
      const createdTableId = created.table?.table_id || created.table_id;
      if (!createdTableId) throw new Error(`Create table response missing table_id for ${tableSpec.name}: ${truncate(JSON.stringify(created), 500)}`);
      tableMap[tableSpec.name] = createdTableId;
      logs.push({ action: "create_table", table: tableSpec.name, tableId: createdTableId });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const tableSpec of SALES_SCHEMA) {
      const tableId = tableMap[tableSpec.name];
      const currentFields = await this.listAll(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
        { page_size: 100 }
      );
      const fieldMap = Object.fromEntries(currentFields.map((item) => [item.field_name, item.field_id]));

      for (const fieldSpec of tableSpec.fields) {
        if (fieldMap[fieldSpec.field_name]) {
          logs.push({ action: "skip_field", table: tableSpec.name, field: fieldSpec.field_name });
          continue;
        }

        try {
          const created = await this.createField(appToken, tableId, fieldSpec, tableMap, fieldMap);
          const fieldId = created.field?.field_id || created.field_id;
          if (fieldId) fieldMap[fieldSpec.field_name] = fieldId;
          logs.push({ action: "create_field", table: tableSpec.name, field: fieldSpec.field_name, type: fieldSpec.type });
        } catch (error) {
          logs.push({
            action: "field_error",
            table: tableSpec.name,
            field: fieldSpec.field_name,
            type: fieldSpec.type,
            error: error.message
          });
          if (fieldSpec.type === 20) {
            try {
              await this.createField(appToken, tableId, field(fieldSpec.field_name, 2, { formatter: fieldSpec.property?.formatter || "0.00" }), tableMap, fieldMap);
              logs.push({ action: "create_formula_placeholder", table: tableSpec.name, field: fieldSpec.field_name });
            } catch (fallbackError) {
              logs.push({ action: "placeholder_error", table: tableSpec.name, field: fieldSpec.field_name, error: fallbackError.message });
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return { appToken, generatedAt: new Date().toISOString(), logs };
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
