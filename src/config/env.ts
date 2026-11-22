// Configuração por variáveis de ambiente, validada na subida. Erro cita a variável, nunca o valor.
import { z } from 'zod';
import { parseOperatorTokens } from '../auth/operator.js';
import { ExecutionModeSchema } from '../executor/executor.js';

const token = z.string().min(16, 'use pelo menos 16 caracteres');

const LlmEnvShape = {
  /** `scripted` responde de LLM_SCRIPT_FILE, sem rede: só para demonstração. */
  LLM_PROVIDER: z.enum(['openrouter', 'ollama', 'scripted']).default('ollama'),
  LLM_SCRIPT_FILE: z.string().min(1).default('config/scripted-llm.yaml'),
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
    AUDIT_SINK: z.enum(['file', 's3']).default('file'),
    AUDIT_LOG_PATH: z.string().min(1).default('var/audit.jsonl'),
    AUDIT_S3_BUCKET: z.string().min(3).default('ops-copilot-audit'),
    AUDIT_S3_PREFIX: z.string().default('audit/'),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    /** Vazio usa a AWS; no ambiente local aponta para o MinIO. */
    S3_ENDPOINT: z.url().optional(),
    EXECUTION_MODE: ExecutionModeSchema.default('dry-run'),
    /** Executor real (EXECUTION_MODE=live): tudo explícito, sem padrões que alcancem a máquina. */
    EXECUTOR_TARGETS_FILE: z.string().min(1).optional(),
    KUBE_AUTH: z.enum(['in-cluster', 'kubeconfig']).optional(),
    KUBECONFIG_PATH: z.string().min(1).optional(),
    KUBE_CONTEXT: z.string().min(1).optional(),
    FEATURE_FLAGS_URL: z.url().optional(),
    FEATURE_FLAGS_TOKEN: token.optional(),
    /** Redis onde vivem as filas de DLQ; separado do Redis de estado do copiloto. */
    DLQ_REDIS_URL: z.url().optional(),
    APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
    WEBHOOK_TOKEN: token,
    /** Operadores do ambiente local (ADR 0012): `email=token,email2=token2`. */
    OPERATOR_TOKENS: z.string().optional(),
    /** OIDC opcional (Keycloak do platform-edge): com o emissor definido, aceita access tokens JWT. */
    OIDC_ISSUER_URL: z.url().optional(),
    OIDC_AUDIENCE: z.string().min(1).default('ops-copilot'),
    OIDC_JWKS_URL: z.url().optional(),
    /** Cliente público (PKCE) que o painel usa para o login OIDC. */
    OIDC_CLIENT_ID: z.string().min(1).default('ops-copilot-web'),
    /** Endereço do Jaeger visto pelo navegador, para o link do trace de cada investigação. */
    JAEGER_PUBLIC_URL: z.url().optional(),
    /** Commit da política e dos playbooks carregados, mostrado no painel. */
    GIT_COMMIT: z.string().min(1).default('desconhecido'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    /** Vazio guarda orçamento, aprovações e incidentes em memória (perdidos no restart). */
    REDIS_URL: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    requireOpenRouterKey(env, ctx);
    if (env.EXECUTION_MODE === 'live') requireLiveConfig(env, ctx);
    if (!env.OPERATOR_TOKENS && !env.OIDC_ISSUER_URL) {
      ctx.addIssue({ code: 'custom', path: ['OPERATOR_TOKENS'], message: 'defina OPERATOR_TOKENS ou OIDC_ISSUER_URL' });
    }
    if (env.OPERATOR_TOKENS) {
      try {
        const tokens = parseOperatorTokens(env.OPERATOR_TOKENS);
        if ([...tokens.values()].includes(env.WEBHOOK_TOKEN)) {
          ctx.addIssue({ code: 'custom', path: ['OPERATOR_TOKENS'], message: 'nenhum token pode ser igual a WEBHOOK_TOKEN' });
        }
      } catch (error) {
        ctx.addIssue({ code: 'custom', path: ['OPERATOR_TOKENS'], message: (error as Error).message });
      }
    }
  });
export type Env = z.infer<typeof EnvSchema>;

interface LiveEnv {
  EXECUTOR_TARGETS_FILE?: string | undefined;
  KUBE_AUTH?: string | undefined;
  KUBECONFIG_PATH?: string | undefined;
  KUBE_CONTEXT?: string | undefined;
  FEATURE_FLAGS_URL?: string | undefined;
  FEATURE_FLAGS_TOKEN?: string | undefined;
  DLQ_REDIS_URL?: string | undefined;
}

/** O modo live só sobe com a allowlist de alvos e ao menos um backend configurados à mão. */
function requireLiveConfig(env: LiveEnv, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (!env.EXECUTOR_TARGETS_FILE) issue('EXECUTOR_TARGETS_FILE', 'obrigatória com EXECUTION_MODE=live');
  if (env.KUBE_AUTH === 'kubeconfig') {
    if (!env.KUBECONFIG_PATH) issue('KUBECONFIG_PATH', 'obrigatória com KUBE_AUTH=kubeconfig');
    if (!env.KUBE_CONTEXT) issue('KUBE_CONTEXT', 'obrigatória com KUBE_AUTH=kubeconfig');
  }
  if (Boolean(env.FEATURE_FLAGS_URL) !== Boolean(env.FEATURE_FLAGS_TOKEN)) {
    issue('FEATURE_FLAGS_TOKEN', 'FEATURE_FLAGS_URL e FEATURE_FLAGS_TOKEN andam juntas');
  }
  if (!env.KUBE_AUTH && !env.FEATURE_FLAGS_URL && !env.DLQ_REDIS_URL) {
    issue('KUBE_AUTH', 'configure ao menos um backend (KUBE_AUTH, FEATURE_FLAGS_URL ou DLQ_REDIS_URL)');
  }
}

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
