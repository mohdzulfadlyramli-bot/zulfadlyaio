CREATE TABLE playback_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  session_key TEXT NOT NULL,
  profile_id TEXT,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start', 'progress', 'stop')),
  report TEXT NOT NULL,
  due INTEGER NOT NULL
);
CREATE INDEX playback_reports_session ON playback_reports(scope, session_key, id);
CREATE INDEX playback_reports_due ON playback_reports(due, scope);
