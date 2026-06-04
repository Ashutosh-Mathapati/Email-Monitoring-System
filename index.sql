CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    tracking_start_date TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    email_id TEXT NOT NULL,
    subject TEXT,
    summary TEXT,
    action_item TEXT NOT NULL,
    priority TEXT DEFAULT 'Medium',
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'Awaiting Approval',
    task_order INTEGER DEFAULT 0,
    sender_email TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    outlook_event_id TEXT,
    suggested_time TIMESTAMPTZ,
    confidence TEXT DEFAULT 'HIGH',
    received_at TIMESTAMPTZ,
    task_description TEXT,
    intent TEXT,
    participants JSONB DEFAULT '[]'::jsonb,
    duplicate_detected BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_task_per_email UNIQUE (email_id, action_item)
);

CREATE TABLE IF NOT EXISTS processed_emails (
    email_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sender_email TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggested_time TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'HIGH';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_description TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_order INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS intent TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS participants JSONB DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duplicate_detected BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tasks_email_id ON tasks(email_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sender_email ON tasks(LOWER(sender_email));
CREATE INDEX IF NOT EXISTS idx_tasks_status_end_time ON tasks(status, end_time);
CREATE INDEX IF NOT EXISTS idx_tasks_received_at ON tasks(received_at);
