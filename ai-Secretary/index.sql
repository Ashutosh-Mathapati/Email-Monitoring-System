CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    tracking_start_date TIMESTAMPTZ NOT NULL
);

CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    email_id TEXT UNIQUE,
    subject TEXT,
    summary TEXT,
    action_item TEXT,
    priority TEXT,
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'Pending',
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    outlook_event_id TEXT,
    date_type TEXT,
    suggested_time TIMESTAMP,
    confidence TEXT,
    task_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE tasks ADD COLUMN sender_email TEXT;
DELETE FROM tasks WHERE subject = 'Client strategy call';
DELETE FROM tasks WHERE subject = 'Project survey';
DELETE FROM tasks;
SELECT * FROM tasks;
DELETE FROM tasks WHERE action_item LIKE '%Verification%';
-- 1. Add sender_email if you haven't yet
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sender_email TEXT;

-- 2. Ensure status can be 'Completed'
-- No change needed, we use the existing 'status' column.
SELECT id, action_item, status, sender_email, end_time FROM tasks;
UPDATE tasks SET end_time = NOW() - INTERVAL '10 minutes' WHERE id = 33;


-- Remove the old unique constraint
ALTER TABLE tasks DROP CONSTRAINT tasks_email_id_key;

-- Add a new column to distinguish tasks from the same email
ALTER TABLE tasks ADD COLUMN task_index INTEGER DEFAULT 0;

-- Optional: Create a unique constraint on the combination of email + index
ALTER TABLE tasks ADD UNIQUE (email_id, action_item);

-- 1. Create a unique constraint on the combination of Email ID and the Action Item
ALTER TABLE tasks ADD CONSTRAINT unique_task_per_email UNIQUE (email_id, action_item);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
