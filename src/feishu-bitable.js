import { truncate } from "./utils.js";

const DEFAULT_APP_TOKEN = "P1g7bR1bkaBhIDs2QHQcoGbEnLg";

function option(name, color) {
  return { name, color };
}

function field(field_name, type = 1, property = undefined) {
  return property ? { field_name, type, property } : { field_name, type };
}

function textCell(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => textCell(item, "")).filter(Boolean).join("、");
    return text || fallback;
  }
  if (typeof value === "object") {
    return textCell(value.text ?? value.name ?? value.value ?? value.display_value ?? value.link ?? "", fallback);
  }
  return fallback;
}

function numberCell(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (Array.isArray(value)) return numberCell(value[0], fallback);
  if (typeof value === "object") return numberCell(value.value ?? value.text ?? value.name, fallback);
  const numeric = Number(String(value).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function firstExisting(fields, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  return undefined;
}

function parseMonthKey(value) {
  const rawText = textCell(value, "");
  const match = rawText.match(/(20\d{2})[年./-]?\s*(\d{1,2})/);
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`;

  const rawNumber = numberCell(value, NaN);
  if (Number.isFinite(rawNumber) && rawNumber > 1000000000) {
    const date = new Date(rawNumber);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit"
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    if (year && month) return `${year}-${month}`;
  }

  const parsed = rawText ? new Date(rawText) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    if (year > 1900) return `${year}-${month}`;
  }
  return "";
}

function monthParts(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map((part) => Number(part));
  return {
    year: Number.isFinite(year) ? year : 0,
    month: Number.isFinite(month) ? month : 0
  };
}

function addAmount(target, values) {
  target.sales += values.sales || 0;
  target.profit += values.profit || 0;
  target.platformFee += values.platformFee || 0;
  target.promotionFee += values.promotionFee || 0;
  target.returnAmount += values.returnAmount || 0;
  target.orderCount += values.orderCount || 0;
}

function blankSummary() {
  return {
    sales: 0,
    profit: 0,
    platformFee: 0,
    promotionFee: 0,
    returnAmount: 0,
    orderCount: 0
  };
}

const CLARITY_TABLES = [
  {
    name: "看板使用说明",
    primary: field("使用场景", 1),
    fields: [
      field("操作说明", 1),
      field("推荐查看表/视图", 1),
      field("客户检核口径", 1)
    ],
    views: ["客户检核-先看这里"]
  },
  {
    name: "月度经营汇总",
    primary: field("月份", 1),
    fields: [
      field("年份", 2, { formatter: "0" }),
      field("月份数字", 2, { formatter: "0" }),
      field("订单销售额", 2, { formatter: "0.00" }),
      field("销售利润", 2, { formatter: "0.00" }),
      field("平台扣费", 2, { formatter: "0.00" }),
      field("推广费", 2, { formatter: "0.00" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("订单数", 2, { formatter: "0" }),
      field("说明", 1)
    ],
    views: ["客户检核-按月份看销售额利润", "客户检核-5月6月对比入口"]
  },
  {
    name: "5月6月销售对比",
    primary: field("月份", 1),
    fields: [
      field("年份", 2, { formatter: "0" }),
      field("月份数字", 2, { formatter: "0" }),
      field("订单销售额", 2, { formatter: "0.00" }),
      field("销售利润", 2, { formatter: "0.00" }),
      field("平台扣费", 2, { formatter: "0.00" }),
      field("推广费", 2, { formatter: "0.00" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("订单数", 2, { formatter: "0" }),
      field("客户查看说明", 1)
    ],
    views: ["客户检核-直接看5月和6月"]
  },
  {
    name: "平台月度汇总",
    primary: field("汇总键", 1),
    fields: [
      field("月份", 1),
      field("平台", 1),
      field("订单销售额", 2, { formatter: "0.00" }),
      field("销售利润", 2, { formatter: "0.00" }),
      field("平台扣费", 2, { formatter: "0.00" }),
      field("推广费", 2, { formatter: "0.00" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("订单数", 2, { formatter: "0" }),
      field("说明", 1)
    ],
    views: ["客户检核-按平台看每月销售利润费用"]
  },
  {
    name: "销售人员月度业绩",
    primary: field("汇总键", 1),
    fields: [
      field("月份", 1),
      field("销售人员", 1),
      field("订单销售额", 2, { formatter: "0.00" }),
      field("销售利润", 2, { formatter: "0.00" }),
      field("订单数", 2, { formatter: "0" }),
      field("说明", 1)
    ],
    views: ["客户检核-按销售人员看每月业绩"]
  }
];

const SALES_SCHEMA = [
  {
    name: "客户信息",
    primary: field("客户名称", 1),
    fields: [
      field("客户编号", 1),
      field("客户类型", 3, { options: [option("企业客户", 0), option("个人客户", 1), option("渠道客户", 2), option("其他", 3)] }),
      field("客户等级", 3, { options: [option("A重点", 0), option("B潜力", 1), option("C普通", 2), option("D沉睡", 3)] }),
      field("客户来源", 3, { options: [option("平台", 0), option("转介绍", 1), option("广告推广", 2), option("销售开发", 3), option("其他", 4)] }),
      field("所属行业", 1),
      field("所在地区", 1),
      field("负责人", 18, { linkTo: "销售人员管理", multiple: false }),
      field("客户状态", 3, { options: [option("潜在", 0), option("跟进中", 1), option("已成交", 2), option("流失", 3), option("暂停", 4)] }),
      field("首次成交日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("最近跟进日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("最近成交日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("累计销售额", 2, { formatter: "0.00" }),
      field("累计销售利润", 2, { formatter: "0.00" }),
      field("跟进次数", 2, { formatter: "0" }),
      field("客户维护动作", 1),
      field("备注", 1)
    ]
  },
  {
    name: "客户联系人",
    primary: field("联系人姓名", 1),
    fields: [
      field("关联客户", 18, { linkTo: "客户信息", multiple: false }),
      field("职位", 1),
      field("手机/微信", 1),
      field("邮箱", 1),
      field("是否主要联系人", 7),
      field("关系状态", 3, { options: [option("正常", 0), option("重点维护", 1), option("已离职", 2), option("停用", 3)] }),
      field("备注", 1)
    ]
  },
  {
    name: "跟进记录",
    primary: field("跟进主题", 1),
    fields: [
      field("关联客户", 18, { linkTo: "客户信息", multiple: false }),
      field("关联联系人", 18, { linkTo: "客户联系人", multiple: false }),
      field("关联商机", 18, { linkTo: "商机管理", multiple: false }),
      field("跟进人", 18, { linkTo: "销售人员管理", multiple: false }),
      field("跟进时间", 5, { date_formatter: "yyyy/MM/dd HH:mm" }),
      field("跟进方式", 3, { options: [option("电话", 0), option("微信", 1), option("飞书", 2), option("面访", 3), option("邮件", 4), option("其他", 5)] }),
      field("跟进内容", 1),
      field("下次跟进时间", 5, { date_formatter: "yyyy/MM/dd HH:mm" }),
      field("跟进结果", 3, { options: [option("需继续跟进", 0), option("有明确需求", 1), option("已报价", 2), option("已成交", 3), option("暂不合作", 4)] }),
      field("是否需要提醒", 7),
      field("备注", 1)
    ]
  },
  {
    name: "商机管理",
    primary: field("商机名称", 1),
    fields: [
      field("关联客户", 18, { linkTo: "客户信息", multiple: false }),
      field("商机来源", 3, { options: [option("客户咨询", 0), option("销售开发", 1), option("广告线索", 2), option("转介绍", 3), option("复购", 4), option("其他", 5)] }),
      field("商机阶段", 3, { options: [option("初步接触", 0), option("需求确认", 1), option("报价方案", 2), option("谈判中", 3), option("赢单", 4), option("输单", 5), option("搁置", 6)] }),
      field("商机负责人", 18, { linkTo: "销售人员管理", multiple: false }),
      field("预计成交金额", 2, { formatter: "0.00" }),
      field("预计成本", 2, { formatter: "0.00" }),
      field("预计利润", 20, { formula: ["预计成交金额", "-", "预计成本"], formatter: "0.00" }),
      field("预计成交日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("成交概率", 2, { formatter: "0.00%" }),
      field("商机状态", 3, { options: [option("进行中", 0), option("赢单", 1), option("输单", 2), option("搁置", 3)] }),
      field("实际成交订单", 18, { linkTo: "销售订单", multiple: true }),
      field("创建日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("关闭日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("备注", 1)
    ]
  },
  {
    name: "销售订单",
    primary: field("订单编号", 1),
    fields: [
      field("订单日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("归属月份", 5, { date_formatter: "yyyy/MM/dd" }),
      field("关联客户", 18, { linkTo: "客户信息", multiple: false }),
      field("关联平台", 18, { linkTo: "平台管理", multiple: false }),
      field("销售人员", 18, { linkTo: "销售人员管理", multiple: false }),
      field("关联商机", 18, { linkTo: "商机管理", multiple: false }),
      field("订单状态", 3, { options: [option("待确认", 0), option("已成交", 1), option("已发货", 2), option("已完成", 3), option("已退货", 4), option("已取消", 5)] }),
      field("订单销售额", 2, { formatter: "0.00" }),
      field("订单成本", 2, { formatter: "0.00" }),
      field("平台扣费", 2, { formatter: "0.00" }),
      field("推广费", 2, { formatter: "0.00" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("销售利润", 20, { formula: ["订单销售额", "-", "订单成本", "-", "平台扣费", "-", "推广费", "-", "退货金额"], formatter: "0.00" }),
      field("利润率", 2, { formatter: "0.00%" }),
      field("销售明细", 18, { linkTo: "订单产品明细表", multiple: true }),
      field("退货记录", 18, { linkTo: "退货管理", multiple: true }),
      field("备注", 1)
    ]
  },
  {
    name: "订单产品明细表",
    primary: field("明细编号", 1),
    fields: [
      field("关联订单", 18, { linkTo: "销售订单", multiple: false }),
      field("关联产品", 18, { linkTo: "产品管理", multiple: false }),
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
    name: "退货管理",
    primary: field("退货编号", 1),
    fields: [
      field("关联订单", 18, { linkTo: "销售订单", multiple: false }),
      field("关联客户", 18, { linkTo: "客户信息", multiple: false }),
      field("关联平台", 18, { linkTo: "平台管理", multiple: false }),
      field("销售人员", 18, { linkTo: "销售人员管理", multiple: false }),
      field("退货日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("退货金额", 2, { formatter: "0.00" }),
      field("退货成本", 2, { formatter: "0.00" }),
      field("退货原因", 1),
      field("处理状态", 3, { options: [option("待处理", 0), option("处理中", 1), option("已退款", 2), option("已关闭", 3)] }),
      field("备注", 1)
    ]
  },
  {
    name: "平台管理",
    primary: field("平台名称", 1),
    fields: [
      field("平台类型", 3, { options: [option("电商平台", 0), option("线下渠道", 1), option("私域", 2), option("批发", 3), option("其他", 4)] }),
      field("扣费规则", 1),
      field("负责人", 18, { linkTo: "销售人员管理", multiple: false }),
      field("状态", 3, { options: [option("启用", 0), option("暂停", 1), option("停用", 2)] }),
      field("备注", 1)
    ]
  },
  {
    name: "平台费用",
    primary: field("费用名称", 1),
    fields: [
      field("费用日期", 5, { date_formatter: "yyyy/MM/dd" }),
      field("归属月份", 5, { date_formatter: "yyyy/MM/dd" }),
      field("关联平台", 18, { linkTo: "平台管理", multiple: false }),
      field("费用类型", 3, { options: [option("平台扣费", 0), option("推广费", 1), option("服务费", 2), option("物流费", 3), option("其他", 4)] }),
      field("费用金额", 2, { formatter: "0.00" }),
      field("关联订单", 18, { linkTo: "销售订单", multiple: false }),
      field("备注", 1)
    ]
  },
  {
    name: "销售人员管理",
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
      field("本月销售额", 2, { formatter: "0.00" }),
      field("本月销售利润", 2, { formatter: "0.00" }),
      field("本月订单数", 2, { formatter: "0" }),
      field("备注", 1)
    ]
  },
  {
    name: "销售目标管理",
    primary: field("目标名称", 1),
    fields: [
      field("目标月份", 5, { date_formatter: "yyyy/MM/dd" }),
      field("销售人员", 18, { linkTo: "销售人员管理", multiple: false }),
      field("关联平台", 18, { linkTo: "平台管理", multiple: false }),
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
      field("工资月份", 5, { date_formatter: "yyyy/MM/dd" }),
      field("销售人员", 18, { linkTo: "销售人员管理", multiple: false }),
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
    name: "经营看板指标",
    primary: field("指标名称", 1),
    fields: [
      field("指标月份", 5, { date_formatter: "yyyy/MM/dd" }),
      field("关联平台", 18, { linkTo: "平台管理", multiple: false }),
      field("销售人员", 18, { linkTo: "销售人员管理", multiple: false }),
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

const SALES_VIEWS = {
  "客户信息": [
    "客户总表",
    "客户分析-按等级",
    "客户分析-按来源",
    "客户维护-待跟进",
    "成交客户",
    "流失客户"
  ],
  "客户联系人": [
    "联系人总表",
    "主要联系人",
    "重点维护联系人"
  ],
  "跟进记录": [
    "跟进总表",
    "本周跟进",
    "下次跟进提醒",
    "按跟进人查看",
    "客户跟踪记录"
  ],
  "商机管理": [
    "商机总表",
    "商机分析-阶段分布",
    "本月预计成交",
    "高金额重点商机",
    "赢单输单复盘"
  ],
  "销售订单": [
    "订单管理-全部订单",
    "经营看板-月度销售利润",
    "经营看板-年度销售趋势",
    "平台销售数据",
    "销售人员业绩",
    "已完成订单",
    "退货订单"
  ],
  "订单产品明细表": [
    "销售明细总表",
    "商品SKU销售分析",
    "明细利润分析"
  ],
  "退货管理": [
    "退货管理-全部退货",
    "待处理退货",
    "按平台退货分析",
    "按销售人员退货分析"
  ],
  "平台管理": [
    "平台总表",
    "启用平台",
    "平台负责人"
  ],
  "平台费用": [
    "平台费用总表",
    "平台扣费明细",
    "推广费明细",
    "按月平台费用"
  ],
  "销售目标管理": [
    "目标管理总表",
    "月度目标查看",
    "销售人员目标完成",
    "平台目标完成",
    "未达成目标"
  ],
  "销售人员管理": [
    "销售人员总表",
    "在职销售人员",
    "销售人员业绩数据",
    "团队人员管理"
  ],
  "工资表": [
    "工资表总表",
    "月度工资表",
    "待审核工资",
    "已发放工资",
    "销售提成核算"
  ],
  "经营看板指标": [
    "经营看板-总览",
    "每年每月销售额利润",
    "各平台销售额利润费用",
    "销售人员业绩汇总",
    "销售目标达成汇总"
  ]
};

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
    if (!this.enabled) throw new Error("Feishu app credentials are not configured.");

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

  async createView(appToken, tableId, viewName, viewType = "grid") {
    return this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`,
      {
        method: "POST",
        body: {
          view_name: viewName,
          view_type: viewType
        }
      }
    );
  }

  async createRecord(appToken, tableId, fields) {
    return this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      {
        method: "POST",
        body: { fields }
      }
    );
  }

  async updateRecord(appToken, tableId, recordId, fields) {
    return this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      {
        method: "PUT",
        body: { fields }
      }
    );
  }

  async ensureSimpleTable(appToken, tableSpec, tableMap, logs) {
    if (!tableMap[tableSpec.name]) {
      const created = await this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
        method: "POST",
        body: {
          table: {
            name: tableSpec.name,
            default_view_name: tableSpec.views?.[0] || "表格视图",
            fields: [this.toApiField(tableSpec.primary)]
          }
        }
      });
      const tableId = created.table?.table_id || created.table_id;
      if (!tableId) throw new Error(`Create table response missing table_id for ${tableSpec.name}: ${truncate(JSON.stringify(created), 500)}`);
      tableMap[tableSpec.name] = tableId;
      logs.push({ action: "create_clarity_table", table: tableSpec.name, tableId });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } else {
      logs.push({ action: "skip_clarity_table", table: tableSpec.name, tableId: tableMap[tableSpec.name] });
    }

    const tableId = tableMap[tableSpec.name];
    const currentFields = await this.listAll(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { page_size: 100 }
    );
    const fieldMap = Object.fromEntries(currentFields.map((item) => [item.field_name, item.field_id]));

    for (const fieldSpec of tableSpec.fields || []) {
      if (fieldMap[fieldSpec.field_name]) {
        logs.push({ action: "skip_clarity_field", table: tableSpec.name, field: fieldSpec.field_name });
        continue;
      }
      await this.createField(appToken, tableId, fieldSpec, tableMap, fieldMap);
      logs.push({ action: "create_clarity_field", table: tableSpec.name, field: fieldSpec.field_name });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const currentViews = await this.listAll(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`,
      { page_size: 100 }
    );
    const viewSet = new Set(currentViews.map((item) => item.view_name || item.name));
    for (const viewName of tableSpec.views || []) {
      if (viewSet.has(viewName)) {
        logs.push({ action: "skip_clarity_view", table: tableSpec.name, view: viewName });
        continue;
      }
      await this.createView(appToken, tableId, viewName);
      logs.push({ action: "create_clarity_view", table: tableSpec.name, view: viewName });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return tableId;
  }

  async upsertRowsByPrimary(appToken, tableId, primaryFieldName, rows, logs, tableName) {
    const records = await this.listAll(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      { page_size: 100 }
    );
    const existing = new Map(records.map((record) => [textCell(record.fields?.[primaryFieldName], ""), record]));

    for (const row of rows) {
      const key = textCell(row[primaryFieldName], "");
      if (!key) continue;
      const current = existing.get(key);
      if (current?.record_id) {
        await this.updateRecord(appToken, tableId, current.record_id, row);
        logs.push({ action: "update_clarity_record", table: tableName, key });
      } else {
        await this.createRecord(appToken, tableId, row);
        logs.push({ action: "create_clarity_record", table: tableName, key });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  collectDashboardClarityRows(orderRecords) {
    const monthly = new Map();
    const platformMonthly = new Map();
    const sellerMonthly = new Map();
    const thisYear = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date());

    for (const record of orderRecords) {
      const fields = record.fields || {};
      const statusText = textCell(firstExisting(fields, ["订单状态", "状态"]), "");
      if (statusText.includes("已取消") || statusText.includes("取消")) continue;

      const monthKey = parseMonthKey(firstExisting(fields, ["订单日期", "下单日期", "归属月份", "日期"]));
      if (!monthKey) continue;

      const sales = numberCell(firstExisting(fields, ["订单销售额", "销售额", "订单金额", "成交金额"]));
      const cost = numberCell(firstExisting(fields, ["订单成本", "成本"]));
      const platformFee = numberCell(firstExisting(fields, ["平台扣费", "平台费用", "扣费"]));
      const promotionFee = numberCell(firstExisting(fields, ["推广费", "推广费用"]));
      const returnAmount = numberCell(firstExisting(fields, ["退货金额", "退款金额"]));
      const explicitProfit = firstExisting(fields, ["销售利润", "订单利润", "利润"]);
      const profit = explicitProfit === undefined
        ? sales - cost - platformFee - promotionFee - returnAmount
        : numberCell(explicitProfit);
      const values = { sales, profit, platformFee, promotionFee, returnAmount, orderCount: 1 };

      if (!monthly.has(monthKey)) monthly.set(monthKey, blankSummary());
      addAmount(monthly.get(monthKey), values);

      const platform = textCell(firstExisting(fields, ["关联平台", "平台", "销售平台"]), "未填写平台");
      const platformKey = `${monthKey}｜${platform}`;
      if (!platformMonthly.has(platformKey)) platformMonthly.set(platformKey, { monthKey, platform, ...blankSummary() });
      addAmount(platformMonthly.get(platformKey), values);

      const seller = textCell(firstExisting(fields, ["销售人员", "销售", "负责人"]), "未填写销售人员");
      const sellerKey = `${monthKey}｜${seller}`;
      if (!sellerMonthly.has(sellerKey)) sellerMonthly.set(sellerKey, { monthKey, seller, ...blankSummary() });
      addAmount(sellerMonthly.get(sellerKey), values);
    }

    for (const requiredMonth of [`${thisYear}-05`, `${thisYear}-06`]) {
      if (!monthly.has(requiredMonth)) monthly.set(requiredMonth, blankSummary());
    }

    const monthlyRows = [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monthKey, values]) => {
        const parts = monthParts(monthKey);
        return {
          "月份": monthKey,
          "年份": parts.year,
          "月份数字": parts.month,
          "订单销售额": values.sales,
          "销售利润": values.profit,
          "平台扣费": values.platformFee,
          "推广费": values.promotionFee,
          "退货金额": values.returnAmount,
          "订单数": values.orderCount,
          "说明": "客户检核入口：按月份查看销售额、利润、费用和订单数。"
        };
      });

    const mayJuneRows = monthlyRows
      .filter((row) => row["月份"].endsWith("-05") || row["月份"].endsWith("-06"))
      .map((row) => ({
        "月份": row["月份"],
        "年份": row["年份"],
        "月份数字": row["月份数字"],
        "订单销售额": row["订单销售额"],
        "销售利润": row["销售利润"],
        "平台扣费": row["平台扣费"],
        "推广费": row["推广费"],
        "退货金额": row["退货金额"],
        "订单数": row["订单数"],
        "客户查看说明": "客户要看5月和6月销售额时，直接看本表两行的订单销售额和销售利润。"
      }));

    const platformRows = [...platformMonthly.values()]
      .sort((a, b) => `${a.monthKey}${a.platform}`.localeCompare(`${b.monthKey}${b.platform}`))
      .map((values) => ({
        "汇总键": `${values.monthKey}｜${values.platform}`,
        "月份": values.monthKey,
        "平台": values.platform,
        "订单销售额": values.sales,
        "销售利润": values.profit,
        "平台扣费": values.platformFee,
        "推广费": values.promotionFee,
        "退货金额": values.returnAmount,
        "订单数": values.orderCount,
        "说明": "客户检核入口：按月份和平台查看销售额、利润、平台扣费、推广费。"
      }));

    const sellerRows = [...sellerMonthly.values()]
      .sort((a, b) => `${a.monthKey}${b.sales}`.localeCompare(`${b.monthKey}${a.sales}`))
      .map((values) => ({
        "汇总键": `${values.monthKey}｜${values.seller}`,
        "月份": values.monthKey,
        "销售人员": values.seller,
        "订单销售额": values.sales,
        "销售利润": values.profit,
        "订单数": values.orderCount,
        "说明": "客户检核入口：按月份和销售人员查看业绩。"
      }));

    const guideRows = [
      {
        "使用场景": "怎么看5月和6月销售额",
        "操作说明": "打开“5月6月销售对比”表，直接查看2026-05和2026-06两行的订单销售额、销售利润、平台扣费、推广费、订单数。",
        "推荐查看表/视图": "5月6月销售对比 / 客户检核-直接看5月和6月",
        "客户检核口径": "订单状态不包含已取消；按订单日期归属月份统计。"
      },
      {
        "使用场景": "怎么看每年每月销售额和利润",
        "操作说明": "打开“月度经营汇总”表，按月份字段查看每个月的订单销售额和销售利润；需要看全年时筛选同一年。",
        "推荐查看表/视图": "月度经营汇总 / 客户检核-按月份看销售额利润",
        "客户检核口径": "订单销售额、销售利润、平台扣费、推广费、退货金额均来自销售订单表汇总。"
      },
      {
        "使用场景": "怎么看每个平台销售额、利润和费用",
        "操作说明": "打开“平台月度汇总”表，按月份和平台查看订单销售额、销售利润、平台扣费、推广费。",
        "推荐查看表/视图": "平台月度汇总 / 客户检核-按平台看每月销售利润费用",
        "客户检核口径": "同一月份内，按销售订单表的关联平台分组汇总。"
      },
      {
        "使用场景": "怎么看每个销售人员业绩",
        "操作说明": "打开“销售人员月度业绩”表，按月份和销售人员查看销售额、利润和订单数。",
        "推荐查看表/视图": "销售人员月度业绩 / 客户检核-按销售人员看每月业绩",
        "客户检核口径": "同一月份内，按销售订单表的销售人员字段分组汇总。"
      }
    ];

    return { guideRows, monthlyRows, mayJuneRows, platformRows, sellerRows };
  }

  async applyDashboardClarity({ appToken = DEFAULT_APP_TOKEN } = {}) {
    if (!this.enabled) throw new Error("Feishu app credentials are not configured.");

    const logs = [];
    const tables = await this.listAll(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
      page_size: 100
    });
    const tableMap = Object.fromEntries(tables.map((item) => [item.name, item.table_id]));
    const salesOrder = tables.find((table) => table.name === "销售订单") || tables.find((table) => table.name.includes("订单"));
    if (!salesOrder?.table_id) throw new Error("未找到“销售订单”表，无法生成客户检核汇总。");

    const orderRecords = await this.listAll(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(salesOrder.table_id)}/records`,
      { page_size: 100 }
    );
    logs.push({ action: "read_sales_orders", table: salesOrder.name, records: orderRecords.length });

    const clarityTableIds = {};
    for (const tableSpec of CLARITY_TABLES) {
      clarityTableIds[tableSpec.name] = await this.ensureSimpleTable(appToken, tableSpec, tableMap, logs);
    }

    const rows = this.collectDashboardClarityRows(orderRecords);
    await this.upsertRowsByPrimary(appToken, clarityTableIds["看板使用说明"], "使用场景", rows.guideRows, logs, "看板使用说明");
    await this.upsertRowsByPrimary(appToken, clarityTableIds["月度经营汇总"], "月份", rows.monthlyRows, logs, "月度经营汇总");
    await this.upsertRowsByPrimary(appToken, clarityTableIds["5月6月销售对比"], "月份", rows.mayJuneRows, logs, "5月6月销售对比");
    await this.upsertRowsByPrimary(appToken, clarityTableIds["平台月度汇总"], "汇总键", rows.platformRows, logs, "平台月度汇总");
    await this.upsertRowsByPrimary(appToken, clarityTableIds["销售人员月度业绩"], "汇总键", rows.sellerRows, logs, "销售人员月度业绩");

    return {
      appToken,
      generatedAt: new Date().toISOString(),
      source: {
        table: salesOrder.name,
        records: orderRecords.length
      },
      summaries: {
        monthlyRows: rows.monthlyRows.length,
        mayJuneRows: rows.mayJuneRows.length,
        platformRows: rows.platformRows.length,
        sellerRows: rows.sellerRows.length
      },
      logs
    };
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
      try {
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
      } catch (error) {
        logs.push({ action: "table_error", table: tableSpec.name, error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const tableSpec of SALES_SCHEMA) {
      const tableId = tableMap[tableSpec.name];
      if (!tableId) {
        logs.push({ action: "skip_fields_missing_table", table: tableSpec.name });
        continue;
      }
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

    for (const [tableName, viewNames] of Object.entries(SALES_VIEWS)) {
      const tableId = tableMap[tableName];
      if (!tableId) {
        logs.push({ action: "skip_views_missing_table", table: tableName });
        continue;
      }

      try {
        const currentViews = await this.listAll(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`,
          { page_size: 100 }
        );
        const viewSet = new Set(currentViews.map((item) => item.view_name || item.name));

        for (const viewName of viewNames) {
          if (viewSet.has(viewName)) {
            logs.push({ action: "skip_view", table: tableName, view: viewName });
            continue;
          }

          try {
            const created = await this.createView(appToken, tableId, viewName);
            const viewId = created.view?.view_id || created.view_id;
            logs.push({ action: "create_view", table: tableName, view: viewName, viewId });
            viewSet.add(viewName);
          } catch (error) {
            logs.push({ action: "view_error", table: tableName, view: viewName, error: error.message });
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch (error) {
        logs.push({ action: "list_views_error", table: tableName, error: error.message });
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
