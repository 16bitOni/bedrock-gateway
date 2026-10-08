// Response shapes of the Bedrock Portal backend (/api/* and /v1/*).

export interface AuthStatus {
  setup_required: boolean;
  signed_in: boolean;
  version: string;
}

export interface TokenResponse {
  token: string;
}

export interface Totals {
  requests: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  errors: number;
}

export interface SeriesPoint {
  date: string;
  requests: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
}

export interface ByModelRow {
  model: string | null;
  requests: number;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface ByKeyRow {
  key_id: number | null;
  key_name: string | null;
  requests: number;
  cost: number | null;
}

export interface ByEndpointRow {
  endpoint: string;
  requests: number;
  cost: number | null;
}

export interface RecentError {
  id: string;
  ts: number;
  endpoint: string;
  requested_model: string | null;
  status: number;
  error_code: string | null;
  error_message: string | null;
}

export interface TopRequest {
  id: string;
  ts: number;
  endpoint: string;
  requested_model: string | null;
  resolved_model: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface KeyBudget {
  id: number;
  name: string;
  budget: number;
  spent: number;
}

export interface Overview {
  today: Totals;
  week: Totals;
  month: Totals;
  all_time: Totals;
  forecast_month: number;
  series: SeriesPoint[];
  by_model: ByModelRow[];
  by_key: ByKeyRow[];
  by_endpoint: ByEndpointRow[];
  recent_errors: RecentError[];
  top_requests: TopRequest[];
  latency_24h: { p50: number | null; p95: number | null; ttft_p50: number | null; ttft_p95: number | null };
  budget: { monthly_cap: number | null; spent: number; alert_pct: number | null; keys: KeyBudget[] };
  catalog: { synced_at: number | null; enabled_models: number; total_models: number };
  keys_count: number;
}

export interface SyncResult {
  models: number;
  enabled: number;
  aliases_created: number;
}

export interface PriceSummary {
  matched_prefix: string;
  input_per_m: number | null;
  output_per_m: number | null;
  cache_read_per_m: number | null;
  cache_write_per_m: number | null;
  per_image: number | null;
  per_1k_queries: number | null;
  per_1m_chars: number | null;
  per_minute: number | null;
  markup_applied: boolean;
}

export type ModelRoute =
  | "on_demand"
  | "profile_global"
  | "profile_geo"
  | "application_profile"
  | "virtual"
  | "custom";

export interface CatalogModel {
  id: string;
  base_model_id: string;
  name: string;
  provider: string;
  kind: string;
  input_modalities: string[];
  output_modalities: string[];
  streaming: number;
  route: ModelRoute | string;
  lifecycle: string;
  enabled: number;
  source: string;
  updated_at: number;
  price: PriceSummary | null;
  aliases: string[];
  month_requests: number;
  month_cost: number;
}

export interface ModelsResponse {
  data: CatalogModel[];
  synced_at: number | null;
  region: string;
}

export interface Alias {
  name: string;
  targets: string[];
  description: string | null;
  created_at: number;
}

export interface Preset {
  name: string;
  model: string;
  system_prompt: string | null;
  params: Record<string, unknown>;
  description: string | null;
  created_at?: number;
  updated_at?: number;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  allowed_models: string[];
  monthly_budget_usd: number | null;
  rpm_limit: number | null;
  expires_at: number | null;
  disabled: number;
  store_bodies: number;
  cache_enabled: number;
  guardrail_id: string | null;
  guardrail_version: string | null;
  notes: string | null;
  created_at: number;
  last_used_at: number | null;
  month_spend: number;
  month_requests: number;
  total_spend: number;
  key?: string;
}

export interface LogRow {
  id: string;
  ts: number;
  key_id: number | null;
  key_name: string | null;
  endpoint: string;
  requested_model: string | null;
  resolved_model: string | null;
  attempt: number;
  stream: number;
  status: number;
  error_code: string | null;
  error_message: string | null;
  ttft_ms: number | null;
  latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  units: number;
  cost_usd: number;
  cached: number;
  finish_reason: string | null;
  session_id: string | null;
}

export interface LogDetail extends LogRow {
  request_body: unknown;
  response_body: unknown;
}

export interface LogsResponse {
  data: LogRow[];
  total: number;
  aggregate: { cost: number; input_tokens: number; output_tokens: number };
  limit: number;
  offset: number;
}

export interface AwsCredit {
  type: string | null;
  status: string | null;
  initial: number;
  remaining: number;
  currency: string;
  products: string[];
  end_date: string;
  exhaust_date: string;
}

export interface AwsBilling {
  enabled: boolean;
  services?: string[];
  daily?: { date: string; total: number; by_service: Record<string, number> }[];
  month_to_date?: number;
  last_month?: number;
  usage_types?: { usage_type: string; cost: number; quantity: number }[];
  credits_applied_this_month?: number;
  credits?: AwsCredit[];
  credits_remaining?: number;
  errors?: string[];
  fetched_at?: number;
}

export interface BillingResponse {
  estimated: {
    month_to_date: number;
    last_month: number;
    daily: { date: string; cost: number; requests: number }[];
  };
  aws: AwsBilling | null;
  billing_enabled: boolean;
}

export type AuthMode = "assume_role" | "default_chain" | "static_keys";

export interface Settings {
  aws_auth_mode: AuthMode;
  aws_region: string;
  aws_role_arn: string;
  aws_external_id: string;
  aws_profile: string;
  aws_access_key_id: string;
  aws_secret_access_key_set: boolean;
  aws_session_duration: number;
  default_max_tokens: number;
  retry_attempts: number;
  auto_prompt_cache: boolean;
  log_bodies: boolean;
  log_retention_days: number;
  cache_ttl_hours: number;
  monthly_budget_usd: number | null;
  budget_alert_pct: number;
  geo_profile_markup: number;
  public_base_url: string;
  tts_default_engine: string;
  stt_model: string;
  transcribe_s3_bucket: string;
  billing_enabled: boolean;
  billing_cache_hours: number;
  catalog_synced_at: number;
}

export interface TestAwsResult {
  ok?: boolean;
  error?: string;
  mode?: string;
  region?: string;
  identity?: { account: string; arn: string };
  foundation_models?: number;
  checks?: Record<string, string>;
}

export interface IamInfo {
  external_id: string;
  trust_policy: unknown;
  permissions_policy: unknown;
  cloudformation_template: string;
  cloudformation_yaml?: string | null;
}

export interface PriceRow {
  model_prefix: string;
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m: number | null;
  cache_write_per_m: number | null;
  per_image: number | null;
  per_1k_queries: number | null;
  per_1m_chars: number | null;
  per_minute: number | null;
  geo_markup: number;
  custom: number;
  updated_at: number;
}

export interface PricesResponse {
  data: PriceRow[];
  geo_profile_markup: number;
}

export interface PortalInfo {
  version: string;
  base_url: string;
  openai_base_url: string;
  anthropic_base_url: string;
  region: string;
  aliases: string[];
}

// ---- /v1 ----

export interface V1Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  kind?: string;
  targets?: string[];
}

export interface Voice {
  id: string;
  name: string | null;
  gender: string | null;
  language: string | null;
  language_name?: string | null;
  engines: string[];
}

export interface VoicesResponse {
  data: Voice[];
  openai_voice_map: Record<string, string>;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cost?: number;
}

export interface ChatChunk {
  id?: string;
  model?: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason: string | null;
  }[];
  usage?: ChatUsage;
}

export interface ImageResult {
  created: number;
  data: { url?: string; b64_json?: string; revised_prompt?: string }[];
  usage: { images: number; cost: number };
}

export interface EmbeddingsResult {
  data: { index: number; embedding: number[] }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number; cost: number };
}

export interface RerankResult {
  id: string;
  model: string;
  results: { index: number; relevance_score: number; document?: { text: string } }[];
  usage: { queries: number; cost: number };
}

export interface TranscriptionResult {
  text: string;
  usage?: { type: string; cost: number };
}
