const express = require("express");
const router = express.Router();
const dbService = require("../services/DbService");
const calendarService = require("../services/CalendarService");
const tokenManager = require("../TokenManager");
const pool = require("../db");

function isMeetingSchedulingTask(task) {
    const intent = String(task?.intent || "").toLowerCase();
    return intent === "schedule" || intent === "reschedule" || intent === "cancel";
}

// Get dashboard cards for the current logged-in executive
router.get("/dashboard", async (req, res) => {
    try {
        const email = tokenManager.currentEmail;
        if (!email) {
            console.log("[Router Dashboard] No active executive email found, returning empty list.");
            return res.json([]);
        }
        const data = await dbService.getDashboardCards(email);
        res.json(data);
    } catch (err) {
        console.error("Dashboard Router Error:", err.message);
        res.status(500).json({ error: "Unable to load dashboard cards." });
    }
});

// Get detailed task by ID
router.get("/:id", async (req, res) => {
    try {
        const task = await dbService.getTaskById(req.params.id);
        if (!task) {
            return res.status(404).json({ error: "Task not found" });
        }
        res.json({
            id: task.id,
            action_item: task.action_item,
            suggested_time: task.suggested_time,
            status: task.status,
            confidence: task.confidence,
            intent: task.intent,
            participants: task.participants || [],
            sender_email: task.sender_email,
            received_at: task.received_at
        });
    } catch (err) {
        console.error("Task fetch error:", err.message);
        res.status(500).json({ error: "Failed to fetch task" });
    }
});

// Approve and schedule task with Requirement 8 Stacking & Dependent adjustment
router.post("/approve/:id", async (req, res) => {
    try {
        const task = await dbService.getTaskById(req.params.id);

        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
        }

        if (!isMeetingSchedulingTask(task)) {
            return res.status(400).json({
                success: false,
                error: "Scheduling is only available for meeting-intent tasks."
            });
        }

        // Stacking Logic (Requirement 8): Move after the end of the last scheduled task of this email
        const lastTaskRes = await pool.query(
            "SELECT end_time FROM tasks WHERE email_id = $1 AND status = 'Scheduled' ORDER BY end_time DESC LIMIT 1",
            [task.email_id]
        );

        if (lastTaskRes.rows.length > 0) {
            task.suggested_time = lastTaskRes.rows[0].end_time;
            console.log(`[ROUTE REQ 8] Stacking after previous task: ${task.suggested_time}`);
        }

        const schedule = await calendarService.scheduleTask(task);

        if (!schedule) {
            return res.status(500).json({ success: false, error: "Unable to schedule task." });
        }

        await dbService.updateScheduledTask(task.id, schedule.eventId, schedule.start, schedule.end);
        res.json({ success: true });
    } catch (err) {
        console.error("Approve Error:", err.message);
        res.status(500).json({ success: false, error: "Approval failed." });
    }
});

// Reschedule task
router.post("/reschedule/:id", async (req, res) => {
    try {
        const { newTime } = req.body; // Expected format: "2026-05-01T11:00:00"
        const task = await dbService.getTaskById(req.params.id);

        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
        }

        if (!isMeetingSchedulingTask(task)) {
            return res.status(400).json({
                success: false,
                error: "Rescheduling is only available for meeting-intent tasks."
            });
        }

        if (!newTime) {
            return res.status(400).json({ success: false, error: "New time required" });
        }

        // Update suggested time in database
        await dbService.updateTaskSuggestedTime(req.params.id, newTime);
        
        // If already scheduled, reschedule in calendar
        if (task.status === 'Scheduled' && task.outlook_event_id) {
            const schedule = await calendarService.updateCalendarEvent(task, newTime);
            
            if (schedule) {
                await dbService.updateScheduledTask(req.params.id, schedule.eventId, schedule.start, schedule.end);
                res.json({ success: true, message: `Task rescheduled to ${newTime}` });
            } else {
                res.status(500).json({ success: false, error: "Failed to reschedule in calendar" });
            }
        } else {
            res.json({ success: true, message: `Time updated to ${newTime}. Will be scheduled when approved.` });
        }
    } catch (err) {
        console.error("Reschedule Error:", err.message);
        res.status(500).json({ success: false, error: "Reschedule failed." });
    }
});

// Cancel a scheduled meeting: delete Outlook event + mark task as Cancelled
router.post("/cancel/:id", async (req, res) => {
    try {
        const task = await dbService.getTaskById(req.params.id);
        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
        }

        const result = await calendarService.cancelMeeting(task);
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error || "Failed to cancel meeting." });
        }

        await pool.query(
            "UPDATE tasks SET status = 'Cancelled', outlook_event_id = NULL WHERE id = $1",
            [req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Cancel Error:", err.message);
        res.status(500).json({ success: false, error: "Cancel failed." });
    }
});

// Modify task details (Title, Description, Priority, Confidence, Order)
router.post("/edit/:id", async (req, res) => {
    try {
        const { action_item, description, priority, confidence, task_order } = req.body;
        await pool.query(
            `UPDATE tasks 
             SET action_item = COALESCE($1, action_item), 
                 task_description = COALESCE($2, task_description), 
                 priority = COALESCE($3, priority),
                 confidence = COALESCE($4, confidence),
                 task_order = COALESCE($5, task_order)
             WHERE id = $6`,
            [action_item, description, priority, confidence, task_order, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Edit Task Error:", err.message);
        res.status(500).json({ error: "Failed to edit task" });
    }
});

module.exports = router;
