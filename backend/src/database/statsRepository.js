import { getPool } from "../config/dbConfig.js";

export const LLM_USAGE_INSERT_SQL = `INSERT INTO llm_usage_logs (
                    conversation_id,
                    provider,
                    model,
                    input_tokens,
                    output_tokens,
                    input_cost,
                    output_cost,
                    invocation_type,
                    user_id
                  )
                  VALUES (
                    $1::varchar(255),
                    $2::varchar(50),
                    $3::varchar(100),
                    $4::integer,
                    $5::integer,
                    $6::numeric,
                    $7::numeric,
                    $8::varchar(50),
                    $9::integer
                  )
                  RETURNING id, total_tokens, total_cost`;

function finiteNonNegative(value, fieldName) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new TypeError(`${fieldName} must be a finite, non-negative number`);
  }

  return numericValue;
}

export class StatsRepository {
  async insertLLMPrice(stats, queryable = getPool()) {
    const inputTokens = finiteNonNegative(stats.inputTokens, "inputTokens");
    const outputTokens = finiteNonNegative(stats.outputTokens, "outputTokens");
    const inputCost = finiteNonNegative(stats.inputCost, "inputCost");
    const outputCost = finiteNonNegative(stats.outputCost, "outputCost");

    const result = await queryable.query(LLM_USAGE_INSERT_SQL, [
      stats.conversationId,
      stats.provider,
      stats.model,
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      stats.invocationType,
      stats.userId,
    ]);

    return result.rows[0];
  }

  async getCostAndTokensConsumed(days, userId) {
    const query = `SELECT
                    provider,
                    model,
                    SUM(input_tokens) AS totalinputtokens,
                    SUM(output_tokens) AS totaloutputtokens,
                    SUM(input_cost) AS totalinputcost,
                    SUM(output_cost) AS totaloutputcost
                  FROM llm_usage_logs
                  WHERE created_at >= NOW() - make_interval(days => $2::int)
                  AND user_id = $1
                  GROUP BY provider, model`;
    const result = await getPool().query(query, [userId, days]);
    return result.rows;
  }

  async getEmbeddingCostAndTokens(days) {
    const query = `SELECT
                    model,
                    SUM(total_tokens) AS totaltokens,
                    SUM(estimated_cost) AS totalcost
                  FROM embedding_costs
                  WHERE processed_at >= NOW() - make_interval(days => $1::int)
                  GROUP BY model`;
    const result = await getPool().query(query, [days]);
    return result.rows;
  }

  async getConversationSessions(days, userId) {
    const query = `SELECT gs.day::date AS day,
                    COUNT(DISTINCT c.conversation_id) AS totalsessions
                  FROM generate_series(
                    (CURRENT_DATE - ($2::int - 1))::timestamp,
                    CURRENT_DATE::timestamp,
                    '1 day'
                  ) AS gs(day)
                  LEFT JOIN conversations c
                    ON c.user_id = $1
                   AND c.created_at >= gs.day
                   AND c.created_at < gs.day + INTERVAL '1 day'
                  GROUP BY gs.day
                  ORDER BY gs.day ASC`;
    const result = await getPool().query(query, [userId, days]);
    return result.rows;
  }

  async getEmails(days, userId) {
    return this.countDocumentsByDay(days, userId, "gmail");
  }

  async getCalendarEvents(days, userId) {
    return this.countDocumentsByDay(days, userId, "calendar");
  }

  async countDocumentsByDay(days, userId, source) {
    const query = `SELECT gs.day::date AS day,
                    COUNT(d.id) AS count
                  FROM generate_series(
                    (CURRENT_DATE - ($3::int - 1))::timestamp,
                    CURRENT_DATE::timestamp,
                    '1 day'
                  ) AS gs(day)
                  LEFT JOIN documents d
                    ON d.user_id = $1
                   AND d.source = $2
                   AND d.created_at >= gs.day
                   AND d.created_at < gs.day + INTERVAL '1 day'
                  GROUP BY gs.day
                  ORDER BY gs.day ASC`;
    const result = await getPool().query(query, [userId, source, days]);
    return result.rows;
  }

  async countUnreadEmails(userId) {
    const query = `SELECT COUNT(*)::int AS count
                  FROM documents
                  WHERE user_id = $1
                    AND source = 'gmail'
                    AND COALESCE(metadata#>>'{gmail,labelIds}', '') LIKE '%UNREAD%'`;
    const result = await getPool().query(query, [userId]);
    return result.rows[0]?.count ?? 0;
  }

  async countMeetingsToday(userId) {
    const query = `SELECT COUNT(*)::int AS count
                  FROM documents
                  WHERE user_id = $1
                    AND source = 'calendar'
                    AND timestamp >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
                    AND timestamp < (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day') AT TIME ZONE 'Asia/Kolkata'`;
    const result = await getPool().query(query, [userId]);
    return result.rows[0]?.count ?? 0;
  }

  async listUpcomingEvents(userId, limit) {
    const query = `SELECT title, timestamp, metadata
                  FROM documents
                  WHERE user_id = $1
                    AND source = 'calendar'
                    AND timestamp >= NOW()
                  ORDER BY timestamp ASC
                  LIMIT $2`;
    const result = await getPool().query(query, [userId, limit]);
    return result.rows;
  }

  async getLLMCredsUsage() {
    const query = `SELECT
                    provider,
                    SUM(input_cost + output_cost) AS totalcost
                  FROM llm_usage_logs
                  WHERE created_at >= date_trunc('month', CURRENT_DATE)
                  GROUP BY provider`;
    const result = await getPool().query(query);
    return result.rows;
  }
}
