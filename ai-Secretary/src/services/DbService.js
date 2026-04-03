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
        INSERT INTO tasks (email_id, subject, summary, action_item, priority, duration_minutes, sender_email, received_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Awaiting Approval')
        ON CONFLICT (email_id, action_item) DO NOTHING
        RETURNING *;
    `;
    const values = [
        emailId,
        subject,
        summary,
        taskData.action_item,
        taskData.priority,
        taskData.duration || 30,
        senderEmail,
        receivedAt
    ];
    const res = await pool.query(query, values);
    return res.rows[0];
}


    async updateScheduledTask(taskId, eventId, start, end) {
        await pool.query(
            "UPDATE tasks SET outlook_event_id = $1, start_time = $2, end_time = $3, status = 'Scheduled' WHERE id = $4",
            [eventId, start, end, taskId]
        );
    }

    async getDashboardCards(userEmail) {
        // If no email is provided, return empty array instead of crashing
        if (!userEmail) return [];
        
        const emailToUse = String(userEmail).toLowerCase();
        
        const query = `
            SELECT 
                t.email_id, t.subject, t.sender_email,
                (ARRAY_AGG(t.summary))[1] as email_summary,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'id', t.id, 'action_item', t.action_item, 'priority', t.priority, 
                        'order', t.task_order, 'status', t.status
                    ) ORDER BY t.task_order ASC
                ) as tasks
            FROM tasks t
            JOIN users u ON u.email = $1
            WHERE t.status != 'Completed'
            -- VISIBILITY GATE: Only show tasks where the email arrived AFTER signup time
            AND t.received_at >= u.tracking_start_date
            GROUP BY t.email_id, t.subject, t.sender_email
            ORDER BY MIN(t.created_at) DESC;
        `;
        const res = await pool.query(query, [emailToUse]);
        return res.rows;
    }
    async getTaskById(taskId) {
        const res = await pool.query(
            "SELECT * FROM tasks WHERE id = $1",
            [taskId]
        );
        return res.rows[0];
    }

    async getFinishedTasks() {
        const res = await pool.query(`
            SELECT *
            FROM tasks
            WHERE status = 'Scheduled'
              AND end_time < NOW()
              AND sender_email IS NOT NULL;
        `);
        return res.rows;
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

    // Add this new function to your DbService class
async updateTaskData(id, order, priority) {
    await pool.query(
        "UPDATE tasks SET task_order = $1, priority = $2 WHERE id = $3",
        [order, priority, id]
    );
}

// Clean up: Ensure getFinishedTasks handles your local time correctly
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
