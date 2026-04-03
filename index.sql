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


-- 1. Create the Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    tracking_start_date TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Add 'task_order' to the existing tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_order INTEGER DEFAULT 0;

-- 3. Ensure tasks have a 'sender_email' for the notification agent
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sender_email TEXT;




-- 1. Create Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    tracking_start_date TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Clean and Reset Tasks Table
DROP TABLE IF EXISTS tasks; -- Be careful: this deletes old test data
CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    email_id TEXT NOT NULL,
    subject TEXT,
    summary TEXT,
    action_item TEXT,
    priority TEXT,
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'Awaiting Approval', -- Important for Dashboard
    task_order INTEGER DEFAULT 0,
    sender_email TEXT,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    outlook_event_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_task_per_email UNIQUE (email_id, action_item)
);

DELETE FROM users; DELETE FROM tasks;

-- 1. Clear all previous task data
DELETE FROM tasks;

-- 2. Clear all previous user/signup data
DELETE FROM users;

-- 3. Reset the "Settings" (The Delta Link bookmark) 
-- This forces the Agent to actually "look" at your inbox fresh
DELETE FROM settings WHERE key = 'last_delta_link';


DELETE FROM tasks;
DELETE FROM users;
DELETE FROM settings;

UPDATE tasks SET end_time = NOW() - INTERVAL '1 minute' WHERE id = 39;