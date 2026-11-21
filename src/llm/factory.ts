// Factory do adaptador LLM: escolhe a implementação da porta LlmClient pelo provedor configurado.
import type { LlmEnv } from '../config/env.js';
import type { LlmClient } from './client.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';
import { ScriptedLlmClient } from './scripted.js';

export async function createLlmClient(env: LlmEnv): Promise<LlmClient> {
  if (env.LLM_PROVIDER === 'scripted') return ScriptedLlmClient.fromFile(env.LLM_SCRIPT_FILE);
  return new OpenAiCompatibleClient({ provider: env.LLM_PROVIDER, baseUrl: env.LLM_BASE_URL, apiKey: env.OPENROUTER_API_KEY });
}
