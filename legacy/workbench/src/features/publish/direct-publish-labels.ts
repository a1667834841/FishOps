/** 将平台服务编码转换为用户可读名称；未知服务保留编码，避免误标服务含义。 */
export function formatPublishServiceName(code: string): string {
  const names: Record<string, string> = {
    FAST_DELIVERY_48_HOUR: '48 小时内发货',
    FAST_DELIVERY_24_HOUR: '24 小时内发货',
    NONCONFORMITY_FREE_REFUND: '描述不符包退',
    RETURN_SHIPPING_INSURANCE: '退货运费险',
    AI_SALE: 'AI 帮卖',
    INSPECTION: '验货服务',
  }
  return names[code] ?? `其他平台服务（${code}）`
}
