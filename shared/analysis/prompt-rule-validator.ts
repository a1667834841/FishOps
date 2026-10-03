/**
 * 提示词规则与模板变量校验（P7）。
 *
 * 1. 提取并校验模板占位变量（{{variable}}），确保在受支持的变量白名单内；
 * 2. 严格敏感信息审查：禁止将 OpenAI Key、飞书 AppSecret、密码、Token 等明文放入规则；
 * 3. 基础必填字段完整性校验。
 */
import type { PromptRule } from '../types/analysis'

/** 受支持的 Prompt 模板变量白名单。 */
export const ALLOWED_TEMPLATE_VARIABLES: ReadonlySet<string> = new Set([
  'dataset',             // 抽样并脱敏后的数据集行文本（JSON 或格式化表格）
  'summary',             // 数据集统计指标（总数、均价、中位数、想要数等）
  'columns',             // 数据集字段列表
  'rowCount',            // 样本数量
  'ruleName',            // 当前规则名称
  'customInstructions',  // 用户额外指令
])

/** 提取字符串中形如 `{{variableName}}` 的变量标识符。 */
export function extractTemplateVariables(template: string): string[] {
  const matches = template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)
  const vars = new Set<string>()
  for (const match of matches) {
    if (match[1]) vars.add(match[1])
  }
  return Array.from(vars)
}

/** 敏感词及密钥特征正则列表。 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{16,}/i,               // OpenAI API Key
  /app_?secret\s*[:=]\s*["']?[a-zA-Z0-9]{10,}["']?/i, // AppSecret 赋值
  /api_?key\s*[:=]\s*["']?[a-zA-Z0-9]{10,}["']?/i,    // API Key 赋值
  /bearer\s+[a-zA-Z0-9_.-]{20,}/i,       // Bearer Token
  /t-[a-zA-Z0-9]{20,}/i,                  // 飞书 Tenant Token 常见模式
  /password\s*[:=]\s*["']?\S{6,}["']?/i, // 明文密码
]

/**
 * 检查文本是否包含潜在的敏感凭据。
 * 若发现则返回 false 及具体原因。
 */
export function validateNoSecrets(text: string): { valid: boolean; reason?: string } {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        valid: false,
        reason: '规则内容检测到疑似 API Key、Secret 或敏感凭据，严禁将密钥保存在提示词规则中',
      }
    }
  }
  return { valid: true }
}

export interface RuleValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * 完整校验 PromptRule 实体。
 */
export function validatePromptRule(rule: Partial<PromptRule>): RuleValidationResult {
  const errors: string[] = []

  if (!rule.id || typeof rule.id !== 'string' || rule.id.trim().length === 0) {
    errors.push('规则 ID 不能为空')
  }

  if (!rule.name || typeof rule.name !== 'string' || rule.name.trim().length === 0) {
    errors.push('规则名称不能为空')
  }

  if (typeof rule.systemPrompt !== 'string' || rule.systemPrompt.trim().length === 0) {
    errors.push('系统提示词（systemPrompt）不能为空')
  }

  if (typeof rule.userPromptTemplate !== 'string' || rule.userPromptTemplate.trim().length === 0) {
    errors.push('用户提示词模板（userPromptTemplate）不能为空')
  }

  // 敏感信息检查
  const contentToCheck = `${rule.name ?? ''}\n${rule.description ?? ''}\n${rule.systemPrompt ?? ''}\n${rule.userPromptTemplate ?? ''}`
  const secretCheck = validateNoSecrets(contentToCheck)
  if (!secretCheck.valid) {
    errors.push(secretCheck.reason!)
  }

  // 变量校验
  if (typeof rule.userPromptTemplate === 'string') {
    const vars = extractTemplateVariables(rule.userPromptTemplate)
    for (const v of vars) {
      if (!ALLOWED_TEMPLATE_VARIABLES.has(v)) {
        errors.push(`未知或不受支持的模板变量: {{${v}}}，允许的变量为: ${Array.from(ALLOWED_TEMPLATE_VARIABLES).join(', ')}`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
