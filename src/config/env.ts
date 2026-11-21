// Configuração por variáveis de ambiente, validada na subida. Erro cita a variável, nunca o valor.
import { z } from 'zod';
import { ExecutionModeSchema } from '../executor/executor.js';

const token = z.string().min(16, 'use pelo menos 16 caracteres');

const LlmEnvShape = {
  LLM_PROVIDER: z.enum(['openrouter', 'ollama']).default('ollama'),
  LLM_BASE_URL: z.url().default('http://localhost:11434/v1'),
  LLM_MODEL: z.string().min(1).default('qwen2.5:7b-instruct'),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
};

const requireOpenRouterKey = (env: { LLM_PROVIDER: string; OPENROUTER_API_KEY?: string | undefined }, ctx: z.RefinementCtx) => {
  if (env.LLM_PROVIDER === 'openrouter' && !env.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['OPENROUTER_API_KEY'], message: 'obrigatória com LLM_PROVIDER=openrouter' });
  }
};

/** Só o necessário para falar com o LLM (usado pelo eval com modelo real). */
export const LlmEnvSchema = z.object(LlmEnvShape).superRefine(requireOpenRouterKey);
export type LlmEnv = z.infer<typeof LlmEnvSchema>;

export const EnvSchema = z
  .object({
    ...LlmEnvShape,
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PROMETHEUS_URL: z.url().default('http://localhost:9090'),
    JAEGER_URL: z.url().default('http://localhost:16686'),
    PLAYBOOKS_DIR: z.string().min(1).default('playbooks'),
    AUTONOMY_POLICY_FILE: z.string().min(1).default('config/autonomy-policy.yaml'),
    AUDIT_LOG_PATH: z.string().min(1).default('var/audit.jsonl'),
    EXECUTION_MODE: ExecutionModeSchema.default('dry-run'),
    APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
    WEBHOOK_TOKEN: token,
    APPROVAL_TOKEN: token,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    requireOpenRouterKey(env, ctx);
    if (env.WEBHOOK_TOKEN === env.APPROVAL_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['APPROVAL_TOKEN'], message: 'precisa ser diferente de WEBHOOK_TOKEN' });
    }
  });
export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseOrThrow(EnvSchema, source);
}

export function loadLlmEnv(source: NodeJS.ProcessEnv = process.env): LlmEnv {
  return parseOrThrow(LlmEnvSchema, source);
}

function parseOrThrow<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Configuração inválida:\n${issues.join('\n')}`);
  }
  return result.data;
}
