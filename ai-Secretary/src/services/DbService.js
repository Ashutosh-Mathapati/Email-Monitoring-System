const pool = require("../db");

class DbService {
    async saveUser(email, startDate) {
        await pool.query(
            `INSERT INTO users (email, tracking_start_date)
             VALUES ($1, $2)
             ON CONFLICT (email)
             DO UPDATE SET tracking_start_date = EXCLUDED.tracking_start_date`,
            [email, startDate]
        );
    }

    async saveTask(emailId, subject, summary, taskData, senderEmail, receivedAt) {
        const query = `
            INSERT INTO tasks (
                email_id, subject, summary, action_item, priority,
                duration_minutes, sender_email, received_at, confidence,
                date_type, suggested_time, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Awaiting Approval')
            ON CONFLICT (email_id, action_item) DO NOTHING
            RETURNING *;
        `;
        
        const values = [
            emailId,
            subject,
            summary,
            taskData.action_item || taskData.title,
            taskData.priority || 'Medium',
            taskData.duration || 30,
            senderEmail,
            receivedAt,
            taskData.confidence || 'HIGH',
            taskData.date_type || 'none',
            taskData.suggested_time || null
        ];

        try {
            const res = await pool.query(query, values);
            return res.rows[0];
        } catch (err) {
            console.error("Supabase Save Error:", err.message);
            return null;
        }
    }

    async ensureSchema() {
        const queries = [
            "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS date_type TEXT",
            "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggested_time TIMESTAMP",
            "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS confidence TEXT",
            "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_order INTEGER DEFAULT 0"
        ];

        for (const q of queries) {
            await pool.query(q);
        }
    }

    async updateScheduledTask(taskId, eventId, start, end) {
        await pool.query(
            "UPDATE tasks SET outlook_event_id = $1, start_time = $2, end_time = $3, status = 'Scheduled' WHERE id = $4",
            [eventId, start, end, taskId]
        );
    }

    async getDashboardCards(userEmail) {
        if (!userEmail) return [];

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
                        'date_type', t.date_type,
                        'suggested_time', t.suggested_time,
                        'order', t.task_order,
                        'status', t.status
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
        try {
            const res = await pool.query(
                "SELECT id FROM tasks WHERE email_id = $1 LIMIT 1",
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

    async getFinishedTasks() {
    const query = `
        SELECT * FROM tasks 
        WHERE status = 'Scheduled' 
        -- This tells Supabase: "Compare end_time against the current time in India"
        AND end_time < (NOW() AT TIME ZONE 'Asia/Kolkata') 
        AND sender_email IS NOT NULL;
    `;
    const res = await pool.query(query);
    return res.rows;
}
}

module.exports = new DbService();
