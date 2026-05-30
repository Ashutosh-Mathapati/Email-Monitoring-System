const express = require("express");
const router = express.Router();
const dbService = require("../services/DbService");
const calendarService = require("../services/CalendarService");

router.get("/dashboard", async (req, res) => {
    try {
        const data = await dbService.getDashboardCards();
        res.json(data);
    } catch (err) {
        console.error("Dashboard Error:", err.message);
        res.status(500).json({ error: "Unable to load dashboard cards." });
    }
});

// NEW: Get task details including extracted time
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

router.post("/approve/:id", async (req, res) => {
    try {
        const task = await dbService.getTaskById(req.params.id);

        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
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

// NEW: Correct the suggested time before scheduling
router.post("/correct-time/:id", async (req, res) => {
    try {
        const { newTime } = req.body; // Expected format: "2026-05-01T11:00:00"
        const task = await dbService.getTaskById(req.params.id);

        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
        }

        if (!newTime) {
            return res.status(400).json({ success: false, error: "New time required in format: YYYY-MM-DDTHH:mm:ss" });
        }

        // Update the task's suggested_time in the database
        await dbService.updateTaskSuggestedTime(req.params.id, newTime);
        
        res.json({ success: true, message: `Time corrected to ${newTime}` });
    } catch (err) {
        console.error("Time Correction Error:", err.message);
        res.status(500).json({ success: false, error: "Time correction failed." });
    }
});

// NEW: Reschedule an already-scheduled task with new time
router.post("/reschedule/:id", async (req, res) => {
    try {
        const { newTime } = req.body; // Expected format: "2026-05-01T11:00:00"
        const task = await dbService.getTaskById(req.params.id);

        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
        }

        if (!newTime) {
            return res.status(400).json({ success: false, error: "New time required" });
        }

        // Update suggested time
        await dbService.updateTaskSuggestedTime(req.params.id, newTime);
        
        // If already scheduled, reschedule it
        if (task.status === 'Scheduled' && task.outlook_event_id) {
            // Parse new time as IST and convert to UTC for scheduling
            task.suggested_time = newTime;
            const schedule = await calendarService.scheduleTask(task);
            
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

module.exports = router;
