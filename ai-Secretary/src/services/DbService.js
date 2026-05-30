const pool = require("../db");

class DbService {
    constructor() {
        this.schemaReady = false;
    }

    async ensureSchema() {
        if (this.schemaReady) return;

        await pool.query(`
            CREATE TABLE IF NOT EXISTS processed_emails (
                email_id TEXT PRIMARY KEY,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS intent TEXT");
        await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS participants JSONB DEFAULT '[]'::jsonb");

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

    async saveTask(emailId, subject, summary, taskData, senderEmail, receivedAt, taskIndex = 0) {
        await this.ensureSchema();

        const query = `
            INSERT INTO tasks (
                email_id, subject, summary, action_item, priority, 
                duration_minutes, sender_email, received_at, confidence, status, suggested_time, 
                task_description, task_order, intent, participants
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Awaiting Approval', $10, $11, $12, $13, $14)
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
            JSON.stringify(Array.isArray(taskData.participants) ? taskData.participants : [])
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

    async updateTaskData(id, order, priority) {
        await pool.query(
            "UPDATE tasks SET task_order = $1, priority = $2 WHERE id = $3",
            [order, priority, id]
        );
    }

    async updateTaskSuggestedTime(taskId, newTime) {
        const res = await pool.query(
            "UPDATE tasks SET suggested_time = $1 WHERE id = $2 RETURNING *",
            [newTime, taskId]
        );
        return res.rows[0];
    }

    async getFinishedTasks() {
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
