CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('view','open','success','error','cancelled')),
  tool TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_day ON analytics_events(day);
CREATE INDEX IF NOT EXISTS idx_analytics_tool ON analytics_events(tool,day);
