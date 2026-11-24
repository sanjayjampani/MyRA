-- Tables the product queries that 0001-0003 never create.
-- IF NOT EXISTS so a database that already has them is left alone.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  google_id TEXT UNIQUE,
  email TEXT UNIQUE,
  name TEXT,
  user_name TEXT,
  picture TEXT,
  email_verified BOOLEAN,
  locale TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  login_count INTEGER NOT NULL DEFAULT 0,
  api_budget_half_threshold INTEGER NOT NULL DEFAULT 50,
  api_budget_attention_threshold INTEGER NOT NULL DEFAULT 80,
  api_budget_critical_threshold INTEGER NOT NULL DEFAULT 95,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  document_id TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT,
  content TEXT,
  title TEXT,
  timestamp TIMESTAMPTZ,
  author TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  needs_embedding BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS documents_user_source_idx ON documents (user_id, source);

CREATE TABLE IF NOT EXISTS document_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  content TEXT,
  chunk_index INTEGER,
  embedding vector,
  source_type TEXT,
  occurred_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS document_chunks_document_idx ON document_chunks (document_id);

CREATE TABLE IF NOT EXISTS api_credentials (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  source TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT,
  scopes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, source)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  sync_completed_at TIMESTAMPTZ,
  documents_fetched INTEGER,
  documents_stored INTEGER,
  last_sync_timestamp TIMESTAMPTZ,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_message TEXT,
  assistant_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id BIGINT NOT NULL,
  is_deleted BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, conversation_id);

-- user_id is INTEGER because the insert casts $9::integer.
CREATE TABLE IF NOT EXISTS llm_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  conversation_id VARCHAR(255),
  provider VARCHAR(50),
  model VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  input_cost NUMERIC,
  output_cost NUMERIC,
  invocation_type VARCHAR(50),
  user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_tokens INTEGER GENERATED ALWAYS AS (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) STORED,
  total_cost NUMERIC GENERATED ALWAYS AS (COALESCE(input_cost, 0) + COALESCE(output_cost, 0)) STORED
);

CREATE TABLE IF NOT EXISTS api_budgets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  provider_key VARCHAR(100) NOT NULL,
  provider_name TEXT,
  service_type TEXT NOT NULL,
  monthly_budget_inr INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, service_type, provider_key)
);

CREATE TABLE IF NOT EXISTS api_budget_alerts (
  id BIGSERIAL PRIMARY KEY,
  api_budget_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  provider_key VARCHAR(100),
  period_start DATE NOT NULL,
  threshold_key VARCHAR(32) NOT NULL,
  threshold_percent SMALLINT,
  usage_inr NUMERIC(14, 4),
  budget_inr INTEGER,
  status VARCHAR(16),
  message_id TEXT,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (api_budget_id, period_start, threshold_key)
);
