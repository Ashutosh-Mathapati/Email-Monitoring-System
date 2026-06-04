const pool = require("../db");

class DbService {
    constructor() {
        this.schemaReady = false;
    }

    async ensureSchema() {
        if (this.schemaReady) return;

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                tracking_start_date TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
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
                start_time TIMESTAMP,
                end_time TIMESTAMP,
                outlook_event_id TEXT,
                suggested_time TIMESTAMP,
                confidence TEXT DEFAULT 'HIGH',
                received_at TIMESTAMP,
                task_description TEXT,
                intent TEXT,
                participants JSONB DEFAULT '[]'::jsonb,
                duplicate_detected BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_task_per_email UNIQUE (email_id, action_item)
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS processed_emails (
                email_id TEXT PRIMARY KEY,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sender_email TEXT");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggested_time TIMESTAMP");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'HIGH'");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS received_at TIMESTAMP");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_description TEXT");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_order INTEGER DEFAULT 0");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 30");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outlook_event_id TEXT");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_time TIMESTAMP");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS end_time TIMESTAMP");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS intent TEXT");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS participants JSONB DEFAULT '[]'::jsonb");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duplicate_detected BOOLEAN DEFAULT FALSE");

        this.schemaReady = true;
    }

    async saveUser(email, startDate) {
        await pool.query(
            `INSERT INTO users (email, tracking_start_date)
             VALUES ($1, $2)
             ON CONFLICT (email)
             DO UPDATE SET tracking_start_date = EXCLUDED.tracking_start_date`,
            [email, startDate]
        );
    }

    cleanSubject(subject) {
        if (!subject) return "";
        return subject
            .replace(/^(fw|re|fwd|aw|wg|reply|forward):\s*/i, "")
            .replace(/\s*-\s*sending again\s*$/i, "")
            .trim();
    }

    normalizeForDuplicate(text) {
        return (text || "")
            .toString()
            .toLowerCase()
            .replace(/^(fw|re|fwd|reply|forward):\s*/i, "")
            .replace(/\b(the|a|an|please|can you|kindly)\b/g, " ")
            .replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/g, " ")
            .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(st|nd|rd|th)?\b/g, " ")
            .replace(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|coming)\b/g, " ")
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    duplicateScore(a, b) {
        const wordsA = new Set(this.normalizeForDuplicate(a).split(" ").filter(word => word.length > 2));
        const wordsB = new Set(this.normalizeForDuplicate(b).split(" ").filter(word => word.length > 2));
        if (!wordsA.size || !wordsB.size) return 0;

        let overlap = 0;
        for (const word of wordsA) {
            if (wordsB.has(word)) overlap++;
        }
        return overlap / Math.max(wordsA.size, wordsB.size);
    }

    async findDuplicateTask(senderEmail, subject, actionItem, emailId) {
        if (!senderEmail) return null;
        
        const targetCleaned = this.cleanSubject(subject).toLowerCase();
        const targetAction = (actionItem || "").trim().toLowerCase();
        
        // Only match tasks from the same email_id — different emails with same content
        // should each get their own tasks.
        const res = await pool.query(
            "SELECT * FROM tasks WHERE LOWER(sender_email) = LOWER($1) AND email_id = $2",
            [senderEmail.toLowerCase(), emailId]
        );
        
        for (const row of res.rows) {
            const rowCleaned = this.cleanSubject(row.subject).toLowerCase();
            if (rowCleaned === targetCleaned && row.action_item.trim().toLowerCase() === targetAction) {
                return row;
            }

            const subjectScore = this.duplicateScore(rowCleaned, targetCleaned);
            const actionScore = this.duplicateScore(row.action_item, targetAction);
            if (actionScore >= 0.82 || (subjectScore >= 0.75 && actionScore >= 0.55)) {
                return row;
            }
        }
        return null;
    }

    async saveTask(emailId, subject, summary, taskData, senderEmail, receivedAt, taskIndex = 0, customStatus = null) {
        await this.ensureSchema();

        // 1. DUPLICATE TASK DETECTION (scoped to same email_id)
        const duplicateTask = await this.findDuplicateTask(senderEmail, subject, taskData.action_item, emailId);
        if (duplicateTask) {
            console.log(`[DUPLICATE DETECTED] Cleaned match found for: "${taskData.action_item}". Updating existing task ID: ${duplicateTask.id}`);
            
            const updateQuery = `
                UPDATE tasks 
                SET email_id = $1, 
                    subject = $2, 
                    summary = $3, 
                    received_at = $4, 
                    suggested_time = COALESCE($5, suggested_time),
                    task_description = $6,
                    duplicate_detected = TRUE
                WHERE id = $7
                RETURNING *;
            `;
            const res = await pool.query(updateQuery, [
                emailId,
                subject,
                summary,
                receivedAt,
                taskData.suggested_time || null,
                taskData.description || taskData.task_description || '',
                duplicateTask.id
            ]);
            return res.rows[0];
        }

        const status = customStatus || taskData.status || 'Awaiting Approval';

        const query = `
            INSERT INTO tasks (
                email_id, subject, summary, action_item, priority, 
                duration_minutes, sender_email, received_at, confidence, status, suggested_time, 
                task_description, task_order, intent, participants
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $15, $10, $11, $12, $13, $14)
            ON CONFLICT (email_id, action_item) DO NOTHING
            RETURNING *;
        `;
        
        // Ensure we extract confidence, duration, and suggested_time from the taskData object
        const values = [
            emailId, 
            subject, 
            summary, 
            taskData.action_item, 
            taskData.priority || 'Medium', 
            taskData.duration || 30, 
            senderEmail, 
            receivedAt,
            taskData.confidence || 'HIGH', // Fallback to HIGH if AI misses it
            taskData.suggested_time || null, // Store the AI-extracted date/time
            taskData.description || taskData.task_description || '', // Task-specific summary
            taskIndex, // Order of task within the email
            taskData.intent || 'schedule',
            JSON.stringify(Array.isArray(taskData.participants) ? taskData.participants : []),
            status
        ];

        const res = await pool.query(query, values);
        return res.rows[0];
    }

    async markEmailAsSeen(emailId) {
        await this.ensureSchema();
        await pool.query(
            "INSERT INTO processed_emails (email_id) VALUES ($1) ON CONFLICT (email_id) DO NOTHING",
            [emailId]
        );
    }


    async updateScheduledTask(taskId, eventId, start, end) {
        await pool.query(
            "UPDATE tasks SET outlook_event_id = $1, start_time = $2, end_time = $3, status = 'Scheduled' WHERE id = $4",
            [eventId, start, end, taskId]
        );
    }

    async updateTaskScheduleTimes(taskId, start, end) {
        await pool.query(
            "UPDATE tasks SET start_time = $1, end_time = $2, status = 'Scheduled' WHERE id = $3",
            [start, end, taskId]
        );
    }

    async getTaskByOutlookEventId(eventId) {
        if (!eventId) return null;

        const res = await pool.query(
            "SELECT * FROM tasks WHERE outlook_event_id = $1 LIMIT 1",
            [eventId]
        );
        return res.rows[0] || null;
    }

    async getDashboardCards(userEmail) {
        if (!userEmail) return [];
        await this.ensureSchema();

        const query = `
            SELECT 
                t.email_id, 
                t.subject, 
                t.sender_email,
                MIN(t.received_at) as received_at,
                COUNT(t.id) as task_count,
                COUNT(t.id) FILTER (WHERE t.priority = 'High') as high_priority_count,
                COUNT(t.id) FILTER (WHERE t.status = 'Scheduled') as scheduled_count,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'id', t.id,
                        'action_item', t.action_item,
                        'priority', t.priority,
                        'confidence', t.confidence,
                        'order', t.task_order,
                        'status', t.status,
                        'description', t.task_description,
                        'suggested_time', t.suggested_time,
                        'intent', t.intent,
                        'duplicate_detected', t.duplicate_detected,
                        'participants', COALESCE(t.participants, '[]'::jsonb)
                    ) ORDER BY t.task_order ASC, t.id ASC
                ) as tasks
            FROM tasks t
            JOIN users u ON LOWER(u.email) = LOWER($1)
            WHERE t.status != 'Completed'
            AND t.received_at >= u.tracking_start_date
            GROUP BY t.email_id, t.subject, t.sender_email
            ORDER BY MIN(t.created_at) DESC;
        `;

        try {
            const res = await pool.query(query, [userEmail.toLowerCase()]);
            return res.rows;
        } catch (err) {
            console.error("Database Error:", err.message);
            return [];
        }
    }
    async getTaskById(taskId) {
        await this.ensureSchema();
        const res = await pool.query(
            "SELECT * FROM tasks WHERE id = $1",
            [taskId]
        );
        return res.rows[0];
    }

    async markTaskCompleted(taskId) {
        await pool.query(
            "UPDATE tasks SET status = 'Completed' WHERE id = $1",
            [taskId]
        );
    }

    async markTaskAsCompleted(taskId) {
        await this.markTaskCompleted(taskId);
    }

    async isEmailProcessed(emailId) {
        await this.ensureSchema();
        try {
            const res = await pool.query(
                `SELECT email_id FROM processed_emails WHERE email_id = $1
                 UNION
                 SELECT email_id FROM tasks WHERE email_id = $1
                 LIMIT 1`,
                [emailId]
            );
            return res.rows.length > 0;
        } catch (err) {
            console.error("DB Lookup Error:", err.message);
            return false;
        }
    }

    async getEmailProcessingState(emailId) {
        await this.ensureSchema();
        try {
            const res = await pool.query(
                `SELECT
                    EXISTS(SELECT 1 FROM processed_emails WHERE email_id = $1) AS seen,
                    EXISTS(SELECT 1 FROM tasks WHERE email_id = $1) AS has_tasks,
                    (SELECT COUNT(*)::int FROM tasks WHERE email_id = $1) AS task_count`,
                [emailId]
            );
            return res.rows[0] || { seen: false, has_tasks: false, task_count: 0 };
        } catch (err) {
            console.error("DB Processing State Error:", err.message);
            return { seen: false, has_tasks: false, task_count: 0 };
        }
    }

    async updateTaskData(id, order, priority) {
        await pool.query(
            "UPDATE tasks SET task_order = $1, priority = $2 WHERE id = $3",
            [order, priority, id]
        );
    }

    async deleteTasksForEmail(emailId) {
        await this.ensureSchema();
        await pool.query("DELETE FROM tasks WHERE email_id = $1", [emailId]);
    }

    async updateTaskSuggestedTime(taskId, newTime) {
        const res = await pool.query(
            "UPDATE tasks SET suggested_time = $1 WHERE id = $2 RETURNING *",
            [newTime, taskId]
        );
        return res.rows[0];
    }

    async getFinishedTasks() {
        await this.ensureSchema();
        const res = await pool.query(`
            SELECT * FROM tasks
            WHERE status = 'Scheduled'
              AND end_time < NOW() -- Compares against server local time
              AND sender_email IS NOT NULL;
        `);
        return res.rows;
    }
}

module.exports = new DbService();
