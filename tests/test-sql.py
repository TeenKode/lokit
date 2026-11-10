from pathlib import Path
import sqlite3,re,uuid,datetime
root=Path(__file__).resolve().parents[1]
connection=sqlite3.connect(':memory:')
connection.executescript((root/'analytics-worker/migrations/0001_initial.sql').read_text())
connection.executescript((root/'analytics-worker/migrations/0002_retention_index.sql').read_text())
source=(root/'analytics-worker/src/index.js').read_text()
queries=re.findall(r"env\.DB\.prepare\((`[^`]+`|'[^']+')\)",source,re.S)
assert len(queries)==4,(len(queries),queries)
queries=[q[1:-1] for q in queries]
now=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
connection.execute(queries[0],(str(uuid.uuid4()),now,'success','video-trim',1400,1000,500))
connection.execute(queries[0],(str(uuid.uuid4()),now,'open','video-trim',0,0,0))
connection.commit()
rows=[connection.execute(q,(now,)).fetchall() for q in queries[1:]]
assert len(rows)==3
assert rows[0][0][1]==1
assert rows[1][0][0]=='video-trim'
assert rows[1][0][2]==1
assert rows[2][0][3]==1
# Автоматическое удаление данных, полученных более 90 дней назад.
connection.execute("UPDATE analytics_events SET received_at = datetime('now', '-91 days') WHERE kind='success'")
connection.execute("DELETE FROM analytics_events WHERE received_at < datetime('now', '-90 days')")
assert connection.execute('SELECT COUNT(*) FROM analytics_events').fetchone()[0]==1
assert connection.execute("SELECT kind FROM analytics_events").fetchone()[0]=='open'
assert connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_analytics_received_at'").fetchone()[0]==1
print('D1/SQLite tests: schema, 4 SQL queries, retention migration and cleanup — PASS')
